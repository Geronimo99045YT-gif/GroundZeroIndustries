const express      = require('express');
const cookieParser = require('cookie-parser');
const crypto       = require('crypto');
const https        = require('https');

const db      = require('./db');
const actions = require('./actions');
const dayzFtp = require('./ftp');

const PORT             = process.env.PORT || 3000;
const CLIENT_ID        = process.env.CLIENT_ID;
const CLIENT_SECRET    = process.env.DISCORD_CLIENT_SECRET;
const SESSION_SECRET   = process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me';
const PUBLIC_URL        = process.env.PUBLIC_URL ?? null;

let botClient = null;
let startTime = Date.now();

function setBotClient(client) {
  botClient = client;
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

const app = express();
app.set('trust proxy', 1);
app.use(cookieParser());
app.use(express.json());
app.use('/dashboard', express.static(require('path').join(__dirname, 'public', 'dashboard')));

function baseUrl(req) {
  return PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
}

// ─── Session cookies (signed, stateless — survives Render restarts) ───────────

const SESSION_COOKIE = 'gz_session';

function signSession(payload) {
  const json = JSON.stringify(payload);
  const data = Buffer.from(json, 'utf8').toString('base64url');
  const sig  = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifySession(token) {
  if (!token) return null;
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

function readSession(req) {
  return verifySession(req.cookies[SESSION_COOKIE]);
}

// ─── Discord OAuth ─────────────────────────────────────────────────────────────

function discordApi(method, path, { token, form } = {}) {
  return new Promise((resolve, reject) => {
    const body = form ? new URLSearchParams(form).toString() : null;
    const req = https.request({
      hostname: 'discord.com',
      path: `/api${path}`,
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Discord API timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

app.get('/auth/discord', (req, res) => {
  const redirectUri = `${baseUrl(req)}/auth/discord/callback`;
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'identify guilds');
  res.redirect(url.toString());
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code, error, error_description } = req.query;
  if (error) {
    console.error(`OAuth denied/errored: ${error} — ${error_description ?? ''}`);
    return res.status(400).send(`Discord login was not completed: ${error_description || error}. <a href="/dashboard/">Try again</a>.`);
  }
  if (!code) return res.status(400).send('Discord did not send back a login code. <a href="/dashboard/">Try again</a>.');
  if (!CLIENT_SECRET) return res.status(500).send('Dashboard is not configured (missing DISCORD_CLIENT_SECRET).');

  try {
    const redirectUri = `${baseUrl(req)}/auth/discord/callback`;
    const token = await discordApi('POST', '/oauth2/token', {
      form: {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      },
    });
    if (!token?.access_token) {
      console.error('Discord token exchange failed:', JSON.stringify(token));
      return res.status(401).send(`Discord login failed: ${token?.error_description || token?.error || 'unknown error'}. <a href="/dashboard/">Try again</a>.`);
    }

    const user = await discordApi('GET', '/users/@me', { token: token.access_token });
    if (!user?.id) return res.status(401).send('Could not fetch your Discord profile. <a href="/dashboard/">Try again</a>.');

    const session = signSession({
      id: user.id,
      username: user.username,
      avatar: user.avatar,
      accessToken: token.access_token,
      exp: Date.now() + (token.expires_in ?? 604800) * 1000,
    });

    res.cookie(SESSION_COOKIE, session, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: (token.expires_in ?? 604800) * 1000,
    });
    res.redirect('/dashboard/');
  } catch (err) {
    console.error('OAuth callback failed:', err.message);
    res.status(500).send('Login failed — please try again.');
  }
});

app.get('/auth/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.redirect('/dashboard/');
});

// ─── Guild permission checks ────────────────────────────────────────────────────

const ADMINISTRATOR = 0x8n;
const userGuildsCache = new Map(); // userId -> { guilds, fetchedAt }

async function getUserGuilds(session) {
  const cached = userGuildsCache.get(session.id);
  if (cached && Date.now() - cached.fetchedAt < 60_000) return cached.guilds;
  const guilds = await discordApi('GET', '/users/@me/guilds', { token: session.accessToken });
  const list = Array.isArray(guilds) ? guilds : [];
  userGuildsCache.set(session.id, { guilds: list, fetchedAt: Date.now() });
  return list;
}

function isAdminOf(guildEntry) {
  if (!guildEntry) return false;
  if (guildEntry.owner) return true;
  try { return (BigInt(guildEntry.permissions) & ADMINISTRATOR) === ADMINISTRATOR; }
  catch { return false; }
}

function requireAuth(req, res, next) {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: 'Not logged in.' });
  req.gzSession = session;
  next();
}

async function requireGuildAdmin(req, res, next) {
  const guildId = req.params.guildId;
  const guild = botClient?.guilds.cache.get(guildId);
  if (!guild) return res.status(404).json({ error: "The bot isn't in that server." });

  const userGuilds = await getUserGuilds(req.gzSession);
  const entry = userGuilds.find(g => g.id === guildId);
  if (!isAdminOf(entry)) return res.status(403).json({ error: "You don't have admin rights on that server." });

  req.gzGuild = guild;
  next();
}

// ─── API: identity & guild list ────────────────────────────────────────────────

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ id: req.gzSession.id, username: req.gzSession.username, avatar: req.gzSession.avatar });
});

