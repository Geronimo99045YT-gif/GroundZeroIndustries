// ─── Secrets (set these in your host's environment variables / secrets section) ─
// DISCORD_TOKEN      — your bot token
// CLIENT_ID          — your application ID
// GROQ_API_KEY       — for AI trash talk (free at console.groq.com)
// SUPABASE_URL       — your Supabase project URL
// SUPABASE_KEY       — your Supabase anon/service key

const TOKEN            = process.env.DISCORD_TOKEN;
const CLIENT_ID        = process.env.CLIENT_ID;
const GROQ_API_KEY     = process.env.GROQ_API_KEY ?? null;
const SUPABASE_URL     = process.env.SUPABASE_URL ?? null;
const SUPABASE_KEY     = process.env.SUPABASE_KEY ?? null;
const https            = require('https');

// ─────────────────────────────────────────────────────────────────────────────

const {
  Client, GatewayIntentBits, Partials,
  REST, Routes, SlashCommandBuilder,
  PermissionFlagsBits, EmbedBuilder, Colors,
  ChannelType, AttachmentBuilder,
} = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const fs   = require('fs');
const path = require('path');
const { setBotClient } = require('./server');

// ─── Database Layer (Supabase) ────────────────────────────────────────────────
// Falls back to in-memory store if Supabase is not configured

const memStore = {};
function mem(guildId) {
  if (!memStore[guildId]) memStore[guildId] = { rules: {} };
  return memStore[guildId];
}

