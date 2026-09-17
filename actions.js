// ─── Shared Actions ─────────────────────────────────────────────────────────────
// Logic that needs the live Discord client, shared between the bot's slash
// commands (index.js) and the web dashboard (server.js) so both trigger the
// exact same behaviour instead of maintaining two copies.

const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const db = require('./db');

const GROQ_API_KEY = process.env.GROQ_API_KEY ?? null;

let client = null;
function setClient(c) { client = c; }

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

async function postRulesToChannel(guildId) {
  const guild = client?.guilds.cache.get(guildId);
  if (!guild) return false;

  const channelId = await db.getRulesChannel(guild.id);
  if (!channelId) return false;
  const ch = guild.channels.cache.get(channelId);
  if (!ch) return false;

  const rules = await db.getRules(guild.id);
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
    .setTitle('🎮  How to Join Our DayZ Server')
    .setColor(0x107C10) // Xbox green
    .setDescription(
      '> Welcome! Follow the steps below to get into the server.\n> If you still can\'t find it, ask a member for help.'
    )
    .addFields(fields)
    .setFooter({ text: '🪖 GroundZeroAI  •  Livonia (Enoch)' })
    .setTimestamp();
}

// ─── Giveaways ────────────────────────────────────────────────────────────────

async function endGiveaway(giveawayId) {
  const gw = await db.getGiveawayById(giveawayId);
  if (!gw || gw.ended) return false;

  const guild = client?.guilds.cache.get(gw.guild_id);
  if (!guild) return false;

  await db.markGiveawayEnded(gw);

  const entries = await db.getGiveawayEntries(giveawayId);
  const channel = guild.channels.cache.get(gw.channel_id);
  if (!channel) return true;

  let msg;
  try { msg = await channel.messages.fetch(gw.message_id); } catch {}

  if (entries.length === 0) {
    const noEntry = new EmbedBuilder()
      .setTitle('🎉  Giveaway Ended')
      .setColor(0x8B0000)
      .setDescription(`**${gw.prize}**\n\nNo one entered — no winner this time!`)
      .setFooter({ text: 'GroundZeroAI Giveaways' })
      .setTimestamp();
    if (msg) msg.edit({ embeds: [noEntry], components: [] }).catch(() => {});
    channel.send({ embeds: [noEntry] }).catch(() => {});
    return true;
  }

  const shuffled = entries.sort(() => Math.random() - 0.5);
  const winners = shuffled.slice(0, Math.min(gw.winner_count, shuffled.length));
  const winnerMentions = winners.map(id => `<@${id}>`).join(', ');

  const endEmbed = new EmbedBuilder()
    .setTitle('🎉  Giveaway Ended!')
    .setColor(0x57F287)
    .setDescription(`**Prize:** ${gw.prize}\n\n🏆 **Winner${winners.length > 1 ? 's' : ''}:** ${winnerMentions}`)
    .addFields({ name: 'Entries', value: `${entries.length}`, inline: true })
    .setFooter({ text: `Hosted by user ${gw.host_id}  •  GroundZeroAI` })
    .setTimestamp();

  if (msg) msg.edit({ embeds: [endEmbed], components: [] }).catch(() => {});
  channel.send({ content: `🎉 Congrats ${winnerMentions}! You won **${gw.prize}**!`, embeds: [endEmbed] }).catch(() => {});
  return true;
}

async function rerollGiveaway(giveawayId) {
  const gw = await db.getGiveawayById(giveawayId);
  if (!gw) return { ok: false, error: 'Giveaway not found.' };

  const entries = await db.getGiveawayEntries(giveawayId);
  if (entries.length === 0) return { ok: false, error: 'No entries to reroll.' };

  const shuffled = entries.sort(() => Math.random() - 0.5);
  const winners = shuffled.slice(0, Math.min(gw.winner_count, shuffled.length));
  const mentions = winners.map(id => `<@${id}>`).join(', ');

  const channel = client?.channels.cache.get(gw.channel_id);
  if (channel) {
    await channel.send(`🎉 **Reroll!** New winner${winners.length > 1 ? 's' : ''}: ${mentions}! Congrats on winning **${gw.prize}**!`).catch(() => {});
  }
  return { ok: true, winners };
}

// ─── Honeypot ─────────────────────────────────────────────────────────────────