app.get('/api/guilds', requireAuth, async (req, res) => {
  const userGuilds = await getUserGuilds(req.gzSession);
  const mutual = userGuilds
    .filter(isAdminOf)
    .map(g => botClient?.guilds.cache.get(g.id))
    .filter(Boolean)
    .map(g => ({ id: g.id, name: g.name, icon: g.iconURL({ size: 64 }), memberCount: g.memberCount }));
  res.json(mutual);
});

// ─── API: per-guild overview ────────────────────────────────────────────────────

app.get('/api/guilds/:guildId/overview', requireAuth, requireGuildAdmin, (req, res) => {
  const g = req.gzGuild;
  res.json({
    name: g.name,
    icon: g.iconURL({ size: 128 }),
    memberCount: g.memberCount,
    createdAt: g.joinedAt,
    botOnline: botClient?.isReady() ?? false,
    botPing: botClient?.isReady() ? botClient.ws.ping : null,
    botUptime: formatUptime(Date.now() - startTime),
  });
});

app.get('/api/guilds/:guildId/channels', requireAuth, requireGuildAdmin, (req, res) => {
  const channels = req.gzGuild.channels.cache
    .filter(c => c.type === 0) // GuildText
    .map(c => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(channels);
});

app.get('/api/guilds/:guildId/roles', requireAuth, requireGuildAdmin, (req, res) => {
  const roles = req.gzGuild.roles.cache
    .filter(r => r.id !== req.gzGuild.id && !r.managed)
    .map(r => ({ id: r.id, name: r.name, color: r.hexColor }))
    .sort((a, b) => b.position - a.position || a.name.localeCompare(b.name));
  res.json(roles);
});

// ─── API: config (server info, channels, roles, trash talk) ───────────────────

app.get('/api/guilds/:guildId/config', requireAuth, requireGuildAdmin, async (req, res) => {
  const guildId = req.params.guildId;
  const [serverInfo, logChannel, rulesChannel, welcomeChannel, welcomeMessage, autoRole, reportsChannel, honeypotChannel, targetRole, trashTalk] = await Promise.all([
    db.getServerInfo(guildId), db.getLogChannel(guildId), db.getRulesChannel(guildId),
    db.getWelcomeChannel(guildId), db.getWelcomeMessage(guildId), db.getAutoRole(guildId),
    db.getReportsChannel(guildId), db.getHoneypotChannel(guildId), db.getTargetRole(guildId),
    db.getTrashTalk(guildId),
  ]);
  res.json({ serverInfo, logChannel, rulesChannel, welcomeChannel, welcomeMessage, autoRole, reportsChannel, honeypotChannel, targetRole, trashTalk });
});

app.put('/api/guilds/:guildId/config', requireAuth, requireGuildAdmin, async (req, res) => {
  const guildId = req.params.guildId;
  const body = req.body ?? {};
  const jobs = [];

  if ('serverInfo' in body) jobs.push(db.setServerInfo(guildId, body.serverInfo ?? {}));
  if ('logChannel' in body) jobs.push(db.setLogChannel(guildId, body.logChannel || null));
  if ('rulesChannel' in body) jobs.push(db.setRulesChannel(guildId, body.rulesChannel || null));
  if ('welcomeChannel' in body) jobs.push(db.setWelcomeChannel(guildId, body.welcomeChannel || null));
  if ('welcomeMessage' in body) jobs.push(db.setWelcomeMessage(guildId, body.welcomeMessage || null));
  if ('autoRole' in body) jobs.push(db.setAutoRole(guildId, body.autoRole || null));
  if ('reportsChannel' in body) jobs.push(db.setReportsChannel(guildId, body.reportsChannel || null));
  if ('honeypotChannel' in body) jobs.push(db.setHoneypotChannel(guildId, body.honeypotChannel || null));
  if ('targetRole' in body) jobs.push(db.setTargetRole(guildId, body.targetRole || null));
  if ('trashTalk' in body) jobs.push(db.setTrashTalk(guildId, !!body.trashTalk));

  await Promise.all(jobs);
  res.json({ ok: true });
});

app.post('/api/guilds/:guildId/honeypot/warn', requireAuth, requireGuildAdmin, async (req, res) => {
  const ok = await actions.postHoneypotWarning(req.params.guildId);
  res.json({ ok });
});

// ─── API: warnings ───────────────────────────────────────────────────────────

app.get('/api/guilds/:guildId/warnings/:userId', requireAuth, requireGuildAdmin, async (req, res) => {
  res.json(await db.getWarnings(req.params.guildId, req.params.userId));
});

app.delete('/api/guilds/:guildId/warnings/:id', requireAuth, requireGuildAdmin, async (req, res) => {
  await db.removeWarning(parseInt(req.params.id, 10), req.params.guildId);
  res.json({ ok: true });
});

app.get('/api/guilds/:guildId/warnpunish', requireAuth, requireGuildAdmin, async (req, res) => {
  res.json(await db.getWarnPunishConfig(req.params.guildId));
});

app.put('/api/guilds/:guildId/warnpunish', requireAuth, requireGuildAdmin, async (req, res) => {
  const { threshold, punishment, muteMinutes } = req.body ?? {};
  await db.setWarnPunishConfig(req.params.guildId, {
    threshold: threshold || null,
    punishment: threshold ? (punishment || null) : null,
    muteMinutes: muteMinutes || 60,
  });
  res.json({ ok: true });
});

// ─── API: automod ────────────────────────────────────────────────────────────

app.get('/api/guilds/:guildId/automod', requireAuth, requireGuildAdmin, async (req, res) => {
  res.json(await db.getAutomodConfig(req.params.guildId));
});

app.put('/api/guilds/:guildId/automod', requireAuth, requireGuildAdmin, async (req, res) => {
  const body = req.body ?? {};
  const patch = {};
  if ('bannedWords' in body) patch.bannedWords = body.bannedWords;
  if ('blockInvites' in body) patch.blockInvites = !!body.blockInvites;
  if ('maxMentions' in body) patch.maxMentions = body.maxMentions || null;
  if ('blockCaps' in body) patch.blockCaps = !!body.blockCaps;
  await db.setAutomodConfig(req.params.guildId, patch);
  res.json({ ok: true });
});

// ─── API: economy ────────────────────────────────────────────────────────────

app.get('/api/guilds/:guildId/economy/config', requireAuth, requireGuildAdmin, async (req, res) => {
  const [economy, killfeedChannel] = await Promise.all([
    db.getEconomyConfig(req.params.guildId),
    db.getKillfeedChannel(req.params.guildId),
  ]);
  res.json({ ...economy, killfeedChannel });
});

app.put('/api/guilds/:guildId/economy/config', requireAuth, requireGuildAdmin, async (req, res) => {
  const body = req.body ?? {};
  const jobs = [];
  const { killfeedChannel, ...economyFields } = body;
  if (Object.keys(economyFields).length > 0) jobs.push(db.setEconomyConfig(req.params.guildId, economyFields));
  if ('killfeedChannel' in body) jobs.push(db.setKillfeedChannel(req.params.guildId, killfeedChannel || null));
  await Promise.all(jobs);
  res.json({ ok: true });
});

app.get('/api/guilds/:guildId/economy/leaderboard', requireAuth, requireGuildAdmin, async (req, res) => {
  res.json(await db.getLeaderboard(req.params.guildId, 25));
});

app.get('/api/guilds/:guildId/economy/transactions', requireAuth, requireGuildAdmin, async (req, res) => {
  res.json(await db.getTransactions(req.params.guildId, 50));
});

app.post('/api/guilds/:guildId/economy/grant', requireAuth, requireGuildAdmin, async (req, res) => {
  const { userId, amount, reason } = req.body ?? {};
  if (!userId || !amount) return res.status(400).json({ error: 'userId and amount are required.' });
  const newBalance = await actions.adminAdjustBalance(req.params.guildId, userId, parseInt(amount, 10), req.gzSession.id, reason || null);
  res.json({ ok: true, newBalance });
});

app.get('/api/guilds/:guildId/economy/link/:userId', requireAuth, requireGuildAdmin, async (req, res) => {
  const link = await db.getLinkByUser(req.params.guildId, req.params.userId);
  res.json(link);
});

app.delete('/api/guilds/:guildId/economy/link/:userId', requireAuth, requireGuildAdmin, async (req, res) => {
  await db.removeLink(req.params.guildId, req.params.userId);
  res.json({ ok: true });
});

app.get('/api/guilds/:guildId/economy/minigames', requireAuth, requireGuildAdmin, async (req, res) => {
  const [work, risky, gambling, rob] = await Promise.all([
    db.getWorkConfig(req.params.guildId),
    db.getRiskyConfig(req.params.guildId),
    db.getGamblingConfig(req.params.guildId),
    db.getRobConfig(req.params.guildId),
  ]);
  res.json({ work, risky, gambling, rob });
});

app.put('/api/guilds/:guildId/economy/minigames', requireAuth, requireGuildAdmin, async (req, res) => {
  const { work, risky, gambling, rob } = req.body ?? {};
  const jobs = [];
  if (work) jobs.push(db.setWorkConfig(req.params.guildId, work));
  if (risky) jobs.push(db.setRiskyConfig(req.params.guildId, risky));
  if (gambling) jobs.push(db.setGamblingConfig(req.params.guildId, gambling));
  if (rob) jobs.push(db.setRobConfig(req.params.guildId, rob));
  await Promise.all(jobs);
  res.json({ ok: true });
});

// ─── API: moderation actions ──────────────────────────────────────────────────

app.post('/api/guilds/:guildId/moderation/purge', requireAuth, requireGuildAdmin, async (req, res) => {
  const { channelId, amount, userId } = req.body ?? {};
  const channel = req.gzGuild.channels.cache.get(channelId);
  if (!channel) return res.status(404).json({ error: 'Channel not found.' });
  try {
    const deleted = await actions.purgeMessages(channel, amount, userId || null);
    res.json({ ok: true, deleted });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/guilds/:guildId/moderation/slowmode', requireAuth, requireGuildAdmin, async (req, res) => {
  const { channelId, seconds } = req.body ?? {};
  const channel = req.gzGuild.channels.cache.get(channelId);
  if (!channel) return res.status(404).json({ error: 'Channel not found.' });
  try {
    await actions.setSlowmode(channel, parseInt(seconds, 10) || 0);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/guilds/:guildId/moderation/lock', requireAuth, requireGuildAdmin, async (req, res) => {
  const { channelId, reason } = req.body ?? {};
  const channel = req.gzGuild.channels.cache.get(channelId);
  if (!channel) return res.status(404).json({ error: 'Channel not found.' });
  try {
    await actions.lockChannel(channel, reason || `Locked from dashboard by ${req.gzSession.username}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/guilds/:guildId/moderation/unlock', requireAuth, requireGuildAdmin, async (req, res) => {
  const { channelId } = req.body ?? {};
  const channel = req.gzGuild.channels.cache.get(channelId);
  if (!channel) return res.status(404).json({ error: 'Channel not found.' });
  try {
    await actions.unlockChannel(channel, `Unlocked from dashboard by ${req.gzSession.username}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/guilds/:guildId/moderation/softban', requireAuth, requireGuildAdmin, async (req, res) => {
  const { userId, reason } = req.body ?? {};
  if (!userId) return res.status(400).json({ error: 'userId is required.' });
  try {
    await actions.softban(req.gzGuild, userId, reason || 'No reason provided');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/guilds/:guildId/moderation/tempban', requireAuth, requireGuildAdmin, async (req, res) => {
  const { userId, durationMins, reason } = req.body ?? {};
  if (!userId || !durationMins) return res.status(400).json({ error: 'userId and durationMins are required.' });
  try {
    await actions.tempBan(req.gzGuild, userId, reason || 'No reason provided', parseInt(durationMins, 10));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/guilds/:guildId/moderation/tempbans', requireAuth, requireGuildAdmin, async (req, res) => {
  res.json(await db.getActiveTempBans(req.params.guildId));
});

// ─── API: rules ──────────────────────────────────────────────────────────────

app.get('/api/guilds/:guildId/rules', requireAuth, requireGuildAdmin, async (req, res) => {
  res.json(await db.getRules(req.params.guildId));
});

app.post('/api/guilds/:guildId/rules', requireAuth, requireGuildAdmin, async (req, res) => {
  const { category, rule } = req.body ?? {};
  if (!category || !rule) return res.status(400).json({ error: 'category and rule are required.' });
  const num = await db.addRule(req.params.guildId, String(category).trim(), String(rule).trim());
  res.json({ ok: true, number: num });
});

app.delete('/api/guilds/:guildId/rules/:category/:number', requireAuth, requireGuildAdmin, async (req, res) => {
  const success = await db.removeRule(req.params.guildId, req.params.category, parseInt(req.params.number, 10));
  if (!success) return res.status(404).json({ error: 'Rule not found.' });
  res.json({ ok: true });
});

app.post('/api/guilds/:guildId/rules/post', requireAuth, requireGuildAdmin, async (req, res) => {
  const success = await actions.postRulesToChannel(req.params.guildId);
  if (!success) return res.status(400).json({ error: 'Set a rules channel and add at least one rule first.' });
  res.json({ ok: true });
});

// ─── API: schedules ──────────────────────────────────────────────────────────

app.get('/api/guilds/:guildId/schedules', requireAuth, requireGuildAdmin, async (req, res) => {
  res.json(await db.getSchedules(req.params.guildId));
});

app.post('/api/guilds/:guildId/schedules', requireAuth, requireGuildAdmin, async (req, res) => {
  const guildId = req.params.guildId;
  const { channelId, message, type, time, day } = req.body ?? {};
  if (!channelId || !message || !type) return res.status(400).json({ error: 'channelId, message and type are required.' });

  const row = {
    guild_id: guildId, channel_id: channelId, message,
    is_bot_command: !message.startsWith('/') && /^[!?$\\.~]/.test(message),
    created_by: req.gzSession.id, enabled: true,
  };

  if (type === 'once') {
    const dt = new Date(time);
    if (isNaN(dt)) return res.status(400).json({ error: 'Invalid date/time.' });
    row.recurring = false;
    row.run_once_at = dt.toISOString();
  } else if (type === 'minutes' || type === 'hours') {
    const val = parseInt(time, 10);
    if (isNaN(val) || val < 1) return res.status(400).json({ error: 'Provide a positive interval.' });
    row.recurring = true;
    row.interval_type = type;
    row.interval_value = val;
  } else if (type === 'daily') {
    if (!/^\d{1,2}:\d{2}$/.test(time)) return res.status(400).json({ error: 'Use HH:MM format (UTC).' });
    row.recurring = true;
    row.interval_type = 'daily';
    row.run_at_time = time;
  } else if (type === 'weekly') {
    if (!/^\d{1,2}:\d{2}$/.test(time)) return res.status(400).json({ error: 'Use HH:MM format (UTC).' });
    const dayNum = db.DAY_NAMES.indexOf(String(day ?? '').toLowerCase());
    if (dayNum === -1) return res.status(400).json({ error: 'Provide a valid day name.' });
    row.recurring = true;
    row.interval_type = 'weekly';
    row.interval_value = dayNum;
    row.run_at_time = time;
  } else {
    return res.status(400).json({ error: 'Unknown schedule type.' });
  }

  await db.createSchedule(row);
  res.json({ ok: true });
});

app.delete('/api/guilds/:guildId/schedules/:id', requireAuth, requireGuildAdmin, async (req, res) => {
  await db.deleteSchedule(parseInt(req.params.id, 10), req.params.guildId);
  res.json({ ok: true });
});

// ─── API: giveaways ──────────────────────────────────────────────────────────

app.get('/api/guilds/:guildId/giveaways', requireAuth, requireGuildAdmin, async (req, res) => {
  const active = await db.getActiveGiveaways(req.params.guildId);
  const withEntries = await Promise.all(active.map(async gw => ({
    ...gw, entryCount: (await db.getGiveawayEntries(gw.id)).length,
  })));
  res.json(withEntries);
});

app.post('/api/guilds/:guildId/giveaways', requireAuth, requireGuildAdmin, async (req, res) => {
  const { channelId, prize, durationMins, winners } = req.body ?? {};
  if (!channelId || !prize || !durationMins) return res.status(400).json({ error: 'channelId, prize and durationMins are required.' });
  const result = await actions.createGiveaway(req.params.guildId, channelId, prize, parseInt(durationMins, 10), parseInt(winners, 10) || 1, req.gzSession.id);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/guilds/:guildId/giveaways/:id/end', requireAuth, requireGuildAdmin, async (req, res) => {
  const ok = await actions.endGiveaway(parseInt(req.params.id, 10));
  res.json({ ok });
});

app.post('/api/guilds/:guildId/giveaways/:id/reroll', requireAuth, requireGuildAdmin, async (req, res) => {
  const result = await actions.rerollGiveaway(parseInt(req.params.id, 10));
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

// ─── API: DayZ server (FTP/Nitrado) ────────────────────────────────────────────

app.get('/api/guilds/:guildId/dayz/status', requireAuth, requireGuildAdmin, async (req, res) => {
  const profilesPath = await db.getDayzProfilesPath(req.params.guildId);
  res.json({ configured: dayzFtp.isConfigured(), profilesPath });
});

app.put('/api/guilds/:guildId/dayz/profiles-path', requireAuth, requireGuildAdmin, async (req, res) => {
  await db.setDayzProfilesPath(req.params.guildId, req.body?.path || null);
  res.json({ ok: true });
});

app.get('/api/guilds/:guildId/dayz/browse', requireAuth, requireGuildAdmin, async (req, res) => {
  try {
    const entries = await dayzFtp.listDir(req.query.path || '/');
    res.json(entries);
  } catch (err) {
    res.status(502).json({ error: `FTP error: ${err.message}` });
  }
});

app.get('/api/guilds/:guildId/dayz/file', requireAuth, requireGuildAdmin, async (req, res) => {
  const { path, tail } = req.query;
  if (!path) return res.status(400).json({ error: 'path is required.' });
  try {
    const result = tail === 'true' ? await dayzFtp.readTextTail(path) : await dayzFtp.readTextFull(path);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: `FTP error: ${err.message}` });
  }
});

app.put('/api/guilds/:guildId/dayz/file', requireAuth, requireGuildAdmin, async (req, res) => {
  const { path, content } = req.body ?? {};
  if (!path || content == null) return res.status(400).json({ error: 'path and content are required.' });
  try {
    await dayzFtp.writeText(path, content);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: `FTP error: ${err.message}` });
  }
});

app.get('/api/guilds/:guildId/dayz/activity', requireAuth, requireGuildAdmin, async (req, res) => {
  const profilesPath = req.query.path || await db.getDayzProfilesPath(req.params.guildId);
  if (!profilesPath) return res.status(400).json({ error: 'Set a DayZ profiles path first.' });
  try {
    const logPath = await dayzFtp.findLatestAdmLog(profilesPath);
    if (!logPath) return res.status(404).json({ error: `No .ADM log files found in ${profilesPath}.` });
    const { text, totalSize } = await dayzFtp.readTextTail(logPath, 300_000);
    const events = dayzFtp.parseAdmLog(text);
    res.json({ logPath, totalSize, events: events.slice(-300).reverse() });
  } catch (err) {
    res.status(502).json({ error: `FTP error: ${err.message}` });
  }
});

// ─── API: player stats ───────────────────────────────────────────────────────

app.get('/api/guilds/:guildId/stats/top', requireAuth, requireGuildAdmin, async (req, res) => {
  res.json(await db.getTopPlayerStats(req.params.guildId, 25));
});

app.get('/api/guilds/:guildId/stats/:userId', requireAuth, requireGuildAdmin, async (req, res) => {
  const { stats, analysis } = await actions.getOrRefreshStyleAnalysis(req.params.guildId, req.params.userId);
  if (!stats) return res.status(404).json({ error: 'No data for that user yet.' });
  res.json({ stats, analysis });
});

// ─── Public status page (unauthenticated) ─────────────────────────────────────

app.get('/status', (req, res) => {
  const online  = botClient?.isReady() ?? false;
  res.json({
    online,
    ping:    online ? botClient.ws.ping : null,
    uptime:  formatUptime(Date.now() - startTime),
    guilds:  online ? botClient.guilds.cache.size : 0,
    tag:     online ? botClient.user.tag : null,
  });
});

app.get('/', (req, res) => {
  const online  = botClient?.isReady() ?? false;
  const uptime  = formatUptime(Date.now() - startTime);
  const ping    = online ? botClient.ws.ping : '—';
  const guilds  = online ? botClient.guilds.cache.size : 0;
  const tag     = online ? botClient.user.tag : 'Offline';
  const dot     = online ? '#22c55e' : '#ef4444';
  const status  = online ? 'Online' : 'Offline';

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta http-equiv="refresh" content="30"/>
  <title>GroundZeroAI — Status</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Segoe UI', system-ui, sans-serif;
      background: #0d1117;
      color: #e6edf3;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 16px;
      padding: 40px 48px;
      width: 100%;
      max-width: 480px;
      text-align: center;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }

    .logo {
      font-size: 48px;
      margin-bottom: 8px;
    }

    h1 {
      font-size: 22px;
      font-weight: 700;
      color: #f0f6fc;
      margin-bottom: 4px;
    }

    .tag {
      font-size: 13px;
      color: #8b949e;
      margin-bottom: 28px;
    }

    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: #21262d;
      border: 1px solid #30363d;
      border-radius: 999px;
      padding: 8px 20px;
      font-size: 15px;
      font-weight: 600;
      margin-bottom: 32px;
    }

    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: ${dot};
      ${online ? 'box-shadow: 0 0 8px ' + dot + ';' : ''}
      ${online ? 'animation: pulse 2s infinite;' : ''}
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.4; }
    }

    .stats {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 12px;
      margin-bottom: 28px;
    }

    .stat {
      background: #21262d;
      border: 1px solid #30363d;
      border-radius: 10px;
      padding: 14px 8px;
    }

    .stat-value {
      font-size: 22px;
      font-weight: 700;
      color: #f0f6fc;
    }

    .stat-label {
      font-size: 11px;
      color: #8b949e;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-top: 4px;
    }

    .commands {
      text-align: left;
      background: #21262d;
      border: 1px solid #30363d;
      border-radius: 10px;
      padding: 16px 18px;
      margin-bottom: 20px;
    }

    .commands h2 {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #8b949e;
      margin-bottom: 10px;
    }

    .cmd {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 5px 0;
      border-bottom: 1px solid #30363d;
      font-size: 13px;
    }
    .cmd:last-child { border-bottom: none; }
    .cmd-name { color: #79c0ff; font-weight: 600; }
    .cmd-desc { color: #8b949e; font-size: 12px; }

    .footer {
      font-size: 12px;
      color: #484f58;
    }

    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">🪖</div>
    <h1>GroundZeroAI</h1>
    <div class="tag">${tag}</div>

    <div class="status-pill">
      <div class="dot"></div>
      ${status}
    </div>

    <div class="stats">
      <div class="stat">
        <div class="stat-value">${ping}${typeof ping === 'number' ? 'ms' : ''}</div>
        <div class="stat-label">Ping</div>
      </div>
      <div class="stat">
        <div class="stat-value">${uptime}</div>
        <div class="stat-label">Uptime</div>
      </div>
      <div class="stat">
        <div class="stat-value">${guilds}</div>
        <div class="stat-label">Servers</div>
      </div>
    </div>

    <div class="commands">
      <h2>Commands</h2>
      <div class="cmd"><span class="cmd-name">/loot</span><span class="cmd-desc">Spawn heatmap for any item</span></div>
      <div class="cmd"><span class="cmd-name">/tip</span><span class="cmd-desc">Random DayZ console tip</span></div>
      <div class="cmd"><span class="cmd-name">/kick /ban /mute</span><span class="cmd-desc">Moderation</span></div>
      <div class="cmd"><span class="cmd-name">/warn</span><span class="cmd-desc">Warn a member (DMs them)</span></div>
      <div class="cmd"><span class="cmd-name">/setlogchannel</span><span class="cmd-desc">Set mod log channel</span></div>
      <div class="cmd"><span class="cmd-name">/roll</span><span class="cmd-desc">Roll a dice</span></div>
    </div>

    <div class="footer">
      Page refreshes every 30s &nbsp;·&nbsp;
      <a href="/status">JSON status</a> &nbsp;·&nbsp;
      <a href="/dashboard/">Admin dashboard</a>
    </div>
  </div>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Status page + dashboard running on port ${PORT}`);
});

module.exports = { setBotClient };