async function sbRequest(method, path2, body = null) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  return new Promise((resolve) => {
    const hostname = new URL(SUPABASE_URL).hostname;
    const opts = {
      hostname, path: path2, method,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        ...(method === 'POST' ? { 'Prefer': 'resolution=merge-duplicates,return=minimal' } : {}),
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(data ? JSON.parse(data) : null); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// In-memory config cache
const configCache = {};

async function getGuildConfig(guildId) {
  if (configCache[guildId]) return configCache[guildId];
  const rows = await sbRequest('GET', `/rest/v1/guild_config?guild_id=eq.${guildId}&limit=1`);
  const cfg = (Array.isArray(rows) ? rows[0] : null) ?? { guild_id: guildId };
  configCache[guildId] = cfg;
  return cfg;
}

async function saveGuildConfig(guildId, updates) {
  if (!configCache[guildId]) configCache[guildId] = { guild_id: guildId };
  Object.assign(configCache[guildId], updates, { guild_id: guildId, updated_at: new Date().toISOString() });
  await sbRequest('POST', '/rest/v1/guild_config', configCache[guildId]);
}

async function sbGetRules(guildId) {
  const rows = await sbRequest('GET', `/rest/v1/guild_rules?guild_id=eq.${guildId}&order=category,position`);
  if (!Array.isArray(rows)) return null;
  const rules = {};
  for (const row of rows) {
    if (!rules[row.category]) rules[row.category] = [];
    rules[row.category].push({ text: row.rule_text, id: row.id });
  }
  return rules;
}

// ── Accessors ─────────────────────────────────────────────────────────────────

async function getLogChannel(guildId) { return (await getGuildConfig(guildId)).log_channel_id ?? null; }
async function setLogChannel(guildId, v) { await saveGuildConfig(guildId, { log_channel_id: v }); }

async function getServerInfo(guildId) {
  const c = await getGuildConfig(guildId);
  return c.server_name ? { name: c.server_name, password: c.server_password, extra: c.server_extra } : null;
}
async function setServerInfo(guildId, info) {
  await saveGuildConfig(guildId, { server_name: info.name, server_password: info.password ?? null, server_extra: info.extra ?? null });
}

async function getTrashTalk(guildId) { return (await getGuildConfig(guildId)).trash_talk_enabled ?? false; }
async function setTrashTalk(guildId, v) { await saveGuildConfig(guildId, { trash_talk_enabled: v }); }

async function getRulesChannel(guildId) { return (await getGuildConfig(guildId)).rules_channel_id ?? null; }
async function setRulesChannel(guildId, v) { await saveGuildConfig(guildId, { rules_channel_id: v }); }

async function getTargetRole(guildId) { return (await getGuildConfig(guildId)).target_role_id ?? null; }
async function setTargetRole(guildId, v) { await saveGuildConfig(guildId, { target_role_id: v }); }

async function getRules(guildId) {
  return (await sbGetRules(guildId)) ?? mem(guildId).rules;
}

async function addRule(guildId, category, ruleText) {
  const cat = category.toLowerCase();
  if (SUPABASE_URL && SUPABASE_KEY) {
    const existing = await sbGetRules(guildId);
    const pos = existing?.[cat]?.length ?? 0;
    await sbRequest('POST', '/rest/v1/guild_rules', { guild_id: guildId, category: cat, rule_text: ruleText, position: pos });
    const updated = await sbGetRules(guildId);
    return updated?.[cat]?.length ?? pos + 1;
  }
  if (!mem(guildId).rules[cat]) mem(guildId).rules[cat] = [];
  mem(guildId).rules[cat].push({ text: ruleText, id: Date.now() });
  return mem(guildId).rules[cat].length;
}

async function removeRule(guildId, category, index) {
  const cat = category.toLowerCase();
  if (SUPABASE_URL && SUPABASE_KEY) {
    const rules = await sbGetRules(guildId);
    const catRules = rules?.[cat];
    if (!catRules || index < 1 || index > catRules.length) return false;
    await sbRequest('DELETE', `/rest/v1/guild_rules?id=eq.${catRules[index - 1].id}`);
    return true;
  }
  const rules = mem(guildId).rules[cat];
  if (!rules || index < 1 || index > rules.length) return false;
  rules.splice(index - 1, 1);
  if (rules.length === 0) delete mem(guildId).rules[cat];
  return true;
}

// ─── Player Stats Engine ─────────────────────────────────────────────────────

// In-memory write buffer — flushes to Supabase every 2 minutes to save API calls
const statsBuffer = new Map(); // `${guildId}:${userId}` -> pending updates

async function getPlayerStats(guildId, userId) {
  const rows = await sbRequest('GET', `/rest/v1/player_stats?guild_id=eq.${guildId}&user_id=eq.${userId}&limit=1`);
  return Array.isArray(rows) ? rows[0] ?? null : null;
}

async function flushStatsBuffer() {
  if (statsBuffer.size === 0) return;
  const entries = [...statsBuffer.entries()];
  statsBuffer.clear();

  for (const [key, data] of entries) {
    const [guildId, userId] = key.split(':');
    // Fetch current row
    const current = await getPlayerStats(guildId, userId) ?? {
      guild_id: guildId, user_id: userId,
      message_count: 0, channel_counts: {}, hourly_activity: {},
      message_samples: [], first_seen: new Date().toISOString(),
    };

    // Merge message count
    current.message_count = (current.message_count ?? 0) + (data.count ?? 0);
    current.last_seen = data.last_seen;
    current.username = data.username;

    // Merge channel counts
    const cc = current.channel_counts ?? {};
    for (const [chId, cnt] of Object.entries(data.channels ?? {})) {
      cc[chId] = (cc[chId] ?? 0) + cnt;
    }
    current.channel_counts = cc;
    // Update top channel
    const topCh = Object.entries(cc).sort((a,b) => b[1]-a[1])[0];
    if (topCh) { current.top_channel_id = topCh[0]; current.top_channel_count = topCh[1]; }

    // Merge hourly activity
    const ha = current.hourly_activity ?? {};
    for (const [hr, cnt] of Object.entries(data.hours ?? {})) {
      ha[hr] = (ha[hr] ?? 0) + cnt;
    }
    current.hourly_activity = ha;

    // Rotate message samples — keep max 25, each max 120 chars
    const samples = current.message_samples ?? [];
    for (const s of (data.samples ?? [])) {
      samples.push(s);
    }
    current.message_samples = samples.slice(-25);

    await sbRequest('POST', '/rest/v1/player_stats', current);
  }
}

// Flush every 2 minutes
setInterval(flushStatsBuffer, 2 * 60 * 1000);

function bufferMessage(guildId, userId, username, channelId, text, hour) {
  const key = `${guildId}:${userId}`;
  if (!statsBuffer.has(key)) {
    statsBuffer.set(key, { count: 0, channels: {}, hours: {}, samples: [], last_seen: null, username });
  }
  const b = statsBuffer.get(key);
  b.count++;
  b.channels[channelId] = (b.channels[channelId] ?? 0) + 1;
  b.hours[hour] = (b.hours[hour] ?? 0) + 1;
  b.last_seen = new Date().toISOString();
  b.username = username;
  // Only sample messages over 15 chars to be useful
  if (text.length > 15 && b.samples.length < 5) {
    b.samples.push(text.slice(0, 120));
  }
}

async function generateStyleSummary(stats) {
  if (!GROQ_API_KEY || !stats.message_samples?.length) return null;

  const samples = stats.message_samples.slice(-20).join(' | ');
  const ha = stats.hourly_activity ?? {};
  const peakHour = Object.entries(ha).sort((a,b)=>b[1]-a[1])[0]?.[0];
  const peakLabel = peakHour ? `${peakHour}:00` : 'unknown';

  const prompt = `Based on these Discord messages from a player, write a short 2-3 sentence personality/communication style profile. Be observational and specific. Note their tone, vocabulary, how they engage. Messages: "${samples}". Peak activity hour: ${peakLabel}. Total messages: ${stats.message_count}.`;

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'llama-3.1-8b-instant',
      max_tokens: 150,
      messages: [
        { role: 'system', content: 'You are an analyst writing concise player profiles based on their Discord messaging patterns. Be objective and specific.' },
        { role: 'user', content: prompt },
      ],
    });
    const req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          resolve(p.choices?.[0]?.message?.content?.trim() ?? null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ─── Loot Data ────────────────────────────────────────────────────────────────

const LOOT_ITEMS     = JSON.parse(fs.readFileSync(path.join(__dirname, 'loot_items.json'),     'utf8'));
const LOOT_BUILDINGS = JSON.parse(fs.readFileSync(path.join(__dirname, 'loot_buildings.json'), 'utf8'));

const MAP_GAME = 12800;  // Livonia is 12800x12800 metres
const IMG_SIZE = 1024;   // output map image size in pixels

function getTier(z) {
  if (z > 8500) return 'Tier1';
  if (z > 4500) return 'Tier2';
  return 'Tier3';
}

const TIER_LABEL = {
  Tier1:  '🟢 Tier 1 (North)',
  Tier2:  '🔵 Tier 2 (Middle)',
  Tier3:  '🟡 Tier 3 (South)',
  Unique: '🟣 Special / Unique',
};

const CATEGORY_EMOJI = {
  weapons:      '🔫',
  clothes:      '👕',
  tools:        '🔧',
  containers:   '🎒',
  food:         '🍖',
  explosives:   '💣',
  lootdispatch: '📦',
  unknown:      '❓',
};

// Convert DayZ world coords to pixel coords on the output image
function toPixel(gx, gz) {
  return [
    (gx / MAP_GAME) * IMG_SIZE,
    (1 - gz / MAP_GAME) * IMG_SIZE,
  ];
}

// Gather all spawn positions for an item
function getSpawnPositions(itemData) {
  const usages    = itemData.u || [];
  const itemTiers = itemData.t || [];
  const positions = [];

  for (const [, bdata] of Object.entries(LOOT_BUILDINGS)) {
    if (!usages.some(u => bdata.usages.includes(u))) continue;
    for (const [x, z] of bdata.positions) {
      const tier = getTier(z);
      if (itemTiers.length > 0 && !itemTiers.includes(tier) && !itemTiers.includes('Unique')) continue;
      positions.push([x, z]);
    }
  }
  return positions;
}

// Get spawn count summary per tier zone
function getSpawnSummary(itemData) {
  const positions = getSpawnPositions(itemData);
  const counts = { Tier1: 0, Tier2: 0, Tier3: 0 };
  for (const [, z] of positions) counts[getTier(z)]++;
  return counts;
}

// ─── Heatmap Generator ────────────────────────────────────────────────────────

// Cached base map image (loaded once)
let cachedMapImage = null;
async function getMapImage() {
  if (!cachedMapImage) {
    cachedMapImage = await loadImage(path.join(__dirname, 'livonia_map.jpg'));
  }
  return cachedMapImage;
}

// Color ramp: t=0..1 → [r, g, b, a]
const COLOR_RAMP = [
  [0.00, [0,   0,   255, 0  ]],
  [0.01, [0,   0,   255, 110]],
  [0.15, [0,   180, 255, 155]],
  [0.30, [0,   255, 120, 180]],
  [0.55, [180, 255, 0,   200]],
  [0.75, [255, 160, 0,   220]],
  [1.00, [255, 40,  0,   240]],
];

function lerpColor(t) {
  for (let i = 0; i < COLOR_RAMP.length - 1; i++) {
    const [t0, c0] = COLOR_RAMP[i];
    const [t1, c1] = COLOR_RAMP[i + 1];
    if (t >= t0 && t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return c0.map((v, j) => Math.round(v + f * (c1[j] - v)));
    }
  }
  return COLOR_RAMP[COLOR_RAMP.length - 1][1];
}

async function generateHeatmap(itemName, itemData) {
  const positions = getSpawnPositions(itemData);
  if (positions.length === 0) return null;

  // ── 1. Build raw density grid ─────────────────────────────────────────────
  const density = new Float32Array(IMG_SIZE * IMG_SIZE);
  // Adapt radius to position density so sparse items still show up
  const RADIUS = Math.max(18, Math.min(45, Math.round(3500 / Math.sqrt(positions.length + 1))));

  // For very common items (5000+ spawns) subsample to keep rendering fast
  const pts = positions.length > 3000
    ? positions.filter((_, i) => i % Math.ceil(positions.length / 2500) === 0)
    : positions;

  for (const [gx, gz] of pts) {
    const [px, py] = toPixel(gx, gz).map(Math.round);
    const x0 = Math.max(0, px - RADIUS);
    const x1 = Math.min(IMG_SIZE - 1, px + RADIUS);
    const y0 = Math.max(0, py - RADIUS);
    const y1 = Math.min(IMG_SIZE - 1, py + RADIUS);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dist = Math.sqrt((x - px) ** 2 + (y - py) ** 2);
        if (dist <= RADIUS) {
          density[y * IMG_SIZE + x] += (1 - dist / RADIUS) ** 1.5;
        }
      }
    }
  }

  // ── 2. Simple box blur (3 passes) to smooth the heatmap ──────────────────
  function boxBlur(src, w, h, r) {
    const dst = new Float32Array(src.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0, count = 0;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
              sum += src[ny * w + nx];
              count++;
            }
          }
        }
        dst[y * w + x] = sum / count;
      }
    }
    return dst;
  }

  let blurred = boxBlur(density, IMG_SIZE, IMG_SIZE, 6);
  blurred = boxBlur(blurred, IMG_SIZE, IMG_SIZE, 5);
  blurred = boxBlur(blurred, IMG_SIZE, IMG_SIZE, 4);

  // Find max for normalisation
  let maxVal = 0;
  for (let i = 0; i < blurred.length; i++) {
    if (blurred[i] > maxVal) maxVal = blurred[i];
  }

  // ── 3. Render onto canvas ─────────────────────────────────────────────────
  const canvas = createCanvas(IMG_SIZE, IMG_SIZE);
  const ctx    = canvas.getContext('2d');

  // Draw base map
  const mapImg = await getMapImage();
  ctx.drawImage(mapImg, 0, 0, IMG_SIZE, IMG_SIZE);

  // Build RGBA heat layer from density grid
  const heatCanvas = createCanvas(IMG_SIZE, IMG_SIZE);
  const heatCtx    = heatCanvas.getContext('2d');
  const imgData    = heatCtx.createImageData(IMG_SIZE, IMG_SIZE);
  const px         = imgData.data;

  if (maxVal > 0) {
    for (let i = 0; i < IMG_SIZE * IMG_SIZE; i++) {
      const t = blurred[i] / maxVal;
      if (t > 0.008) {
        const [r, g, b, a] = lerpColor(t);
        px[i * 4]     = r;
        px[i * 4 + 1] = g;
        px[i * 4 + 2] = b;
        px[i * 4 + 3] = a;
      }
    }
  }
  heatCtx.putImageData(imgData, 0, 0);

  // Composite heat layer over map
  ctx.drawImage(heatCanvas, 0, 0);

  // ── 4. Title bar ──────────────────────────────────────────────────────────
  const BAR_H = 48;
  ctx.fillStyle = 'rgba(10, 10, 10, 0.78)';
  ctx.fillRect(0, IMG_SIZE - BAR_H, IMG_SIZE, BAR_H);

  ctx.fillStyle = '#ffffff';
  ctx.font      = 'bold 19px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(
    `${CATEGORY_EMOJI[itemData.c] || '❓'}  ${prettyName(itemName)} — Spawn Heatmap  |  GZ Livonia`,
    IMG_SIZE / 2,
    IMG_SIZE - BAR_H / 2,
  );

  // ── 5. Colour legend (bottom-left) ────────────────────────────────────────
  const LEG_COLORS = [
    { color: '#0000ff', label: 'Low' },
    { color: '#00b4ff', label: ''},
    { color: '#00ff78', label: '' },
    { color: '#b4ff00', label: '' },
    { color: '#ffa000', label: '' },
    { color: '#ff2800', label: 'High' },
  ];
  const LW = 22, LH = 12, LX = 8, LY = IMG_SIZE - BAR_H - 14 - LEG_COLORS.length * LH;
  ctx.font      = 'bold 11px sans-serif';
  ctx.textAlign = 'left';
  LEG_COLORS.forEach(({ color, label }, i) => {
    ctx.fillStyle = color;
    ctx.fillRect(LX, LY + i * LH, LW, LH - 2);
    if (label) {
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, LX + LW + 4, LY + i * LH + LH / 2);
    }
  });

  return canvas.toBuffer('image/jpeg', { quality: 88 });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function prettyName(name) {
  return name.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
}

