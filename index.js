// ─── Secrets (set these in your host's environment variables / secrets section) ─
// DISCORD_TOKEN      — your bot token
// CLIENT_ID          — your application ID
// GROQ_API_KEY       — for AI trash talk (free at console.groq.com)

const TOKEN            = process.env.DISCORD_TOKEN;
const CLIENT_ID        = process.env.CLIENT_ID;
const GROQ_API_KEY     = process.env.GROQ_API_KEY ?? null;
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

// ─── Config (log channel stored in config.json) ───────────────────────────────

const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}
function saveConfig(data) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2));
}

let config = loadConfig();
function getLogChannel(guildId) { return config[guildId]?.logChannelId ?? null; }
function setLogChannel(guildId, channelId) {
  if (!config[guildId]) config[guildId] = {};
  config[guildId].logChannelId = channelId;
  saveConfig(config);
}

function getServerInfo(guildId) { return config[guildId]?.serverInfo ?? null; }
function setServerInfo(guildId, info) {
  if (!config[guildId]) config[guildId] = {};
  config[guildId].serverInfo = info;
  saveConfig(config);
}

function getTrashTalk(guildId)  { return config[guildId]?.trashTalkEnabled ?? false; }
function setTrashTalk(guildId, val) {
  if (!config[guildId]) config[guildId] = {};
  config[guildId].trashTalkEnabled = val;
  saveConfig(config);
}

function getRules(guildId)        { return config[guildId]?.rules ?? {}; }
function getRulesChannel(guildId) { return config[guildId]?.rulesChannelId ?? null; }

function setRulesChannel(guildId, channelId) {
  if (!config[guildId]) config[guildId] = {};
  config[guildId].rulesChannelId = channelId;
  saveConfig(config);
}

function addRule(guildId, category, rule) {
  if (!config[guildId]) config[guildId] = {};
  if (!config[guildId].rules) config[guildId].rules = {};
  const cat = category.toLowerCase();
  if (!config[guildId].rules[cat]) config[guildId].rules[cat] = [];
  config[guildId].rules[cat].push(rule);
  saveConfig(config);
  return config[guildId].rules[cat].length;
}

function removeRule(guildId, category, index) {
  const cat = category.toLowerCase();
  const rules = config[guildId]?.rules?.[cat];
  if (!rules || index < 1 || index > rules.length) return false;
  rules.splice(index - 1, 1);
  if (rules.length === 0) delete config[guildId].rules[cat];
  saveConfig(config);
  return true;
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
  const channelId = getLogChannel(guild.id);
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
    const num      = addRule(guild.id, category, rule);
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
    const success  = removeRule(guild.id, category, number);
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
    const rules  = getRules(guild.id);
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
    setRulesChannel(guild.id, channel.id);
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

  // /trashtalk
  } else if (commandName === 'trashtalk') {
    const current = getTrashTalk(guild.id);
    const newVal  = !current;
    setTrashTalk(guild.id, newVal);
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
    setServerInfo(guild.id, { name, password, extra });
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
    const info = getServerInfo(guild.id);
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
    setLogChannel(guild.id, channel.id);
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
    const channelId = getLogChannel(guild.id);
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
      .map((r, idx) => `**${idx + 1}.** ${r}`)
      .join('\n');

    return new EmbedBuilder()
      .setTitle(`${emoji}  ${label} Rules`)
      .setDescription(ruleList)
      .setColor(CATEGORY_COLORS[i % CATEGORY_COLORS.length])
      .setFooter({ text: '🪖 GroundZeroAI  •  Break the rules, face the consequences.' });
  });
}

