// ─── Nitrado FTP Access ─────────────────────────────────────────────────────
// Read-mostly access to the DayZ game server's files (admin logs, ban list,
// config) over FTP/FTPS. Every operation opens a fresh connection and closes
// it — this is an admin dashboard hitting it occasionally, not a hot path.

const ftp = require('basic-ftp');
const { Writable, Readable } = require('stream');

const FTP_HOST   = process.env.FTP_HOST   ?? null;
const FTP_USER   = process.env.FTP_USER   ?? null;
const FTP_PASS   = process.env.FTP_PASS   ?? null;
const FTP_PORT   = parseInt(process.env.FTP_PORT ?? '21', 10);
// Nitrado FTP is explicit-TLS (FTPS) by default. Set FTP_SECURE=false to opt out.
const FTP_SECURE = process.env.FTP_SECURE !== 'false';

function isConfigured() {
  return !!(FTP_HOST && FTP_USER && FTP_PASS);
}

async function withClient(fn) {
  if (!isConfigured()) throw new Error('FTP is not configured (missing FTP_HOST/FTP_USER/FTP_PASS).');
  const client = new ftp.Client(15000); // 15s timeout
  client.ftp.verbose = false;
  try {
    await client.access({ host: FTP_HOST, port: FTP_PORT, user: FTP_USER, password: FTP_PASS, secure: FTP_SECURE });
    return await fn(client);
  } finally {
    client.close();
  }
}

function collector() {
  const chunks = [];
  const writable = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
  });
  return { writable, buffer: () => Buffer.concat(chunks) };
}

// ─── Directory listing ──────────────────────────────────────────────────────

async function listDir(path = '/') {
  return withClient(async (client) => {
    const entries = await client.list(path);
    return entries
      .map(e => ({
        name: e.name,
        isDirectory: e.isDirectory,
        size: e.size,
        modifiedAt: e.rawModifiedAt || null,
      }))
      .sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
  });
}

// ─── Reading files ───────────────────────────────────────────────────────────

// Reads up to maxBytes from the START of a file — for configs/ban lists.
async function readTextFull(path, maxBytes = 500_000) {
  return withClient(async (client) => {
    const { writable, buffer } = collector();
    await client.downloadTo(writable, path);
    const buf = buffer();
    const truncated = buf.length > maxBytes;
    return { text: buf.subarray(0, maxBytes).toString('utf8'), truncated };
  });
}

// Reads up to maxBytes from the END of a file — for large/growing log files.
async function readTextTail(path, maxBytes = 200_000) {
  return withClient(async (client) => {
    const size = await client.size(path);
    const startAt = Math.max(0, size - maxBytes);
    const { writable, buffer } = collector();
    await client.downloadTo(writable, path, startAt);
    let text = buffer().toString('utf8');
    // If we started mid-file, drop the first (likely partial) line.
    if (startAt > 0) {
      const nl = text.indexOf('\n');
      if (nl !== -1) text = text.slice(nl + 1);
    }
    return { text, totalSize: size, truncatedStart: startAt > 0 };
  });
}

// Reads from an exact byte offset to the end — for the economy/killfeed poller,
// which needs to pick up exactly where it left off last time (no re-processing,
// no gaps). Unlike readTextTail this never trims a leading partial line, since
// the caller is expected to pass an offset that was itself a clean line boundary.
async function readFrom(path, startByte) {
  return withClient(async (client) => {
    const size = await client.size(path);
    if (startByte >= size) return { text: '', newOffset: size };
    const { writable, buffer } = collector();
    await client.downloadTo(writable, path, startByte);
    return { text: buffer().toString('utf8'), newOffset: size };
  });
}

async function writeText(path, content) {
  return withClient(async (client) => {
    await client.uploadFrom(Readable.from(Buffer.from(content, 'utf8')), path);
  });
}

async function getFileSize(path) {
  return withClient(client => client.size(path));
}

// ─── ADM log discovery & parsing ────────────────────────────────────────────
// DayZ writes rolling AdminLog files (*.ADM) into the server's profiles
// folder — one per server run, newest by modified time is the active one.

async function findLatestAdmLog(profilesPath) {
  const entries = await listDir(profilesPath);
  const admFiles = entries.filter(e => !e.isDirectory && /\.adm$/i.test(e.name));
  if (admFiles.length === 0) return null;
  // rawModifiedAt isn't always reliable across FTP servers — fall back to name sort
  // (DayZ ADM filenames are not chronologically named, so prefer server-reported mtime when present).
  const withDates = admFiles.filter(e => e.modifiedAt);
  const pick = withDates.length > 0
    ? withDates.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt))[0]
    : admFiles[admFiles.length - 1];
  return profilesPath.replace(/\/$/, '') + '/' + pick.name;
}