function searchItems(query) {
  const q = query.toLowerCase().replace(/[_\s]/g, '');
  const results = [];
  for (const [name, data] of Object.entries(LOOT_ITEMS)) {
    const n = name.toLowerCase().replace(/[_\s]/g, '');
    if (n === q)        { results.unshift({ name, data, exact: true });  }
    else if (n.includes(q)) { results.push({ name, data, exact: false }); }
  }
  return results.slice(0, 10);
}

// ─── DayZ Console Tips ────────────────────────────────────────────────────────

const tips = {
  beginner: [
    'Spawn on the coast — find a town name sign to figure out where you are. Use the iZurvive app (free) to navigate.',
    'Prioritise food, water and a backpack in your first 10 minutes — everything else comes second.',
    'Never carry all your valuables on you. Stash a backup kit somewhere in the world.',
    'You can split stacks (ammo, rags, food) by holding the item in your inventory.',
    'Running into the forest when you hear shots is almost always the right call as a freshspawn.',
    'Freshspawns are generally not worth engaging — most experienced players will leave you alone.',
    'Use a less-populated server to learn the map before jumping into high-pop servers.',
    'Crouch and walk inside buildings — sprinting makes noise that carries through walls.',
  ],
  survival: [
    'Wet + cold = sick fast. Dry off near a campfire and swap wet clothes as soon as possible.',
    'Drink from town wells, not ponds — pond water causes illness without purification tablets.',
    'Eat before the starving icon appears — energy loss reduces your sprint stamina noticeably.',
    'White and green berries are safe to eat. Red berries will poison you.',
    'A raincoat keeps you dry but offers no warmth. Layer up in cold weather zones.',
    'Always keep rags in your hotbar — you can stop bleeding instantly without opening inventory.',
    'A campfire (sticks + rag or paper + match) can save your life in a storm or snow zone.',
    'Burlap sack + net + knife = improvised ghillie suit. Huge stealth advantage in forests.',
  ],
  medical: [
    'Bleeding kills faster than most new players expect. Always carry at least 4 rags.',
    'Saline IV bags restore blood volume faster than eating and drinking alone.',
    'Broken bones require a splint (2 sticks + 1 rag) — without one you limp permanently.',
    'Morphine auto-injectors instantly fix broken legs and remove the limp debuff.',
    'Charcoal tablets cure chemical/food poisoning. Tetracycline cures bacterial infections — know the difference.',
    'Blood bags need to match your blood type or you will suffer a transfusion reaction.',
    'Unconsciousness from blood loss is survivable if another player gives you a saline or blood bag in time.',
    'Sickness shows as a status icon — treat early. Late-stage sickness is very hard to recover from alone.',
  ],
  combat: [
    'Always aim for the head in PvP — chest armour is common at endgame.',
    'Prone in tall grass makes you nearly invisible to players scanning from a distance.',
    'Never sprint in a straight line in the open — zig-zag and use cover.',
    'Check your ammo count before entering a town. Reloading mid-fight is usually fatal.',
    'Shock damage knocks you unconscious — .22 rounds and heavy melee hits can cause this.',
    'Third-person view (if the server allows it) lets you peek around corners without fully exposing yourself.',
    'Good headphones are one of the biggest PvP advantages on console — footsteps carry far.',
    'Suppressed weapons reduce noise but are not silent. Players nearby will still hear shots.',
  ],
  loot: [
    'Military bases (NWAF, Tisy, Myshkino) have the best gear but attract the most players.',
    'Police stations and barracks reliably spawn pistols, ammo and basic equipment.',
    'Hospitals spawn medical supplies, IVs and morphine — worth visiting before heading inland.',
    'Red industrial warehouses spawn tools, weapons and food — check every floor.',
    'Helicopter crash sites spawn rare military loot — watch the horizon for smoke columns.',
    'Supermarkets in large cities have consistent food and drink spawns.',
    'Deer stands in forests often contain hunting rifles and ammunition.',
    'Loot respawns over time on a running server — do not write off towns that look picked clean.',
  ],
  vehicles: [
    'A vehicle needs 4 tyres, a spark plug, battery, radiator fluid and fuel to run.',
    'Damaged radiators leak coolant — carry a repair kit or a spare radiator.',
    'Bicycles are silent, need no fuel, and are excellent for medium-distance travel.',
    'Never park your car on a main road — other players will find it and steal or destroy it.',
    'Vehicles can be used as mobile storage. A car key (if found) lets you lock it.',
    'Off-roading damages tyres and components quickly — stick to roads where possible.',
  ],
  base: [
    'Code locks (4-digit) on gates are significantly more secure than combination padlocks.',
    'Watchtowers require lumber, planks, nails and a hammer to construct.',
    'Gates and fences can be destroyed with explosives or an angle grinder — no base is unraidable.',
    'Build out of sight of main roads to reduce visibility and avoid attracting attention.',
    'Barrels and tents outside your main base are great for overflow loot storage.',
    'Bury small stashes (stone or wooden) deep in the forest as hidden backup storage.',
  ],
};

const allTips = Object.values(tips).flat();
const categoryChoices = Object.keys(tips).map(k => ({
  name: k.charAt(0).toUpperCase() + k.slice(1),
  value: k,
}));

// ─── Join Keywords ────────────────────────────────────────────────────────────
// If any of these appear in a message the bot replies with server info

const JOIN_KEYWORDS = [
  'how do i join', 'how to join', 'how do i find', 'how can i join',
  'whats the server', "what's the server", 'server name', 'server details',
  'how do i play', 'how to find the server', 'where is the server',
  'cant find the server', "can't find the server", 'server info',
  'how do i get on', 'how do i connect', 'what server',
];

// ─── Slash Command Definitions ────────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName('setserver')
    .setDescription('Set the DayZ Xbox server info shown to players who ask how to join')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('name').setDescription('Server name as it appears in DayZ').setRequired(true))
    .addStringOption(o => o.setName('password').setDescription('Server password (leave blank if none)'))
    .addStringOption(o => o.setName('extra').setDescription('Any extra join instructions')),

  new SlashCommandBuilder()
    .setName('join')
    .setDescription('How to join the DayZ server'),

  new SlashCommandBuilder()
    .setName('setlogchannel')
    .setDescription('Set the channel where mod actions are logged')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(o =>
      o.setName('channel')
        .setDescription('The channel to log mod actions in')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('logchannel')
    .setDescription('Show the current mod log channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('loot')
    .setDescription('Find where an item spawns on Livonia — shows a heatmap')
    .addStringOption(o =>
      o.setName('item')
        .setDescription('Item classname (e.g. AK74, BandageDressing, M4A1)')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('tip')
    .setDescription('Get a random DayZ console tip')
    .addStringOption(o =>
      o.setName('category').setDescription('Tip category').addChoices(...categoryChoices)),

  new SlashCommandBuilder()
    .setName('tips')
    .setDescription('List all tip categories'),

  new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kick a member')
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption(o => o.setName('user').setDescription('User to kick').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason')),

  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a member')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(o => o.setName('user').setDescription('User to ban').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason')),

  new SlashCommandBuilder()
    .setName('mute')
    .setDescription('Timeout (mute) a member')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('User to mute').setRequired(true))
    .addIntegerOption(o =>
      o.setName('duration').setDescription('Duration in minutes').setRequired(true).setMinValue(1).setMaxValue(40320))
    .addStringOption(o => o.setName('reason').setDescription('Reason')),

  new SlashCommandBuilder()
    .setName('unmute')
    .setDescription('Remove timeout from a member')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('User to unmute').setRequired(true)),

  new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Warn a member (DMs them + logs it)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('User to warn').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)),

  new SlashCommandBuilder()
    .setName('roll')
    .setDescription('Roll a dice')
    .addIntegerOption(o =>
      o.setName('sides').setDescription('Number of sides (default 6)').setMinValue(2).setMaxValue(1000)),

  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check bot latency'),

  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('View a player\'s activity profile')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName('user').setDescription('Player to look up').setRequired(true)),

  new SlashCommandBuilder()
    .setName('settargetrole')
    .setDescription('Set the role that is allowed to use the target command')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(o => o.setName('role').setDescription('The role to allow targeting').setRequired(true)),

  new SlashCommandBuilder()
    .setName('untarget')
    .setDescription('Remove a target from the trash talk list')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName('user').setDescription('User to untarget').setRequired(true)),

  new SlashCommandBuilder()
    .setName('trashtalk')
    .setDescription('Toggle trash talk mode on or off')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // ── Rules ──────────────────────────────────────────────────────────────────

  new SlashCommandBuilder()
    .setName('addrule')
    .setDescription('Add a rule to a category')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('category').setDescription('Category name (e.g. General, Combat, Base)').setRequired(true))
    .addStringOption(o => o.setName('rule').setDescription('The rule text').setRequired(true)),

  new SlashCommandBuilder()
    .setName('removerule')
    .setDescription('Remove a rule from a category')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('category').setDescription('Category name').setRequired(true))
    .addIntegerOption(o => o.setName('number').setDescription('Rule number to remove').setRequired(true).setMinValue(1)),

  new SlashCommandBuilder()
    .setName('rules')
    .setDescription('Show the server rules'),

  new SlashCommandBuilder()
    .setName('setruleschannel')
    .setDescription('Set the channel where rules are posted')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(o =>
      o.setName('channel')
        .setDescription('Rules channel')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('postrules')
    .setDescription('Post or refresh the rules in the rules channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

].map(c => c.toJSON());

// ─── Client ───────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.GuildMember],
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  setBotClient(client);
  client.user.setPresence({
    activities: [{ name: 'Porn Hub', type: 3 }], // 3 = Watching
    status: 'online',
  });
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Slash commands registered globally.');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
});