async function postHoneypotWarning(guildId) {
  const guild = client?.guilds.cache.get(guildId);
  if (!guild) return false;
  const channelId = await db.getHoneypotChannel(guildId);
  if (!channelId) return false;
  const channel = guild.channels.cache.get(channelId);
  if (!channel) return false;

  const bannerPath = path.join(__dirname, 'warning_banner.png');
  const bannerExists = fs.existsSync(bannerPath);
  const warningEmbed = new EmbedBuilder()
    .setTitle('⛔  DO NOT TYPE IN THIS CHANNEL')
    .setColor(0xED4245)
    .setDescription('> **Do NOT send messages, images, or videos in this channel.**\n> Any activity here will result in an **automatic permanent ban**.\n> You have been warned.')
    .setFooter({ text: 'GroundZeroAI  •  Honeypot Trap' })
    .setTimestamp();

  const payload = { embeds: [warningEmbed] };
  if (bannerExists) {
    const attachment = new AttachmentBuilder(bannerPath, { name: 'warning_banner.png' });
    warningEmbed.setImage('attachment://warning_banner.png');
    payload.files = [attachment];
  }
  await channel.send(payload).catch(() => {});
  return true;
}

// ─── Create a giveaway from the dashboard ─────────────────────────────────────
// Mirrors the /giveaway slash command's posting logic, for use outside an interaction.

async function createGiveaway(guildId, channelId, prize, durationMins, winnerCount, hostId) {
  const guild = client?.guilds.cache.get(guildId);
  if (!guild) return { ok: false, error: "Bot isn't in that server." };
  const channel = guild.channels.cache.get(channelId);
  if (!channel) return { ok: false, error: 'Channel not found.' };

  const endsAt    = new Date(Date.now() + durationMins * 60 * 1000);
  const timestamp = Math.floor(endsAt.getTime() / 1000);

  const embed = new EmbedBuilder()
    .setTitle('🎉  GIVEAWAY')
    .setColor(0xFFD700)
    .setDescription(`**${prize}**\n\nReact with 🎉 to enter!`)
    .addFields(
      { name: '⏰ Ends',       value: `<t:${timestamp}:R>`, inline: true },
      { name: '🏆 Winners',    value: `${winnerCount}`,     inline: true },
      { name: '🎟️ Hosted by', value: `<@${hostId}>`,       inline: true },
    )
    .setFooter({ text: 'GroundZeroAI Giveaways  •  React 🎉 to enter' })
    .setTimestamp(endsAt);

  const msg = await channel.send({ embeds: [embed] });
  await msg.react('🎉').catch(() => {});

  const gw = await db.createGiveaway(guildId, channelId, prize, durationMins, winnerCount, hostId);
  if (gw) await db.sbRequest('POST', '/rest/v1/giveaways', { ...gw, message_id: msg.id });

  return { ok: true, messageId: msg.id };
}

// ─── AI Style Analysis (Groq) ─────────────────────────────────────────────────

async function generateStyleAnalysis(stats) {
  if (!GROQ_API_KEY || !stats.message_samples?.length) return null;

  const samples = stats.message_samples.slice(-20).join(' | ');
  const ha = stats.hourly_activity ?? {};
  const peakHour = Object.entries(ha).sort((a,b)=>b[1]-a[1])[0]?.[0];
  const peakLabel = peakHour ? `${peakHour}:00 UTC` : 'unknown';

  const prompt = `Analyse these Discord messages and return ONLY a JSON object with no extra text:

Messages: "${samples}"
Total messages: ${stats.message_count}
Peak activity: ${peakLabel}

Return this exact JSON structure:
{
  "vibe": "one of: Aggressive | Chill | Chaotic | Friendly | Quiet | Loud | Toxic | Helpful | Sarcastic | Mixed",
  "energy": "one of: High | Medium | Low",
  "helps_others": "one of: Often | Sometimes | Rarely | Never",
  "summary": "2 sentences max. Specific observations about their tone and how they communicate.",
  "red_flags": "one sentence or null if none. Any concerning patterns like aggression or toxicity.",
  "standout": "one short phrase describing what makes their style distinct"
}`;

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'openai/gpt-oss-20b',
      max_completion_tokens: 500,
      reasoning_effort: 'low',
      include_reasoning: false,
      messages: [
        { role: 'system', content: 'You are a Discord community analyst. Return only valid JSON, no markdown, no explanation.' },
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
          const text = p.choices?.[0]?.message?.content?.trim();
          const clean = text?.replace(/```json|```/g, '').trim();
          const parsed = JSON.parse(clean);
          resolve(parsed);
        } catch (err) {
          console.error(`Groq style analysis: failed (status ${res.statusCode}) — ${err.message} — ${data.slice(0, 300)}`);
          resolve(null);
        }
      });
    });
    req.on('error', (err) => { console.error(`Groq style analysis: request error — ${err.message}`); resolve(null); });
    req.setTimeout(8000, () => { req.destroy(); console.error('Groq style analysis: request timed out after 8s'); resolve(null); });
    req.write(body);
    req.end();
  });
}