const ADM_PATTERNS = [
  { type: 'connect',    re: /Player "([^"]+)"[^)]*\) is connected/i },
  { type: 'disconnect', re: /Player "([^"]+)"[^)]*\) has been disconnected/i },
  { type: 'death',      re: /Player "([^"]+)"\s*\(DEAD\)/i },
  { type: 'hit',        re: /hit by Player "([^"]+)".*?into ([\w\s]+?)\(?\d*\)?\s+for ([\d.]+) damage/i },
  { type: 'chat',       re: /"([^"]+)" \(.*?\): (.+)$/i },
];

// Dedicated PvP-fatal-kill extractor (for economy crediting + killfeed posting,
// and to tag these lines distinctly in the Activity Log) — needs both names
// plus weapon/distance in one shot, which the generic patterns above don't do.
// Confirmed against a real server line:
// Player "V" (DEAD) (id=... pos=<...>) killed by Player "K" (id=... pos=<...>) with M70 Tundra from 110.053 meters
const FATAL_KILL_RE = /Player "([^"]+)".*?killed by Player "([^"]+)"(?:\s*\([^)]*\))?(?:\s+with\s+(.+?))?(?:\s+from\s+([\d.]+)\s*meters)?\s*$/i;

function extractFatalKill(line) {
  const m = line.match(FATAL_KILL_RE);
  if (!m) return null;
  return { victim: m[1], killer: m[2], weapon: m[3] || null, distance: m[4] || null };
}

// The server periodically logs a full snapshot of every online player's
// current position as its own block:
//   HH:MM:SS | ##### PlayerList log: N players
//   HH:MM:SS | Player "Name" (id=... pos=<X, Z, Y>)
//   ...
//   HH:MM:SS | #####
// Each line still carries its own timestamp prefix. pos=<> orders as
// <X, Z, altitude> (confirmed against real coordinates — the third value is
// far too small to be a horizontal map coordinate on a 12800x12800 map).
function extractPlayerListSnapshots(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const stripTime = (l) => l.replace(/^\d{2}:\d{2}:\d{2}\s*\|\s*/, '');
  const snapshots = [];
  let i = 0;
  while (i < lines.length) {
    const startMatch = stripTime(lines[i]).match(/^#####\s*PlayerList log:\s*(\d+)\s*players?$/i);
    if (!startMatch) { i++; continue; }
    const players = [];
    let j = i + 1;
    while (j < lines.length) {
      const inner = stripTime(lines[j]);
      if (/^#####$/.test(inner)) { j++; break; }
      const pm = inner.match(/Player "([^"]+)".*?pos=<([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)>/);
      if (pm) players.push({ name: pm[1], x: parseFloat(pm[2]), z: parseFloat(pm[3]), altitude: parseFloat(pm[4]) });
      j++;
    }
    snapshots.push({ players });
    i = j;
  }
  return snapshots;
}

function distance2D(x1, z1, x2, z2) {
  return Math.sqrt((x1 - x2) ** 2 + (z1 - z2) ** 2);
}

function parseAdmLog(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const events = [];
  for (const line of lines) {
    const timeMatch = line.match(/^(\d{2}:\d{2}:\d{2})\s*\|\s*(.*)$/);
    const time = timeMatch ? timeMatch[1] : null;
    const rest = timeMatch ? timeMatch[2] : line;
    if (/^AdminLog started/i.test(line)) { events.push({ time, type: 'session', raw: rest }); continue; }

    const kill = extractFatalKill(rest);
    if (kill) { events.push({ time, type: 'kill', raw: rest, match: [kill.victim, kill.killer, kill.weapon, kill.distance] }); continue; }

    let matched = false;
    for (const { type, re } of ADM_PATTERNS) {
      const m = rest.match(re);
      if (m) { events.push({ time, type, raw: rest, match: m.slice(1) }); matched = true; break; }
    }
    if (!matched) events.push({ time, type: 'raw', raw: rest });
  }
  return events;
}

module.exports = {
  isConfigured,
  listDir,
  readTextFull, readTextTail, readFrom, writeText, getFileSize,
  findLatestAdmLog, parseAdmLog, extractFatalKill,
  extractPlayerListSnapshots, distance2D,
};