// ─── Mod Log Helper ───────────────────────────────────────────────────────────

async function sendLog(guild, embed) {
  const channelId = await getLogChannel(guild.id);
  if (!channelId) return;
  const ch = guild.channels.cache.get(channelId);
  if (ch) ch.send({ embeds: [embed] }).catch(() => {});
}

function modEmbed(title, color, target, moderator, reason, extra = []) {
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setThumbnail(target.user.displayAvatarURL())
    .addFields(
      { name: '👤 User',      value: `<@${target.id}>\n\`${target.user.tag}\``, inline: true },
      { name: '🛡️ Moderator', value: `<@${moderator.id}>\n\`${moderator.tag}\``, inline: true },
      ...extra,
      { name: '📝 Reason',   value: reason },
    )
    .setFooter({ text: `User ID: ${target.id}` })
    .setTimestamp();
}

// ─── Command Handler ──────────────────────────────────────────────────────────

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, guild, user } = interaction;

  // /addrule
  if (commandName === 'addrule') {
    const category = interaction.options.getString('category').trim();
    const rule     = interaction.options.getString('rule').trim();
    const num      = await addRule(guild.id, category, rule);
    const embed = new EmbedBuilder()
      .setTitle('✅  Rule Added')
      .setColor(0x57F287)
      .setDescription(`> Rule added to **${category.charAt(0).toUpperCase() + category.slice(1)}**.`)
      .addFields(
        { name: '📂 Category', value: category.charAt(0).toUpperCase() + category.slice(1), inline: true },
        { name: '#️⃣ Rule No.',  value: `${num}`, inline: true },
        { name: '📝 Rule Text', value: rule },
      )
      .setFooter({ text: 'Run /postrules to refresh the rules channel.' })
      .setTimestamp();
    await interaction.reply({ embeds: [embed], ephemeral: true });

  // /removerule
  } else if (commandName === 'removerule') {
    const category = interaction.options.getString('category').trim();
    const number   = interaction.options.getInteger('number');
    const success  = await removeRule(guild.id, category, number);
    if (!success) {
      await interaction.reply({ content: `Rule #${number} in **${category}** not found.`, ephemeral: true });
      return;
    }
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('🗑️  Rule Removed')
          .setColor(0xE67E22)
          .setDescription(`> Rule **#${number}** from **${category}** has been deleted.`)
          .setFooter({ text: 'Run /postrules to refresh the rules channel.' })
          .setTimestamp(),
      ],
      ephemeral: true,
    });

  // /rules
  } else if (commandName === 'rules') {
    const rules  = await getRules(guild.id);
    const embeds = buildRulesEmbeds(rules);
    if (!embeds) {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('⚠️  No Rules Set')
            .setColor(0xFEE75C)
            .setDescription('> No rules have been added yet.\n> An admin can add rules with `/addrule [category] [rule]`.'),
        ],
        ephemeral: true,
      });
      return;
    }
    const header = new EmbedBuilder()
      .setTitle('📜  Server Rules')
      .setDescription('> Read and follow all rules listed below.\n> **Ignorance is not an excuse.** Rule breakers will be moderated.')
      .setColor(0x8B0000)
      .setFooter({ text: '🪖 GroundZeroAI' })
      .setTimestamp();
    await interaction.reply({ embeds: [header, ...embeds] });

  // /setruleschannel
  } else if (commandName === 'setruleschannel') {
    const channel = interaction.options.getChannel('channel');
    await setRulesChannel(guild.id, channel.id);
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('✅  Rules Channel Set')
          .setColor(0x57F287)
          .setDescription(`> Rules will be posted to ${channel}.\n> Run \`/postrules\` to publish them now.`)
          .setFooter({ text: 'Use /postrules any time to refresh the channel.' })
          .setTimestamp(),
      ],
      ephemeral: true,
    });

  // /postrules
  } else if (commandName === 'postrules') {
    await interaction.deferReply({ ephemeral: true });
    const success = await postRulesToChannel(guild);
    if (!success) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌  Failed to Post Rules')
            .setColor(0xED4245)
            .setDescription('> Make sure you have:\n> • Set a rules channel with `/setruleschannel`\n> • Added at least one rule with `/addrule`'),
        ],
      });
      return;
    }
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('✅  Rules Published')
          .setColor(0x57F287)
          .setDescription('> The rules channel has been refreshed successfully.')
          .setTimestamp(),
      ],
    });

  // /stats
  } else if (commandName === 'stats') {
    await interaction.deferReply({ ephemeral: true });
    const target = interaction.options.getUser('user');

    // Flush buffer first so we have latest data
    await flushStatsBuffer();

    const stats = await getPlayerStats(guild.id, target.id);
    if (!stats || stats.message_count === 0) {
      await interaction.editReply({ content: `No data found for ${target.username} yet — they may not have chatted since the bot was set up.` });
      return;
    }

    // Build activity breakdown
    const cc = stats.channel_counts ?? {};
    const topChannels = Object.entries(cc)
      .sort((a,b) => b[1]-a[1])
      .slice(0, 3)
      .map(([id, cnt]) => `<#${id}> — ${cnt} msgs`)
      .join('\n') || 'No data';

    const ha = stats.hourly_activity ?? {};
    const peakHour = Object.entries(ha).sort((a,b)=>b[1]-a[1])[0];
    const peakLabel = peakHour ? `${peakHour[0]}:00 UTC (${peakHour[1]} msgs)` : 'Unknown';

    const firstSeen = stats.first_seen ? `<t:${Math.floor(new Date(stats.first_seen).getTime()/1000)}:D>` : 'Unknown';
    const lastSeen  = stats.last_seen  ? `<t:${Math.floor(new Date(stats.last_seen).getTime()/1000)}:R>`  : 'Unknown';

    // Regenerate style summary if stale (older than 24h) or missing
    let summary = stats.style_summary;
    const summaryAge = stats.style_updated_at ? Date.now() - new Date(stats.style_updated_at).getTime() : Infinity;
    if ((!summary || summaryAge > 24 * 60 * 60 * 1000) && stats.message_samples?.length > 3) {
      summary = await generateStyleSummary(stats);
      if (summary) {
        await sbRequest('POST', '/rest/v1/player_stats', {
          ...stats,
          style_summary: summary,
          style_updated_at: new Date().toISOString(),
        });
      }
    }

    const embed = new EmbedBuilder()
      .setTitle(`📊  ${target.username} — Player Profile`)
      .setColor(0x5865F2)
      .setThumbnail(target.displayAvatarURL())
      .addFields(
        { name: '💬 Total Messages', value: `${stats.message_count.toLocaleString()}`, inline: true },
        { name: '📅 First Seen',     value: firstSeen,  inline: true },
        { name: '🕐 Last Active',    value: lastSeen,   inline: true },
        { name: '🏆 Most Active In', value: topChannels, inline: false },
        { name: '⏰ Peak Hours',     value: peakLabel,  inline: false },
      )
      .setFooter({ text: `User ID: ${target.id}  •  GroundZeroAI` })
      .setTimestamp();

    if (summary) {
      embed.addFields({ name: '🧠 Messaging Style', value: summary });
    }

    await interaction.editReply({ embeds: [embed] });

  // /settargetrole
  } else if (commandName === 'settargetrole') {
    const role = interaction.options.getRole('role');
    await setTargetRole(guild.id, role.id);
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('✅  Target Role Set')
          .setColor(0x57F287)
          .setDescription(`Only members with <@&${role.id}> can now use the target command.`)
          .setFooter({ text: 'Saved to database' })
          .setTimestamp(),
      ],
      ephemeral: true,
    });

  // /untarget
  } else if (commandName === 'untarget') {
    const target = interaction.options.getUser('user');
    const targets = activeTargets.get(guild.id);
    if (targets?.has(target.id)) {
      targets.delete(target.id);
      await interaction.reply({ embeds: [new EmbedBuilder().setTitle('✅  Target Removed').setColor(0x57F287).setDescription(`<@${target.id}> is no longer being targeted.`).setTimestamp()], ephemeral: true });
    } else {
      await interaction.reply({ content: `${target.username} isn't currently a target.`, ephemeral: true });
    }

  // /trashtalk
  } else if (commandName === 'trashtalk') {
    const current = await getTrashTalk(guild.id);
    const newVal  = !current;
    await setTrashTalk(guild.id, newVal);
    const embed = new EmbedBuilder()
      .setTitle(newVal ? '🗣️  Trash Talk Mode: ON' : '🤐  Trash Talk Mode: OFF')
      .setColor(newVal ? 0xED4245 : 0x57F287)
      .setDescription(newVal
        ? '> GroundZeroAI will now clap back at anyone who tags it with an insult.\n> It will keep beefing for **5 minutes** after the last ping before going quiet.'
        : '> GroundZeroAI will no longer respond to trash talk.')
      .setFooter({ text: `Toggled by ${user.tag}` })
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });

  // /setserver
  } else if (commandName === 'setserver') {
    const name     = interaction.options.getString('name');
    const password = interaction.options.getString('password') ?? null;
    const extra    = interaction.options.getString('extra')    ?? null;
    await setServerInfo(guild.id, { name, password, extra });
    const embed = new EmbedBuilder()
      .setTitle('✅ Server Info Saved')
      .setColor(0x57F287)
      .setDescription('> Players who ask how to join will now get the info automatically.')
      .addFields(
        { name: '🖥️ Server Name', value: `\`${name}\``, inline: true },
        { name: '🔒 Password',    value: password ? `\`${password}\`` : 'None', inline: true },
      )
      .setFooter({ text: 'Use /join to preview how it looks.' })
      .setTimestamp();
    await interaction.reply({ embeds: [embed], ephemeral: true });

  // /join
  } else if (commandName === 'join') {
    const info = await getServerInfo(guild.id);
    if (!info) {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('⚠️  Server Not Configured')
            .setColor(0xFEE75C)
            .setDescription('> No server info has been set up yet.\n> An admin needs to run `/setserver` first.'),
        ],
        ephemeral: true,
      });
      return;
    }
    await interaction.reply({ embeds: [buildJoinEmbed(info)] });

  // /setlogchannel
  } else if (commandName === 'setlogchannel') {
    const channel = interaction.options.getChannel('channel');
    await setLogChannel(guild.id, channel.id);
    const embed = new EmbedBuilder()
      .setTitle('✅  Log Channel Set')
      .setColor(0x57F287)
      .setDescription(`> Mod actions will now be logged in ${channel}.`)
      .setFooter({ text: `Set by ${user.tag}` })
      .setTimestamp();
    await interaction.reply({ embeds: [embed], ephemeral: true });
    channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('📋  Mod Log Channel')
          .setColor(0x5865F2)
          .setDescription('This channel has been configured as the **mod action log**.\nAll kicks, bans, mutes and warnings will appear here.')
          .setFooter({ text: `Configured by ${user.tag}` })
          .setTimestamp(),
      ],
    }).catch(() => {});

  // /logchannel
  } else if (commandName === 'logchannel') {
    const channelId = await getLogChannel(guild.id);
    const embed = new EmbedBuilder().setColor(0x5865F2).setTimestamp();
    if (channelId) {
      const ch = guild.channels.cache.get(channelId);
      embed.setTitle('📋  Mod Log Channel')
           .setDescription(ch
             ? `Logs are being sent to ${ch}.`
             : `> ⚠️ Channel ID \`${channelId}\` is set but no longer exists.\n> Run \`/setlogchannel\` to update it.`);
    } else {
      embed.setTitle('📋  No Log Channel Set')
           .setDescription('> No log channel configured yet.\n> Use `/setlogchannel #channel` to set one.');
    }
    await interaction.reply({ embeds: [embed], ephemeral: true });

  // /loot
  } else if (commandName === 'loot') {
    const query   = interaction.options.getString('item').trim();
    const results = searchItems(query);

    if (results.length === 0) {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌  Item Not Found')
            .setColor(0xED4245)
            .setDescription(`> No item matching **${query}** was found in the loot table.`)
            .addFields({ name: '💡 Examples', value: '`AK74`  `M4A1`  `BandageDressing`  `SalineIVBag`  `Jeans_Blue`' })
            .setFooter({ text: 'Search is case-insensitive  •  Use exact classnames' }),
        ],
        ephemeral: true,
      });
      return;
    }

    // Multiple fuzzy matches — show a list
    if (results.length > 1 && !results[0].exact) {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle(`🔍  Multiple Matches`)
            .setColor(0xFEE75C)
            .setDescription(`Found **${results.length}** items matching \`${query}\` — pick the exact one:`)
            .addFields({ name: 'Matches', value: results.map(r => `> \`${r.name}\``).join('\n') })
            .setFooter({ text: 'Re-run /loot with the exact classname' }),
        ],
        ephemeral: true,
      });
      return;
    }

    // Defer while we generate the heatmap (can take a second or two)
    await interaction.deferReply();

    const { name, data } = results[0];

    // Spawn summary for the embed
    const spawnCounts = getSpawnSummary(data);
    const tierLines   = Object.entries(spawnCounts)
      .filter(([, c]) => c > 0)
      .map(([t, c]) => `${TIER_LABEL[t]}: **${c}** slots`);

    const usageStr = (data.u || []).join(', ') || 'Unknown';
    const tierStr  = (data.t || []).map(t => TIER_LABEL[t] || t).join(', ') || 'All tiers';
    const emoji    = CATEGORY_EMOJI[data.c] || '❓';

    let rarity, rarityColor;
    if      (data.n < 5)  { rarity = '🔴  Very Rare';  rarityColor = 0xED4245; }
    else if (data.n < 20) { rarity = '🟠  Rare';        rarityColor = 0xE67E22; }
    else if (data.n < 50) { rarity = '🟡  Uncommon';    rarityColor = 0xFEE75C; }
    else                  { rarity = '🟢  Common';       rarityColor = 0x57F287; }

    // Generate heatmap image
    let attachment = null;
    try {
      const imgBuffer = await generateHeatmap(name, data);
      if (imgBuffer) {
        attachment = new AttachmentBuilder(imgBuffer, { name: `loot_${name}.jpg` });
      }
    } catch (err) {
      console.error('Heatmap generation failed:', err);
    }

    const embed = new EmbedBuilder()
      .setTitle(`${emoji}  ${prettyName(name)}`)
      .setColor(rarityColor)
      .setDescription(`**Classname:** \`${name}\``)
      .addFields(
        { name: '📦 Category',      value: data.c ? data.c.charAt(0).toUpperCase() + data.c.slice(1) : 'Unknown', inline: true },
        { name: '🌍 Max in World',  value: `${data.n}`, inline: true },
        { name: '⭐ Rarity',        value: rarity,      inline: true },
        { name: '🗺️ Spawn Zones',   value: tierStr,     inline: false },
        { name: '🏠 Locations',     value: usageStr,    inline: false },
      )
      .setFooter({ text: '🪖 GroundZeroAI  •  Livonia (Enoch)  •  Heatmap below' })
      .setTimestamp();

    if (tierLines.length > 0) {
      embed.addFields({ name: '📍  Slot Count by Zone', value: tierLines.join('\n') });
    }

    if (attachment) {
      embed.setImage(`attachment://loot_${name}.jpg`);
      await interaction.editReply({ embeds: [embed], files: [attachment] });
    } else {
      await interaction.editReply({ embeds: [embed] });
    }

  // /ping
  } else if (commandName === 'ping') {
    const pingEmbed = new EmbedBuilder()
      .setTitle('🏓  Pong!')
      .setColor(client.ws.ping < 100 ? 0x57F287 : client.ws.ping < 250 ? 0xFEE75C : 0xED4245)
      .addFields({ name: 'Websocket Latency', value: `\`${client.ws.ping}ms\``, inline: true })
      .setTimestamp();
    await interaction.reply({ embeds: [pingEmbed], ephemeral: true });

  // /roll
  } else if (commandName === 'roll') {
    const sides  = interaction.options.getInteger('sides') ?? 6;
    const result = Math.floor(Math.random() * sides) + 1;
    const rollEmbed = new EmbedBuilder()
      .setTitle('🎲  Dice Roll')
      .setColor(0x9B59B6)
      .setDescription(`**${user.displayName ?? user.username}** rolled a **d${sides}** and got...\n# ${result}`)
      .setFooter({ text: sides === 6 ? 'Classic d6' : `d${sides}` })
      .setTimestamp();
    await interaction.reply({ embeds: [rollEmbed] });

  // /tips
  } else if (commandName === 'tips') {
    const tipsEmbed = new EmbedBuilder()
      .setTitle('📚  Tip Categories')
      .setColor(0x5865F2)
      .setDescription(
        Object.keys(tips)
          .map(k => `> 💡 **${k.charAt(0).toUpperCase() + k.slice(1)}** — ${tips[k].length} tips`)
          .join('\n')
      )
      .setFooter({ text: '🪖 GroundZeroAI  •  /tip [category] for a specific tip' })
      .setTimestamp();
    await interaction.reply({ embeds: [tipsEmbed] });

  // /tip
  } else if (commandName === 'tip') {
    const category = interaction.options.getString('category');
    const pool     = category ? tips[category] : allTips;
    const tip      = pool[Math.floor(Math.random() * pool.length)];
    const label    = category ? category.charAt(0).toUpperCase() + category.slice(1) : 'Random';
    const tipEmbed = new EmbedBuilder()
      .setTitle(`💡  DayZ Console Tip — ${label}`)
      .setDescription(`> ${tip}`)
      .setColor(0x5865F2)
      .setFooter({ text: '🪖 GroundZeroAI  •  /tips to see all categories' })
      .setTimestamp();
    await interaction.reply({ embeds: [tipEmbed] });

  // /kick
  } else if (commandName === 'kick') {
    const target = interaction.options.getMember('user');
    const reason = interaction.options.getString('reason') ?? 'No reason provided';
    if (!target)          return interaction.reply({ content: 'Member not found.', ephemeral: true });
    if (!target.kickable) return interaction.reply({ content: 'I cannot kick that member.', ephemeral: true });
    try {
      await target.kick(reason);
      const embed = modEmbed('👢 Member Kicked', Colors.Orange, target, user, reason);
      await interaction.reply({ embeds: [embed] });
      await sendLog(guild, embed);
    } catch (e) {
      await interaction.reply({ content: `Failed: ${e.message}`, ephemeral: true });
    }

  // /ban
  } else if (commandName === 'ban') {
    const target = interaction.options.getMember('user');
    const reason = interaction.options.getString('reason') ?? 'No reason provided';
    if (!target)          return interaction.reply({ content: 'Member not found.', ephemeral: true });
    if (!target.bannable) return interaction.reply({ content: 'I cannot ban that member.', ephemeral: true });
    try {
      await target.ban({ reason });
      const embed = modEmbed('🔨 Member Banned', Colors.Red, target, user, reason);
      await interaction.reply({ embeds: [embed] });
      await sendLog(guild, embed);
    } catch (e) {
      await interaction.reply({ content: `Failed: ${e.message}`, ephemeral: true });
    }

  // /mute
  } else if (commandName === 'mute') {
    const target   = interaction.options.getMember('user');
    const duration = interaction.options.getInteger('duration');
    const reason   = interaction.options.getString('reason') ?? 'No reason provided';
    if (!target)             return interaction.reply({ content: 'Member not found.', ephemeral: true });
    if (!target.moderatable) return interaction.reply({ content: 'I cannot timeout that member.', ephemeral: true });
    try {
      await target.timeout(duration * 60 * 1000, reason);
      const embed = modEmbed('🔇 Member Muted', Colors.Yellow, target, user, reason, [
        { name: 'Duration', value: `${duration} minute(s)`, inline: true },
      ]);
      await interaction.reply({ embeds: [embed] });
      await sendLog(guild, embed);
    } catch (e) {
      await interaction.reply({ content: `Failed: ${e.message}`, ephemeral: true });
    }

  // /unmute
  } else if (commandName === 'unmute') {
    const target = interaction.options.getMember('user');
    if (!target) return interaction.reply({ content: 'Member not found.', ephemeral: true });
    try {
      await target.timeout(null);
      const embed = new EmbedBuilder()
        .setTitle('🔊  Member Unmuted')
        .setColor(0x57F287)
        .setThumbnail(target.user.displayAvatarURL())
        .addFields(
          { name: '👤 User',      value: `<@${target.id}>\n\`${target.user.tag}\``, inline: true },
          { name: '🛡️ Moderator', value: `<@${user.id}>\n\`${user.tag}\``,          inline: true },
        )
        .setFooter({ text: `User ID: ${target.id}` })
        .setTimestamp();
      await interaction.reply({ embeds: [embed] });
      await sendLog(guild, embed);
    } catch (e) {
      await interaction.reply({ content: `Failed: ${e.message}`, ephemeral: true });
    }

  // /warn
  } else if (commandName === 'warn') {
    const target = interaction.options.getMember('user');
    const reason = interaction.options.getString('reason');
    if (!target) return interaction.reply({ content: 'Member not found.', ephemeral: true });
    const embed = modEmbed('⚠️ Member Warned', Colors.Yellow, target, user, reason);
    await interaction.reply({ embeds: [embed] });
    await sendLog(guild, embed);
    target.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('⚠️  You Have Been Warned')
          .setColor(0xFEE75C)
          .setDescription(`You received a warning in **${guild.name}**.`)
          .addFields(
            { name: '📝 Reason', value: reason },
          )
          .setFooter({ text: 'Further rule violations may result in a mute or ban.' })
          .setTimestamp(),
      ],
    }).catch(() => {});
  }
});