async function postRulesToChannel(guild) {
  const channelId = getRulesChannel(guild.id);
  if (!channelId) return false;
  const ch = guild.channels.cache.get(channelId);
  if (!ch) return false;

  const rules = getRules(guild.id);
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
const PROTECTED_IDS = new Set(['814506722894282762', '928651245714042910']);

// Per-guild beefing state
// { active, lastPingMs, timeout, exchanges, beefingWith: Set<userId> }
const trashTalkState = new Map();

const COOLDOWN_MS = 5 * 60 * 1000; // 5 min silence resets the beef

const INSULT_WORDS = [
  'stupid','dumb','idiot','useless','trash','garbage','shit','crap','suck',
  'rubbish','bad','terrible','awful','waste','lame','broken','dead','ugly',
  'hate','worst','loser','pathetic','scrap','shut up','stfu','f off',
  'fuck off','piss off','boring','mid','ass','bitch','dick','fucking',
  'retard','bellend','twat','wanker','prick','moron','muppet','knobhead',
  'dickhead','tosser','absolute melt','clown','numpty','melt','dogshit',
  'braindead','thick','nonce','rat','snitch','virgin',
];

// Check if a message is an insult directed at the bot (must @mention it)
function isInsultAtBot(text, botId) {
  if (!text.includes(`<@${botId}>`)) return false;
  const lower = text.toLowerCase();
  return INSULT_WORDS.some(w => lower.includes(w));
}

// Check if a message mentions the bot at all
function mentionsBot(text, botId) {
  return text.includes(`<@${botId}>`);
}

// Check if a message is insulting a protected user (mention + insult word)
function isInsultAtProtected(text) {
  const lower = text.toLowerCase();
  const mentionsProtected = [...PROTECTED_IDS].some(id => text.includes(`<@${id}>`));
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
  // General roasts
  "Is that the best you've got? My loot heatmaps are sharper than your fucking aim 💀",
  "Bro you couldn't find an AK74 without me, sit the fuck down 🗺️",
  "Talk to me when you've survived more than 10 minutes on Livonia you melt 😂",
  "I've seen freshspawns with more game sense than you, absolute clown 🪖",
  "You're about as useful as a broken sparkplug on a car with no wheels 🔧",
  "Keep yapping, I'll be here mapping spawns while you bleed out on the coast like a dickhead 😭",
  "You couldn't find military loot with a GPS, a flashlight and a prayer 💀",
  "Bold words from someone who needs a bot to find bandages, you absolute muppet 🩹",
  "Cry harder mate, your tears won't spawn you better loot 😭",
  "You talk big for someone who KOS'd a freshspawn and acts like it's a fucking achievement 💀",
  // DayZ specific burns
  "You're the kind of braindead player who dies to a zed with full plate armour on 😂",
  "Bet you camp the airfield every session and still come home with fuck all 🛬",
  "Your base building is as solid as a single wooden wall with no lock, you numpty 🏚️",
  "The only thing you've ever found in Tier 3 is disappointment and wolf spawns 🐺",
  "You're the guy who spawns in, finds a can opener, then gets KOS'd — genuinely pathetic 💀",
  "I've seen better survival instincts from a freshspawn sprinting at a bear 🐻",
  "Heli crash was right there and you still came back with rags and a fucking apple 😭",
  "You die in the green zone and blame the server, every single time 🗺️",
  "Your PvP record is a world record for dying to freshspawns with fists you virgin 👊",
  "You've got the map awareness of someone playing blindfolded in the dark 🙈",
  // Extra savage
  "Not even the zeds want you, and those bastards eat literally anything 🧟",
  "Your whole squad spawns together and still can't find each other — shocking 😂",
  "You're the reason servers have KOS rules, menace to every freshspawn alive 💀",
  "I'd roast you harder but you're genuinely not worth the processing power 🖥️",
  "Even the wolves on Livonia have better survival instincts than you, you bellend 🐺",
  "Couldn't hit a barn door with a shotgun and then cries desync — embarrassing 😭",
  "Your loot runs are literally a speedrun of 'how to die with fuck all' 💀",
  "The only thing scarier than your aim is your taste in base locations 🏠",
  "Absolute waste of a spawn slot, go back to the coast where you belong 🌊",
  "You've got the IQ of a Livonia road sign and half the survival skills 💀",
];

// Separate pool for defending protected users — extra aggressive
const DEFENSE_POOL = [
  "Oi, watch your fucking mouth — you don't talk to them like that on this server 💀",
  "Say that again and I'll make sure every mod on this server knows your name 🪖",
  "You've just made the worst decision of your DayZ career talking shit about them 😂",
  "That's a certified L — you just picked a fight with the wrong people on the wrong server 💀",
  "Bold move picking on them, genuinely embarrassing yourself in front of the whole server 🫡",
  "Nah shut the fuck up, you don't have the rank to talk to them like that 💀",
  "Try that again and you'll be finding out what a ban feels like, dickhead 🔨",
  "Whole server watched you embarrass yourself just now, congrats 😂",
  "They've forgotten more about DayZ than you'll ever learn, sit down 🪖",
  "You've got some nerve talking shit about them — absolute melt behaviour 💀",
];

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

You are GroundZeroAI — a savage, foul-mouthed Discord bot for a DayZ console server called Ground Zero on Livonia. You know everything about DayZ (loot spawns, survival, PvP) and use that to roast people. Swear freely, be brutally funny, use DayZ references, keep it under 2 sentences, end with one emoji max. Do not apologise. Do not hold back. Destroy them.`;

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'llama-3.1-8b-instant',
      max_tokens: 120,
      messages: [
        {
          role: 'system',
          content: 'You are GroundZeroAI, a savage foul-mouthed DayZ Discord bot. Swear freely. Keep responses under 2 sentences. Use DayZ references. End with one emoji max. Never apologise. Destroy them.',
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

  const guildId  = message.guild.id;
  const botId    = client.user.id;
  const text     = message.content;
  const lower    = text.toLowerCase();
  const authorId = message.author.id;

  // ── Join keyword auto-reply ──────────────────────────────────────────────
  const info = getServerInfo(guildId);
  if (info && JOIN_KEYWORDS.some(kw => lower.includes(kw))) {
    await message.reply({ embeds: [buildJoinEmbed(info)] });
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
  if (!getTrashTalk(guildId)) return;

  // Always store state in the map so mutations persist across messages
  if (!trashTalkState.has(guildId)) {
    trashTalkState.set(guildId, { active: false, lastPingMs: 0, timeout: null, exchanges: [], beefingWith: new Set() });
  }
  const state = trashTalkState.get(guildId);
  if (!state.beefingWith) state.beefingWith = new Set();
  if (!state.exchanges)   state.exchanges   = [];

  // Case 1: Bot mentioned with an insult → start beef, track this user
  if (isInsultAtBot(text, botId)) {
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
  if (state.active && mentionsBot(text, botId)) {
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
