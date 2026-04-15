// ─── Secrets (set these in your host's environment variables / secrets section) ─
// DISCORD_TOKEN    — your bot token
// CLIENT_ID        — your application ID

const TOKEN     = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

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
    `${CATEGORY_EMOJI[itemData.c] || '❓'}  ${prettyName(itemName)} — Spawn Heatmap  |  Livonia`,
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

// ─── Slash Command Definitions ────────────────────────────────────────────────

const commands = [
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

].map(c => c.toJSON());

// ─── Client ───────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
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
    .addFields(
      { name: 'User',      value: `${target.user.tag} (${target.id})`, inline: true },
      { name: 'Moderator', value: moderator.tag,                        inline: true },
      ...extra,
      { name: 'Reason',    value: reason },
    )
    .setTimestamp();
}

// ─── Command Handler ──────────────────────────────────────────────────────────

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, guild, user } = interaction;

  // /setlogchannel
  if (commandName === 'setlogchannel') {
    const channel = interaction.options.getChannel('channel');
    setLogChannel(guild.id, channel.id);
    const embed = new EmbedBuilder()
      .setTitle('✅ Log Channel Set')
      .setColor(Colors.Green)
      .setDescription(`Mod actions will now be logged in ${channel}.`)
      .setFooter({ text: `Set by ${user.tag}` })
      .setTimestamp();
    await interaction.reply({ embeds: [embed], ephemeral: true });
    channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('📋 Log Channel Activated')
          .setColor(Colors.Green)
          .setDescription(`This channel has been set as the mod log channel by ${user.tag}.`)
          .setTimestamp(),
      ],
    }).catch(() => {});

  // /logchannel
  } else if (commandName === 'logchannel') {
    const channelId = getLogChannel(guild.id);
    const embed = new EmbedBuilder().setColor(0x8B0000).setTimestamp();
    if (channelId) {
      const ch = guild.channels.cache.get(channelId);
      embed.setTitle('📋 Current Log Channel')
           .setDescription(ch ? `Logs are being sent to ${ch}.` : `Channel ID \`${channelId}\` is set but no longer exists. Use /setlogchannel to update it.`);
    } else {
      embed.setTitle('📋 No Log Channel Set')
           .setDescription('Use `/setlogchannel #channel` to configure one.');
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
            .setTitle('❌ Item not found')
            .setColor(Colors.Red)
            .setDescription(`No item matching **${query}** was found.\nUse the exact classname, e.g. \`AK74\`, \`BandageDressing\`, \`M4A1\`.`)
            .setFooter({ text: 'Search is case-insensitive' }),
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
            .setTitle(`🔍 Multiple matches for "${query}"`)
            .setColor(0x8B0000)
            .setDescription(results.map(r => `• \`${r.name}\``).join('\n'))
            .setFooter({ text: 'Try a more specific name' }),
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

    let rarity = '🟢 Common';
    if      (data.n < 5)  rarity = '🔴 Very Rare';
    else if (data.n < 20) rarity = '🟠 Rare';
    else if (data.n < 50) rarity = '🟡 Uncommon';

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
      .setColor(0x8B0000)
      .addFields(
        { name: 'Category',       value: data.c ? data.c.charAt(0).toUpperCase() + data.c.slice(1) : 'Unknown', inline: true },
        { name: 'Max in World',   value: `${data.n}`, inline: true },
        { name: 'Rarity',         value: rarity,      inline: true },
        { name: 'Spawn Zones',    value: tierStr,      inline: false },
        { name: 'Location Types', value: usageStr,     inline: false },
      )
      .setFooter({ text: `Classname: ${name}  •  Livonia (Enoch)` })
      .setTimestamp();

    if (tierLines.length > 0) {
      embed.addFields({ name: '📍 Spawn Slots by Zone', value: tierLines.join('\n') });
    }

    if (attachment) {
      embed.setImage(`attachment://loot_${name}.jpg`);
      await interaction.editReply({ embeds: [embed], files: [attachment] });
    } else {
      await interaction.editReply({ embeds: [embed] });
    }

  // /ping
  } else if (commandName === 'ping') {
    await interaction.reply({ content: `🏓 Pong! Latency: **${client.ws.ping}ms**`, ephemeral: true });

  // /roll
  } else if (commandName === 'roll') {
    const sides  = interaction.options.getInteger('sides') ?? 6;
    const result = Math.floor(Math.random() * sides) + 1;
    await interaction.reply(`🎲 **${user.username}** rolled a **${result}** (d${sides})`);

  // /tips
  } else if (commandName === 'tips') {
    const embed = new EmbedBuilder()
      .setTitle('📚 DayZ Console — Tip Categories')
      .setColor(0x8B0000)
      .setDescription(
        Object.keys(tips)
          .map(k => `• **${k.charAt(0).toUpperCase() + k.slice(1)}** — ${tips[k].length} tips`)
          .join('\n')
      )
      .setFooter({ text: 'Use /tip [category] to get a tip from a specific category' });
    await interaction.reply({ embeds: [embed] });

  // /tip
  } else if (commandName === 'tip') {
    const category = interaction.options.getString('category');
    const pool     = category ? tips[category] : allTips;
    const tip      = pool[Math.floor(Math.random() * pool.length)];
    const label    = category ? category.charAt(0).toUpperCase() + category.slice(1) : 'Random';
    const embed = new EmbedBuilder()
      .setTitle(`💡 DayZ Tip — ${label}`)
      .setDescription(tip)
      .setColor(0x8B0000)
      .setFooter({ text: 'Use /tips to see all categories' });
    await interaction.reply({ embeds: [embed] });

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
        .setTitle('🔊 Member Unmuted')
        .setColor(Colors.Green)
        .addFields(
          { name: 'User',      value: `${target.user.tag} (${target.id})`, inline: true },
          { name: 'Moderator', value: user.tag,                             inline: true },
        )
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
          .setTitle('⚠️ You have received a warning')
          .setColor(Colors.Yellow)
          .addFields(
            { name: 'Server', value: guild.name, inline: true },
            { name: 'Reason', value: reason },
          )
          .setTimestamp(),
      ],
    }).catch(() => {});
  }
});

client.login(TOKEN);