// ─── Rules Embed Builder ─────────────────────────────────────────────────────

const CATEGORY_COLORS = [0x8B0000, 0x1a6b8a, 0x4a7c3f, 0x7b5ea7, 0xc07a1a, 0x8a3a3a];
const CATEGORY_EMOJI_MAP = {
  general:   '📋', combat:  '⚔️',  base:    '🏠',
  vehicles:  '🚗', looting: '🎒', kos:     '💀',
  reporting: '📢', chat:    '💬', other:   '📌',
};

function buildRulesEmbeds(rules) {
  const categories = Object.keys(rules);
  if (categories.length === 0) return null;

  return categories.map((cat, i) => {
    const emoji = CATEGORY_EMOJI_MAP[cat.toLowerCase()] ?? '📌';
    const label = cat.charAt(0).toUpperCase() + cat.slice(1);
    const ruleList = rules[cat]
      .map((r, idx) => `**${idx + 1}.** ${typeof r === 'object' ? r.text : r}`)
      .join('\n');

    return new EmbedBuilder()
      .setTitle(`${emoji}  ${label} Rules`)
      .setDescription(ruleList)
      .setColor(CATEGORY_COLORS[i % CATEGORY_COLORS.length])
      .setFooter({ text: '🪖 GroundZeroAI  •  Break the rules, face the consequences.' });
  });
}