// Fetches a player's stats and refreshes the AI style analysis if it's
// missing or stale (>24h). Shared by /stats and the dashboard's player view.
async function getOrRefreshStyleAnalysis(guildId, userId) {
  const stats = await db.getPlayerStats(guildId, userId);
  if (!stats || !stats.message_count) return { stats: null, analysis: null };

  let analysis = null;
  try { analysis = stats.style_summary ? JSON.parse(stats.style_summary) : null; } catch {}
  const summaryAge = stats.style_updated_at ? Date.now() - new Date(stats.style_updated_at).getTime() : Infinity;

  if ((!analysis || summaryAge > 24 * 60 * 60 * 1000) && stats.message_samples?.length > 3) {
    const fresh = await generateStyleAnalysis(stats);
    if (fresh) {
      analysis = fresh;
      await db.savePlayerStats({ ...stats, style_summary: JSON.stringify(fresh), style_updated_at: new Date().toISOString() });
    }
  }
  return { stats, analysis };
}

// ─── Warnings & auto-punishment ────────────────────────────────────────────────
// Shared by the /warn command and (in future) the dashboard, so the threshold
// check only lives in one place.

async function recordWarning(guild, member, moderatorId, reason) {
  await db.addWarning(guild.id, member.id, moderatorId, reason);
  const warnings = await db.getWarnings(guild.id, member.id);
  const cfg = await db.getWarnPunishConfig(guild.id);

  let punishment = null;
  if (cfg.threshold && cfg.punishment && warnings.length >= cfg.threshold) {
    try {
      if (cfg.punishment === 'mute' && member.moderatable) {
        await member.timeout(cfg.muteMinutes * 60 * 1000, `Auto-punish: reached ${cfg.threshold} warnings`);
        punishment = `muted for ${cfg.muteMinutes}m`;
      } else if (cfg.punishment === 'kick' && member.kickable) {
        await member.kick(`Auto-punish: reached ${cfg.threshold} warnings`);
        punishment = 'kicked';
      } else if (cfg.punishment === 'ban' && member.bannable) {
        await member.ban({ reason: `Auto-punish: reached ${cfg.threshold} warnings` });
        punishment = 'banned';
      }
    } catch (err) { console.error('Warn auto-punish failed:', err.message); }
  }
  return { count: warnings.length, punishment };
}

// ─── Purge ─────────────────────────────────────────────────────────────────────

async function purgeMessages(channel, amount, userId = null) {
  const capped = Math.min(Math.max(parseInt(amount, 10) || 0, 1), 100);
  const fetched = await channel.messages.fetch({ limit: userId ? 100 : capped });
  let toDelete = [...fetched.values()];
  if (userId) toDelete = toDelete.filter(m => m.author.id === userId);
  toDelete = toDelete.slice(0, capped);
  if (toDelete.length === 0) return 0;
  const deleted = await channel.bulkDelete(toDelete, true); // true = skip messages older than 14 days
  return deleted.size;
}

// ─── Slowmode / lock / unlock ──────────────────────────────────────────────────

async function setSlowmode(channel, seconds) {
  await channel.setRateLimitPerUser(Math.min(Math.max(seconds, 0), 21600));
}

async function lockChannel(channel, reason) {
  await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: false }, { reason });
}

async function unlockChannel(channel, reason) {
  await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: null }, { reason });
}

// ─── Softban & temp-ban ─────────────────────────────────────────────────────────

async function softban(guild, userId, reason) {
  await guild.members.ban(userId, { reason: `Softban: ${reason}`, deleteMessageSeconds: 7 * 24 * 60 * 60 });
  await guild.members.unban(userId, 'Softban — auto unban to allow rejoin').catch(() => {});
}

async function tempBan(guild, userId, reason, durationMins) {
  await guild.members.ban(userId, { reason: `Tempban (${durationMins}m): ${reason}` });
  const unbanAt = new Date(Date.now() + durationMins * 60 * 1000).toISOString();
  await db.addTempBan(guild.id, userId, unbanAt, reason);
}

// Sweeps expired temp-bans and unbans them. Called on an interval from index.js.
async function checkTempBans() {
  const due = await db.getDueTempBans();
  for (const tb of due) {
    const guild = client?.guilds.cache.get(tb.guild_id);
    if (guild) await guild.members.unban(tb.user_id, 'Temp-ban expired').catch(() => {});
    await db.removeTempBan(tb.id);
  }
}

module.exports = {
  setClient,
  buildRulesEmbeds, postRulesToChannel,
  buildJoinEmbed,
  postHoneypotWarning,
  createGiveaway, endGiveaway, rerollGiveaway,
  generateStyleAnalysis, getOrRefreshStyleAnalysis,
  recordWarning,
  purgeMessages, setSlowmode, lockChannel, unlockChannel,
  softban, tempBan, checkTempBans,
};
