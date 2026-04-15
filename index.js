require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials,
  REST, Routes, SlashCommandBuilder,
  PermissionFlagsBits, EmbedBuilder, Colors,
} = require('discord.js');

const TOKEN        = process.env.DISCORD_TOKEN;
const CLIENT_ID    = process.env.CLIENT_ID;
const LOG_CHANNEL  = process.env.LOG_CHANNEL_ID; // optional

// ─── DayZ Console Tips ────────────────────────────────────────────────────────

const tips = {
  beginner: [
    'Spawn on the coast — find a town name sign to figure out where you are. Use the iZurvive app (free) to navigate.',
    'Prioritise food, water and a backpack in your first 10 minutes — everything else comes second.',
    'Never carry all your valuables on you. Stash a backup kit in the world somewhere.',
    'You can split stacks (ammo, rags, food) in your inventory by holding the item.',
    'Running into the forest when you hear shots is almost always the right call as a freshspawn.',
    'Freshspawns are generally not worth engaging — most experienced players will leave you alone.',
    'Use a less-populated server to learn the map before jumping into high-pop servers.',
    'Crouch and walk when inside buildings — sprinting makes noise that carries through walls.',
  ],
  survival: [
    'Wet + cold = sick fast. Dry off near a campfire and swap wet clothes as soon as possible.',
    'Drink from town wells, not ponds — pond water causes illness without purification tablets.',
    'Eat before the starving icon appears — energy loss reduces your sprint stamina noticeably.',
    'White/green berries are safe to eat. Red berries will poison you.',
    'A raincoat keeps you dry but offers no warmth. Layer up in cold weather zones.',
    'Always keep rags in your hotbar — you can stop bleeding instantly without opening inventory.',
    'A campfire (sticks + rag/paper + match) can save your life in a storm or snow zone.',
    'Burlap sack + net + knife = improvised ghillie suit. Huge stealth advantage in forests.',
  ],
  medical: [
    'Bleeding kills faster than most new players expect. Always carry at least 4 rags.',
    'Saline IV bags restore blood volume faster than eating and drinking alone.',
    'Broken bones require a splint (2 sticks + 1 rag) — without one you limp permanently.',
    'Morphine auto-injectors instantly fix broken legs and remove the limp debuff.',
    'Charcoal tablets cure chemical/food poisoning. Tetracycline cures bacterial infections — know the difference.',
    'Blood bags need to match your blood type or you will suffer a transfusion reaction.',
    'Unconsciousness from blood loss is survivable if another player gives you a saline/blood bag in time.',
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
    'Bury small stashes (stone/wooden) deep in the forest as hidden backup storage.',
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
  console.log(`✅ Logged in as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('✅ Slash commands registered globally.');
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function sendLog(guild, embed) {
  if (!LOG_CHANNEL) return;
  const ch = guild.channels.cache.get(LOG_CHANNEL);
  if (ch) ch.send({ embeds: [embed] }).catch(() => {});
}

function modEmbed(title, color, target, moderator, reason, extra = []) {
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .addFields(
      { name: 'User', value: `${target.user.tag} (${target.id})`, inline: true },
      { name: 'Moderator', value: moderator.tag, inline: true },
      ...extra,
      { name: 'Reason', value: reason },
    )
    .setTimestamp();
}

// ─── Command Handler ──────────────────────────────────────────────────────────

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, guild, user } = interaction;

  // ── /ping ──────────────────────────────────────────────────────────────────
  if (commandName === 'ping') {
    await interaction.reply({ content: `🏓 Pong! Latency: **${client.ws.ping}ms**`, ephemeral: true });

  // ── /roll ──────────────────────────────────────────────────────────────────
  } else if (commandName === 'roll') {
    const sides = interaction.options.getInteger('sides') ?? 6;
    const result = Math.floor(Math.random() * sides) + 1;
    await interaction.reply(`🎲 **${user.username}** rolled a **${result}** (d${sides})`);

  // ── /tips ──────────────────────────────────────────────────────────────────
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

  // ── /tip ───────────────────────────────────────────────────────────────────
  } else if (commandName === 'tip') {
    const category = interaction.options.getString('category');
    const pool     = category ? tips[category] : allTips;
    const tip      = pool[Math.floor(Math.random() * pool.length)];
    const label    = category
      ? category.charAt(0).toUpperCase() + category.slice(1)
      : 'Random';
    const embed = new EmbedBuilder()
      .setTitle(`💡 DayZ Tip — ${label}`)
      .setDescription(tip)
      .setColor(0x8B0000)
      .setFooter({ text: 'Use /tips to see all categories' });
    await interaction.reply({ embeds: [embed] });

  // ── /kick ──────────────────────────────────────────────────────────────────
  } else if (commandName === 'kick') {
    const target = interaction.options.getMember('user');
    const reason = interaction.options.getString('reason') ?? 'No reason provided';
    if (!target)           return interaction.reply({ content: 'Member not found.', ephemeral: true });
    if (!target.kickable)  return interaction.reply({ content: 'I cannot kick that member.', ephemeral: true });
    try {
      await target.kick(reason);
      const embed = modEmbed('👢 Member Kicked', Colors.Orange, target, user, reason);
      await interaction.reply({ embeds: [embed] });
      await sendLog(guild, embed);
    } catch (e) {
      await interaction.reply({ content: `Failed: ${e.message}`, ephemeral: true });
    }

  // ── /ban ───────────────────────────────────────────────────────────────────
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

  // ── /mute ──────────────────────────────────────────────────────────────────
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

  // ── /unmute ────────────────────────────────────────────────────────────────
  } else if (commandName === 'unmute') {
    const target = interaction.options.getMember('user');
    if (!target) return interaction.reply({ content: 'Member not found.', ephemeral: true });
    try {
      await target.timeout(null);
      const embed = new EmbedBuilder()
        .setTitle('🔊 Member Unmuted')
        .setColor(Colors.Green)
        .addFields(
          { name: 'User', value: `${target.user.tag} (${target.id})`, inline: true },
          { name: 'Moderator', value: user.tag, inline: true },
        )
        .setTimestamp();
      await interaction.reply({ embeds: [embed] });
      await sendLog(guild, embed);
    } catch (e) {
      await interaction.reply({ content: `Failed: ${e.message}`, ephemeral: true });
    }

  // ── /warn ──────────────────────────────────────────────────────────────────
  } else if (commandName === 'warn') {
    const target = interaction.options.getMember('user');
    const reason = interaction.options.getString('reason');
    if (!target) return interaction.reply({ content: 'Member not found.', ephemeral: true });
    const embed = modEmbed('⚠️ Member Warned', Colors.Yellow, target, user, reason);
    await interaction.reply({ embeds: [embed] });
    await sendLog(guild, embed);
    // DM the warned user
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
    }).catch(() => {}); // silently fail if DMs are closed
  }
});

client.login(TOKEN);