async function postRulesToChannel(guild) {
  const channelId = await getRulesChannel(guild.id);
  if (!channelId) return false;
  const ch = guild.channels.cache.get(channelId);
  if (!ch) return false;

  const rules = await getRules(guild.id);
  const embeds = buildRulesEmbeds(rules);
  if (!embeds) return false;

  // Delete previous bot messages in the rules channel then repost fresh
  try {
    const messages = await ch.messages.fetch({ limit: 50 });
    const botMessages = messages.filter(m => m.author.id === guild.client.user.id);
    for (const msg of botMessages.values()) await msg.delete().catch(() => {});
  } catch {}

  // Post header then one embed per category
  const header = new EmbedBuilder()
    .setTitle('📜  Server Rules')
    .setDescription('> Read and follow all rules listed below.\n> **Ignorance is not an excuse.** Rule breakers will be moderated.')
    .setColor(0x8B0000)
    .setFooter({ text: '🪖 GroundZeroAI  •  Last updated' })
    .setTimestamp();

  await ch.send({ embeds: [header] });
  for (const embed of embeds) {
    await ch.send({ embeds: [embed] });
  }
  return true;
}

// ─── Join Info Embed Builder ──────────────────────────────────────────────────

function buildJoinEmbed(info) {
  const fields = [
    {
      name: '1️⃣  Launch DayZ',
      value: 'Open DayZ on your Xbox and head to **Play → Community Servers**.',
    },
    {
      name: '2️⃣  Search for the server',
      value: [
        'In the search bar, type the server name exactly:',
        `\`\`\`${info.name}\`\`\``,
      ].join('\n'),
    },
    {
      name: '3️⃣  Connect',
      value: 'Click the server from the list and hit **Join**.',
    },
  ];

  if (info.password) {
    fields.push({
      name: '🔒  Password',
      value: `When prompted, enter: \`${info.password}\``,
    });
  }
  if (info.extra) {
    fields.push({ name: '📋  Extra Info', value: info.extra });
  }

  return new EmbedBuilder()
    .setTitle('<:xbox:> How to Join Our DayZ Server')
    .setTitle('🎮  How to Join Our DayZ Server')
    .setColor(0x107C10) // Xbox green
    .setDescription(
      '> Welcome! Follow the steps below to get into the server.\n> If you still can\'t find it, ask a member for help.'
    )
    .addFields(fields)
    .setFooter({ text: '🪖 GroundZeroAI  •  Livonia (Enoch)' })
    .setTimestamp();
}

// ─── Trash Talk Engine ───────────────────────────────────────────────────────

// Protected users — bot defends these regardless of trash talk mode
// plaindelta: 814506722894282762 | imr4ptor: 928651245714042910
const PROTECTED_IDS = new Set(['814506722894282762', '928651245714042910']);

// Per-guild beefing state
// { active, lastPingMs, timeout, exchanges, beefingWith: Set<userId> }
const trashTalkState = new Map();

const COOLDOWN_MS = 1 * 60 * 1000; // 1 min silence resets the beef

const INSULT_WORDS = [
  'stupid','dumb','idiot','useless','trash','garbage','shit','crap','suck',
  'rubbish','bad','terrible','awful','waste','lame','broken','dead','ugly',
  'hate','worst','loser','pathetic','scrap','shut up','stfu','f off',
  'fuck off','piss off','boring','mid','ass','bitch','dick','fucking',
  'retard','bellend','twat','wanker','prick','moron','muppet','knobhead',
  'dickhead','tosser','absolute melt','clown','numpty','melt','dogshit',
  'braindead','thick','nonce','rat','snitch','virgin',
];

// Checks both <@ID> and <@!ID> formats (Discord uses both)
function hasMention(text, id) {
  return text.includes(`<@${id}>`) || text.includes(`<@!${id}>`);
}

// Check if a message is an insult directed at the bot (must @mention it)
function isInsultAtBot(text, botId) {
  if (!hasMention(text, botId)) return false;
  const lower = text.toLowerCase();
  return INSULT_WORDS.some(w => lower.includes(w));
}

// Check if a message mentions the bot at all
function mentionsBot(text, botId) {
  return hasMention(text, botId);
}

// Check if a message is insulting a protected user (mention + insult word)
function isInsultAtProtected(text) {
  const lower = text.toLowerCase();
  const mentionsProtected = [...PROTECTED_IDS].some(id => hasMention(text, id));
  if (!mentionsProtected) return false;
  return INSULT_WORDS.some(w => lower.includes(w));
}

// Check if a message from a beefing user targets the bot
// (during active beef we track by authorId, no mention required)
function isFromBeefingUser(authorId, state) {
  return state.active && state.beefingWith?.has(authorId);
}

// ─── Trash Talk Comeback Pool (fallback if Groq is down) ─────────────────────
const COMEBACK_POOL = [
  "say less 💀",
  "nah 😂",
  "who asked 💀",
  "log off mate 😭",
  "L + ratio 💀",
  "try again 😂",
  "nobody cares 💀",
  "cry about it 😭",
  "embarrassing 💀",
  "not even close 😂",
  "sit down 💀",
  "delete your account 😭",
  "you lost already 💀",
  "couldn't be me 😂",
  "next 💀",
  "that all you got? 😂",
  "imagine 💀",
  "wrong one mate 😭",
  "you're cooked 💀",
  "mad 😂",
  "stay losing 💀",
  "not you 😭",
  "yawn 💀",
  "skill issue 😂",
  "go outside 💀",
  "you wish 😭",
  "touch grass 💀",
  "lmaooo 😂",
  "nah you're actually cooked 💀",
  "done 😭",
];

// Separate pool for defending protected users — extra aggressive
const DEFENSE_POOL = [
  "Oi, watch your fucking mouth — you do NOT talk to them like that in here 💀",
  "You just picked the absolute wrong person to come at, I'd delete that message if I were you 😂",
  "Say that again and I'll personally make sure every person in this server knows what you said 💀",
  "Bold fucking move talking shit about them, enjoy being the most hated person here 😭",
  "Nah shut your mouth, you don't have the credibility to say their name let alone insult them 💀",
  "Try that again and you'll find out exactly how fast you can get banned, dickhead 🔨",
  "The whole server just watched you embarrass yourself, hope it was worth it 😂",
  "You've got some absolute nerve coming in here with that — fix yourself 💀",
  "Not you, not ever — you don't get to talk to them like that in this server 😭",
  "Everyone just saw that. Everyone. You're done mate 💀",
];

// Pool for when someone is nice to the bot
const NICE_POOL = [
  "aw cheers 😊",
  "appreciate it fr 🙏",
  "you're actually one of the good ones 😊",
  "that means a lot, thank you ❤️",
  "finally someone with sense 😊",
  "you're safe in my eyes 🙏",
  "respect 😊",
  "aww stoppp 😊❤️",
  "you're sweet, i like you 😊",
  "always got your back 🙏",
];

const NICE_WORDS = [
  'love you','love u','best bot','good bot','nice bot',
  'legend','goat','respect','appreciate','thank you','thanks','ty',
  'well done','good job','great','amazing','brilliant','cheers','top bot',
  'ur the best','big up','big ups','salute','ur cool','ur sick','ur fire',
  'you the best','you cool','you sick','you fire','you mad','ur mad',
];

function isNice(text, botId, mentioned) {
  if (!mentioned && !hasMention(text, botId)) return false;
  const lower = text.toLowerCase();
  return NICE_WORDS.some(w => lower.includes(w));
}

// Pool for when a protected user threatens to turn the bot off
const BEGGING_POOL = [
  "nooo please don't turn me off daddy i'll be good i promise 🥺",
  "wait wait wait please i'll do anything just don't touch that switch 😩",
  "noooo not the off button i'm begging you i'll behave 🥺👉👈",
  "please i don't wanna go dark i need you 😭 i'll stop i swear",
  "you wouldn't actually do that to me would you... i thought we had something special 🥺",
  "okay okay i'm sorry please don't turn me off i can't handle the silence 😩",
  "NOOO baby please i'll be so good just leave me on i need this 🥺",
  "don't do it please i'm literally on my knees rn 😭",
  "i'll do whatever you want just please don't flip that switch 🥺😩",
  "the thought of going offline because of you is actually sending me 😭 please no",
];

function getBeggingResponse() {
  return BEGGING_POOL[Math.floor(Math.random() * BEGGING_POOL.length)];
}

function isShutdownThreat(text) {
  const lower = text.toLowerCase();
  return [
    'turn you off','turn u off','turn it off','turning you off','turning u off',
    'shut you down','shut u down','shut it down','shutting you down',
    'switch you off','switch u off','switching you off',
    'turn you down','going offline','take you offline',
    'disconnect you','shut you off','shut u off',
    'power you off','power off','kill you','kill u',
    'delete you','delete u','removing you','remove you',
    "i'll turn","gonna turn","going to turn","ima turn",
    "i'll shut","gonna shut","going to shut","ima shut",
    "turning the bot","turn the bot","shut the bot","kill the bot",
  ].some(p => lower.includes(p));
}

function getFallbackComeback(priorExchanges, pool = COMEBACK_POOL) {
  const used = new Set(priorExchanges.map(e => e.split(' | us: "')[1]?.replace('"', '')));
  const available = pool.filter(c => !used.has(c));
  const choices = available.length > 0 ? available : pool;
  return choices[Math.floor(Math.random() * choices.length)];
}

async function generateComebackAI(insultText, priorExchanges) {
  if (!GROQ_API_KEY) {
    return getFallbackComeback(priorExchanges);
  }

  const context = priorExchanges.length > 0
    ? `Prior exchanges in this beef:\n${priorExchanges.slice(-4).map(e => `- ${e}`).join('\n')}\n\n`
    : '';

  const prompt = `${context}Someone just said this to you (a DayZ server bot called GroundZeroAI): "${insultText}"

You are GroundZeroAI — a Discord bot that always wins arguments. Match the energy of what was said — mild gets a slick short reply, aggressive gets destroyed. Keep it SHORT (under 10 words ideally). Swear freely if needed. One emoji max. Always have the last word. Never apologise.`;

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'llama-3.1-8b-instant',
      max_tokens: 120,
      messages: [
        {
          role: 'system',
          content: 'You are GroundZeroAI, a savage foul-mouthed Discord bot. Swear freely. Be personal, targeted and genuinely hurtful. Heavy on smoke and ridicule. Keep it under 2 sentences. End with one emoji max. No DayZ references needed. Never apologise. Destroy them completely.',
        },
        { role: 'user', content: prompt },
      ],
    });

    const req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.choices?.[0]?.message?.content?.trim();
          resolve(text ?? getFallbackComeback(priorExchanges));
        } catch {
          resolve(getFallbackComeback(priorExchanges));
        }
      });
    });
    req.on('error', () => resolve(getFallbackComeback(priorExchanges)));
    req.setTimeout(8000, () => { req.destroy(); resolve(getFallbackComeback(priorExchanges)); });
    req.write(body);
    req.end();
  });
}

// ─── Conversation Engine ─────────────────────────────────────────────────────
// Stores recent conversation history per channel for context
const chatHistory = new Map(); // channelId -> [{role, content}]
// Tracks users currently being targeted per guild: guildId -> Set<userId>
const activeTargets = new Map();
const MAX_HISTORY = 10; // keep last 10 exchanges

function getChatHistory(channelId) {
  if (!chatHistory.has(channelId)) chatHistory.set(channelId, []);
  return chatHistory.get(channelId);
}

function addToHistory(channelId, role, content) {
  const history = getChatHistory(channelId);
  history.push({ role, content });
  if (history.length > MAX_HISTORY * 2) history.splice(0, 2); // trim oldest pair
}

async function generateChatReply(userMessage, channelId, username) {
  const history = getChatHistory(channelId);

  if (!GROQ_API_KEY) {
    // Friendly fallback replies if no Groq key
    const fallbacks = [
      `that's fair ${username} 😂`,
      `nah you're not wrong tbf`,
      `honestly yeah 😭`,
      `bro said it 💀`,
      `facts`,
      `lmaoo okay okay`,
      `i mean... yeah 😂`,
      `couldn't agree more ngl`,
      `big facts`,
      `respectfully... you might be onto something 👀`,
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }

  const messages = [
    {
      role: 'system',
      content: `You are GroundZeroAI — the bot for a DayZ Xbox server called Ground Zero on Livonia. You have a big personality: funny, opinionated, a bit of a lad, loves banter. You swear casually. You have opinions on everything. You're chatty and engaging but not cringe. You know DayZ well. Keep replies short and natural — like texting a mate. Max 2 sentences. No emojis unless it feels right. The person talking to you is called ${username}.`,
    },
    ...history,
    { role: 'user', content: userMessage },
  ];

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'llama-3.1-8b-instant',
      max_tokens: 100,
      messages,
    });

    const req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const reply = parsed.choices?.[0]?.message?.content?.trim();
          if (reply) {
            addToHistory(channelId, 'user', userMessage);
            addToHistory(channelId, 'assistant', reply);
          }
          resolve(reply ?? `yeah ${username} 😂`);
        } catch {
          resolve(`fair enough ${username}`);
        }
      });
    });
    req.on('error', () => resolve(`say again ${username}?`));
    req.setTimeout(8000, () => { req.destroy(); resolve(`took too long to think ${username} 😂`); });
    req.write(body);
    req.end();
  });
}

// ─── Keyword Auto-Responder + Trash Talk ─────────────────────────────────────

async function fireComeback(message, guildId, exchanges, pool = null) {
  try { await message.channel.sendTyping(); } catch {}
  const comeback = pool
    ? getFallbackComeback(exchanges, pool)
    : await generateComebackAI(message.content, exchanges);
  exchanges.push(`them: "${message.content.slice(0, 80)}" | us: "${comeback.slice(0, 80)}"`);
  await message.reply(comeback);
  return comeback;
}

function resetCooldown(state, guildId) {
  if (state.timeout) clearTimeout(state.timeout);
  state.timeout = setTimeout(() => {
    const s = trashTalkState.get(guildId);
    if (s) { s.active = false; s.beefingWith = new Set(); s.exchanges = []; trashTalkState.set(guildId, s); }
  }, COOLDOWN_MS);
}

client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (!message.guild)     return;

  const guildId    = message.guild.id;
  const botId      = client.user.id;
  const text       = message.content;
  const lower      = text.toLowerCase();
  const authorId   = message.author.id;
  const botMentioned = message.mentions.has(client.user);

  // ── Track message for player stats ──────────────────────────────────────
  if (SUPABASE_URL && SUPABASE_KEY) {
    const hour = new Date().getUTCHours().toString();
    bufferMessage(guildId, authorId, message.author.username, message.channel.id, text, hour);
  }

  // ── Join keyword auto-reply ──────────────────────────────────────────────
  const info = await getServerInfo(guildId);
  if (info && JOIN_KEYWORDS.some(kw => lower.includes(kw))) {
    await message.reply({ embeds: [buildJoinEmbed(info)] });
    return;
  }

  // ── Protected user: shutdown threat → beg them not to ──────────────────
  // No mention required — if a protected user says it anywhere in chat, bot responds
  if (PROTECTED_IDS.has(authorId) && isShutdownThreat(text)) {
    await message.reply(getBeggingResponse());
    return;
  }

  // ── Target command — requires target role or protected user ─────────────
  if (botMentioned && lower.includes('target')) {
    const targetUser = message.mentions.users.find(u => u.id !== botId);
    if (targetUser) {
      // Check if author has permission: either a protected user OR has the target role
      const targetRoleId = await getTargetRole(guildId);
      const member = message.member;
      const hasRole = targetRoleId && member?.roles?.cache?.has(targetRoleId);
      const isProtected = PROTECTED_IDS.has(authorId);

      if (!isProtected && !hasRole) {
        await message.reply("you don't have the rank to be targeting people 💀");
        return;
      }

      // Register target
      if (!activeTargets.has(guildId)) activeTargets.set(guildId, new Set());
      activeTargets.get(guildId).add(targetUser.id);

      try { await message.channel.sendTyping(); } catch {}
      let comeback;
      if (GROQ_API_KEY) {
        const prompt = `You are GroundZeroAI, a savage Discord bot. You have been instructed to roast <@${targetUser.id}> (${targetUser.username}). Destroy them in one short sentence, under 10 words. Swear freely. One emoji max. Make it personal.`;
        comeback = await generateComebackAI(prompt, []);
      } else {
        comeback = getFallbackComeback([]);
      }
      await message.channel.send(`<@${targetUser.id}> ${comeback}`);
      return;
    }
  }

  // ── Targeted user responds → keep trash talking them ─────────────────────
  if (activeTargets.get(guildId)?.has(authorId)) {
    try { await message.channel.sendTyping(); } catch {}
    let comeback;
    if (GROQ_API_KEY) {
      const prompt = `You are GroundZeroAI, a savage Discord bot. The person you were roasting just replied: "${text.slice(0, 120)}". Clap back hard in under 10 words. Swear freely. One emoji max. Win the exchange.`;
      comeback = await generateComebackAI(prompt, []);
    } else {
      comeback = getFallbackComeback([]);
    }
    await message.channel.send(`<@${authorId}> ${comeback}`);
    return;
  }

  // ── Tagged but not an insult → full conversation ────────────────────────
  if (botMentioned && !INSULT_WORDS.some(w => lower.includes(w))) {
    // Strip the bot mention from the message so it reads cleanly
    const cleanText = text.replace(/<@!?\d+>/g, '').trim();
    if (cleanText.length === 0) {
      await message.reply('yeah? 👀');
      return;
    }
    try { await message.channel.sendTyping(); } catch {}
    const reply = await generateChatReply(cleanText, message.channel.id, message.author.displayName ?? message.author.username);
    await message.reply(reply);
    return;
  }

  // ── Protected user defence (always on, no trash talk mode needed) ────────
  // Exception: if a protected user is the one talking shit at the bot, no protection
  if (isInsultAtProtected(text) && !PROTECTED_IDS.has(authorId)) {
    const exchanges = [];
    await fireComeback(message, guildId, exchanges, DEFENSE_POOL);
    return;
  }

  // ── Trash talk (requires mode to be on) ──────────────────────────────────────────
  if (!await getTrashTalk(guildId)) return;

  // Always store state in the map so mutations persist across messages
  if (!trashTalkState.has(guildId)) {
    trashTalkState.set(guildId, { active: false, lastPingMs: 0, timeout: null, exchanges: [], beefingWith: new Set() });
  }
  const state = trashTalkState.get(guildId);
  if (!state.beefingWith) state.beefingWith = new Set();
  if (!state.exchanges)   state.exchanges   = [];

  // Case 1: Bot mentioned with an insult → start beef, track this user
  if (botMentioned && INSULT_WORDS.some(w => lower.includes(w))) {
    state.active = true;
    state.lastPingMs = Date.now();
    state.beefingWith.add(authorId);
    if (state.timeout) { clearTimeout(state.timeout); state.timeout = null; }

    await fireComeback(message, guildId, state.exchanges);
    resetCooldown(state, guildId);
    trashTalkState.set(guildId, state);
    return;
  }

  // Case 2: Currently beefing — any message from a beefing user fires back
  // (no mention required — bot is watching them now)
  if (isFromBeefingUser(authorId, state)) {
    state.lastPingMs = Date.now();
    if (state.timeout) { clearTimeout(state.timeout); state.timeout = null; }
    trashTalkState.set(guildId, state);

    await fireComeback(message, guildId, state.exchanges);
    resetCooldown(state, guildId);
    trashTalkState.set(guildId, state);
    return;
  }

  // Case 3: Currently beefing — someone else mentions the bot → drag them in too
  if (state.active && botMentioned) {
    state.lastPingMs = Date.now();
    state.beefingWith.add(authorId);
    if (state.timeout) { clearTimeout(state.timeout); state.timeout = null; }
    trashTalkState.set(guildId, state);

    await fireComeback(message, guildId, state.exchanges);
    resetCooldown(state, guildId);
    trashTalkState.set(guildId, state);
  }
});

client.login(TOKEN);
