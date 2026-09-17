// ─── Shared Actions ─────────────────────────────────────────────────────────────
// Logic that needs the live Discord client, shared between the bot's slash
// commands (index.js) and the web dashboard (server.js) so both trigger the
// exact same behaviour instead of maintaining two copies.

const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const db = require('./db');
const dayzFtp = require('./ftp');

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

// ─── Economy ────────────────────────────────────────────────────────────────

async function payUser(guildId, fromUserId, toUserId, amount) {
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Amount must be a positive number.' };
  if (fromUserId === toUserId) return { ok: false, error: "You can't pay yourself." };
  const balance = await db.getBalance(guildId, fromUserId);
  if (balance < amount) return { ok: false, error: `Insufficient balance (you have ${balance}).` };
  await db.adjustBalance(guildId, fromUserId, -amount);
  await db.adjustBalance(guildId, toUserId, amount);
  await db.recordTransaction(guildId, { fromUserId, toUserId, amount, type: 'pay' });
  return { ok: true };
}

async function adminAdjustBalance(guildId, userId, amount, moderatorId, reason) {
  const newBalance = await db.adjustBalance(guildId, userId, amount);
  await db.recordTransaction(guildId, { fromUserId: moderatorId, toUserId: userId, amount, type: amount >= 0 ? 'admin_grant' : 'admin_remove', reason });
  return newBalance;
}

async function creditEarning(guildId, userId, amount, type) {
  if (amount <= 0) return;
  await db.adjustBalance(guildId, userId, amount);
  await db.recordTransaction(guildId, { toUserId: userId, amount, type });
}

// ─── Linking (Discord <-> in-game name, verified via the ADM log) ─────────────

// Checks the last few ADM logs (not just the current one) for a connect event
// matching this exact name, so someone who played yesterday still counts.
async function findPlayerInLogs(profilesPath, ign) {
  const entries = await dayzFtp.listDir(profilesPath);
  const admFiles = entries
    .filter(e => !e.isDirectory && /\.adm$/i.test(e.name))
    .sort((a, b) => (b.modifiedAt ? new Date(b.modifiedAt) : 0) - (a.modifiedAt ? new Date(a.modifiedAt) : 0))
    .slice(0, 3);
  const target = ign.toLowerCase();
  for (const file of admFiles) {
    const filePath = profilesPath.replace(/\/$/, '') + '/' + file.name;
    const { text } = await dayzFtp.readTextFull(filePath, 2_000_000);
    const events = dayzFtp.parseAdmLog(text);
    if (events.some(e => e.type === 'connect' && e.match?.[0]?.toLowerCase() === target)) return true;
  }
  return false;
}

async function linkPlayer(guildId, userId, ign) {
  const existing = await db.getLinkByUser(guildId, userId);
  if (existing) return { ok: false, error: `You're already linked to **${existing.ign}** — use /unlink first if that's wrong.` };

  const claimedBy = await db.getLinkByIgn(guildId, ign);
  if (claimedBy) return { ok: false, error: 'That username is already linked to someone else.' };

  const profilesPath = await db.getDayzProfilesPath(guildId);
  if (!profilesPath || !dayzFtp.isConfigured()) {
    return { ok: false, error: 'Server linking is not set up yet — an admin needs to configure FTP and a profiles path first.' };
  }

  let found;
  try {
    found = await findPlayerInLogs(profilesPath, ign);
  } catch (err) {
    console.error('linkPlayer: FTP lookup failed —', err.message);
    return { ok: false, error: `Couldn't reach the game server right now (${err.message}). Try again shortly.` };
  }
  if (!found) return { ok: false, error: `Couldn't find "${ign}" in recent server activity. Please play for at least 5 minutes, then try again.` };

  await db.createLink(guildId, userId, ign);
  return { ok: true };
}

async function unlinkPlayer(guildId, userId) {
  await db.removeLink(guildId, userId);
}

// ─── DayZ activity poller (economy earnings + killfeed) ───────────────────────
// Combines two features off one shared log scan: crediting kills/playtime to
// linked players, and posting every PvP kill to a killfeed channel regardless
// of linking. Runs on an interval from index.js, once per guild.

function timeToday(hhmmss) {
  if (!hhmmss) return new Date().toISOString();
  const now = new Date();
  const [h, m, s] = hhmmss.split(':').map(Number);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m, s)).toISOString();
}

async function scanDayzActivity(guildId) {
  if (!dayzFtp.isConfigured()) return;
  const profilesPath = await db.getDayzProfilesPath(guildId);
  if (!profilesPath) return;

  const latestLogPath = await dayzFtp.findLatestAdmLog(profilesPath);
  if (!latestLogPath) return;

  const state = await db.getDayzScanState(guildId);
  if (state.log !== latestLogPath) {
    // First time seeing this log (fresh setup, or the server restarted and
    // rotated to a new file) — start watching from here on, don't backfill.
    const size = await dayzFtp.getFileSize(latestLogPath);
    await db.setDayzScanState(guildId, latestLogPath, size);
    return;
  }

  const { text, newOffset } = await dayzFtp.readFrom(latestLogPath, state.offset);
  if (!text) return;

  const events = dayzFtp.parseAdmLog(text);
  if (events.length === 0) { await db.setDayzScanState(guildId, latestLogPath, newOffset); return; }

  const econCfg = await db.getEconomyConfig(guildId);
  const openSessions = await db.getOpenSessions(guildId);
  const killfeedChannelId = await db.getKillfeedChannel(guildId);
  const guild = client?.guilds.cache.get(guildId);
  const killfeedChannel = killfeedChannelId && guild ? guild.channels.cache.get(killfeedChannelId) : null;

  for (const event of events) {
    if (event.type === 'connect' && event.match?.[0]) {
      openSessions[event.match[0]] = timeToday(event.time);
    } else if (event.type === 'disconnect' && event.match?.[0]) {
      const name = event.match[0];
      const startedAt = openSessions[name];
      if (startedAt) {
        delete openSessions[name];
        const minutes = Math.min(Math.max((new Date(timeToday(event.time)) - new Date(startedAt)) / 60000, 0), 720); // cap 12h, floor 0
        if (minutes >= 1) {
          const link = await db.getLinkByIgn(guildId, name);
          const reward = Math.floor(minutes / 10) * econCfg.playtimeRate;
          if (link && reward > 0) await creditEarning(guildId, link.user_id, reward, 'earn_playtime');
        }
      }
    }

    const kill = dayzFtp.extractFatalKill(event.raw);
    if (kill) {
      if (killfeedChannel) {
        const embed = new EmbedBuilder()
          .setColor(0xED4245)
          .setDescription(`💀 **${kill.killer}** killed **${kill.victim}**${kill.weapon ? ` with ${kill.weapon}` : ''}${kill.distance ? ` from ${kill.distance}m` : ''}`)
          .setTimestamp();
        killfeedChannel.send({ embeds: [embed] }).catch(() => {});
      }
      if (econCfg.killReward > 0) {
        const killerLink = await db.getLinkByIgn(guildId, kill.killer);
        if (killerLink) await creditEarning(guildId, killerLink.user_id, econCfg.killReward, 'earn_kill');
      }
    }
  }

  await db.setOpenSessions(guildId, openSessions);
  await db.setDayzScanState(guildId, latestLogPath, newOffset);
}

async function scanAllDayzActivity() {
  if (!client) return;
  for (const guild of client.guilds.cache.values()) {
    try { await scanDayzActivity(guild.id); }
    catch (err) { console.error(`scanDayzActivity failed for guild ${guild.id} —`, err.message); }
  }
}

// ─── Economy minigames ──────────────────────────────────────────────────────

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

async function checkCooldown(guildId, userId, command, cooldownSec) {
  const last = await db.getCooldown(guildId, userId, command);
  if (!last) return { ready: true, remainingSec: 0 };
  const elapsed = (Date.now() - last.getTime()) / 1000;
  if (elapsed >= cooldownSec) return { ready: true, remainingSec: 0 };
  return { ready: false, remainingSec: Math.ceil(cooldownSec - elapsed) };
}

const WORK_FLAVOR = [
  'You worked a shift scavenging scrap around the coast',
  'You helped patch up the base fences',
  'You ran supplies between camps',
  'You skinned and sold a haul of fresh meat',
  'You guided a fresh spawn to safety for a tip',
  'You spent the day fixing up a beat-up vehicle',
  'You stood watch on the wall for a few hours',
  'You sorted loot at the trader for some spare change',
  'You hauled water from the well all morning',
  'You chopped firewood for the whole camp',
];

async function doWork(guildId, userId) {
  const cfg = await db.getWorkConfig(guildId);
  const cd = await checkCooldown(guildId, userId, 'work', cfg.cooldownSec);
  if (!cd.ready) return { ok: false, remainingSec: cd.remainingSec };

  const amount = randInt(cfg.min, cfg.max);
  await db.setCooldown(guildId, userId, 'work');
  await creditEarning(guildId, userId, amount, 'earn_work');
  const flavor = WORK_FLAVOR[Math.floor(Math.random() * WORK_FLAVOR.length)];
  return { ok: true, amount, flavor };
}

const RISKY_FLAVOR = {
  crime: {
    success: [
      'You raided an abandoned stash and got away clean',
      'You picked a lock on a stocked container without anyone noticing',
      'You jumped an unarmed player and looted their bag',
      'You hotwired an unattended vehicle and stripped it for parts',
      'You snuck past a group and lifted supplies from their camp',
    ],
    fail: [
      'You got spotted mid-raid and had to bail, losing gear in the process',
      'You tripped an alarm and had to pay to keep it quiet',
      'You picked a fight with the wrong person and got cleaned out',
      'Your hotwire attempt set off the car alarm and drew a crowd',
      'You got caught red-handed and had to buy your way out of trouble',
    ],
  },
  slut: {
    success: [
      'You charmed your way into someone\'s wallet',
      'You flirted your way past a trader for a discount and flipped the difference',
      'Someone paid well for the company on a long trek',
      'You talked your way into a free ride and pocketed the fare instead',
      'Your charm offensive on the radio actually worked, for once',
    ],
    fail: [
      'Your advances got rejected hard, and it cost you',
      'You got laughed out of the trade and lost some pride and Scrap',
      'That flirting attempt backfired spectacularly',
      'You misjudged the room badly and had to pay to leave',
      'Nobody was buying what you were selling today',
    ],
  },
};

async function doRisky(guildId, userId, command) {
  const cfg = await db.getRiskyConfig(guildId);
  const cd = await checkCooldown(guildId, userId, command, cfg.cooldownSec);
  if (!cd.ready) return { ok: false, remainingSec: cd.remainingSec };

  await db.setCooldown(guildId, userId, command);
  const pool = RISKY_FLAVOR[command];
  const success = Math.random() < cfg.successChance;

  if (success) {
    const amount = randInt(cfg.min, cfg.max);
    await creditEarning(guildId, userId, amount, `earn_${command}`);
    return { ok: true, success: true, amount, flavor: pool.success[Math.floor(Math.random() * pool.success.length)] };
  }
  const penalty = randInt(cfg.failMin, cfg.failMax);
  const balance = await db.getBalance(guildId, userId);
  const actualLoss = Math.min(penalty, balance);
  if (actualLoss > 0) {
    await db.adjustBalance(guildId, userId, -actualLoss);
    await db.recordTransaction(guildId, { toUserId: userId, amount: -actualLoss, type: `fail_${command}` });
  }
  return { ok: true, success: false, amount: actualLoss, flavor: pool.fail[Math.floor(Math.random() * pool.fail.length)] };
}

// ─── Slots ───────────────────────────────────────────────────────────────────

const SLOT_SYMBOLS = [
  { symbol: '🍒', weight: 40, multiplier: 3 },
  { symbol: '🍋', weight: 30, multiplier: 4 },
  { symbol: '🍇', weight: 18, multiplier: 6 },
  { symbol: '🔔', weight: 8,  multiplier: 10 },
  { symbol: '💎', weight: 3,  multiplier: 20 },
  { symbol: '7️⃣', weight: 1,  multiplier: 50 },
];
const SLOT_TOTAL_WEIGHT = SLOT_SYMBOLS.reduce((sum, s) => sum + s.weight, 0);

function spinReel() {
  let roll = Math.random() * SLOT_TOTAL_WEIGHT;
  for (const s of SLOT_SYMBOLS) {
    if (roll < s.weight) return s;
    roll -= s.weight;
  }
  return SLOT_SYMBOLS[0];
}

async function playSlots(guildId, userId, bet) {
  const cfg = await db.getGamblingConfig(guildId);
  if (bet < cfg.slotsMinBet || bet > cfg.slotsMaxBet) {
    return { ok: false, error: `Bet must be between ${cfg.slotsMinBet} and ${cfg.slotsMaxBet}.` };
  }
  const balance = await db.getBalance(guildId, userId);
  if (balance < bet) return { ok: false, error: `Insufficient balance (you have ${balance}).` };

  const reels = [spinReel(), spinReel(), spinReel()];
  let payout = 0;
  if (reels[0].symbol === reels[1].symbol && reels[1].symbol === reels[2].symbol) {
    payout = bet * reels[0].multiplier;
  } else if (reels[0].symbol === reels[1].symbol || reels[1].symbol === reels[2].symbol || reels[0].symbol === reels[2].symbol) {
    payout = bet; // break even on any pair
  }

  const net = payout - bet;
  if (net !== 0) await db.adjustBalance(guildId, userId, net);
  if (net !== 0) await db.recordTransaction(guildId, { toUserId: userId, amount: net, type: 'slots' });

  return { ok: true, reels: reels.map(r => r.symbol), payout, net };
}

// ─── Blackjack (pure game logic — interactive wiring lives in index.js) ───────

function newDeck() {
  const suits = ['♠', '♥', '♦', '♣'];
  const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const deck = [];
  for (const suit of suits) for (const rank of ranks) deck.push({ rank, suit });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardValue(card) {
  if (card.rank === 'A') return 11;
  if (card.rank === 'J' || card.rank === 'Q' || card.rank === 'K') return 10;
  return parseInt(card.rank, 10);
}

function handValue(hand) {
  let total = hand.reduce((sum, c) => sum + cardValue(c), 0);
  let aces = hand.filter(c => c.rank === 'A').length;
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function formatHand(hand) {
  return hand.map(c => `${c.rank}${c.suit}`).join(' ');
}

async function validateBlackjackBet(guildId, userId, bet) {
  const cfg = await db.getGamblingConfig(guildId);
  if (bet < cfg.blackjackMinBet || bet > cfg.blackjackMaxBet) {
    return { ok: false, error: `Bet must be between ${cfg.blackjackMinBet} and ${cfg.blackjackMaxBet}.` };
  }
  const balance = await db.getBalance(guildId, userId);
  if (balance < bet) return { ok: false, error: `Insufficient balance (you have ${balance}).` };
  return { ok: true };
}

// Settles a finished blackjack hand: pays out and records the transaction.
// outcome: 'blackjack' (3:2), 'win' (1:1), 'push' (bet returned), 'lose' (bet forfeited, already deducted at deal time).
async function settleBlackjack(guildId, userId, bet, outcome) {
  let payout = 0;
  if (outcome === 'blackjack') payout = bet + Math.floor(bet * 1.5);
  else if (outcome === 'win') payout = bet * 2;
  else if (outcome === 'push') payout = bet;
  // 'lose' -> payout stays 0, bet was already taken when the hand was dealt

  if (payout > 0) {
    await db.adjustBalance(guildId, userId, payout);
    await db.recordTransaction(guildId, { toUserId: userId, amount: payout, type: `blackjack_${outcome}` });
  } else {
    await db.recordTransaction(guildId, { toUserId: userId, amount: 0, type: `blackjack_${outcome}` });
  }
  return payout;
}

// ─── Cash / Bank (deposit, withdraw, rob) ──────────────────────────────────────

async function depositMoney(guildId, userId, amount) {
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Amount must be a positive number.' };
  const cash = await db.getBalance(guildId, userId);
  if (cash < amount) return { ok: false, error: `You only have ${cash.toLocaleString()} cash.` };
  await db.adjustBalance(guildId, userId, -amount);
  const newBank = await db.adjustBankBalance(guildId, userId, amount);
  await db.recordTransaction(guildId, { toUserId: userId, amount, type: 'deposit' });
  return { ok: true, newBank };
}

async function withdrawMoney(guildId, userId, amount) {
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Amount must be a positive number.' };
  const bank = await db.getBankBalance(guildId, userId);
  if (bank < amount) return { ok: false, error: `You only have ${bank.toLocaleString()} in the bank.` };
  await db.adjustBankBalance(guildId, userId, -amount);
  const newCash = await db.adjustBalance(guildId, userId, amount);
  await db.recordTransaction(guildId, { toUserId: userId, amount, type: 'withdraw' });
  return { ok: true, newCash };
}

async function robPlayer(guildId, robberId, targetId) {
  if (robberId === targetId) return { ok: false, error: "You can't rob yourself." };

  const cfg = await db.getRobConfig(guildId);
  const cd = await checkCooldown(guildId, robberId, 'rob', cfg.cooldownSec);
  if (!cd.ready) return { ok: false, remainingSec: cd.remainingSec };

  const targetCash = await db.getBalance(guildId, targetId);
  if (targetCash < cfg.minTargetCash) {
    return { ok: false, error: `They don't have enough cash on hand to rob (need at least ${cfg.minTargetCash.toLocaleString()} — money in the bank is safe).` };
  }

  await db.setCooldown(guildId, robberId, 'rob');
  const success = Math.random() < cfg.successChance;

  if (success) {
    const pct = cfg.minPercent + Math.random() * (cfg.maxPercent - cfg.minPercent);
    const amount = Math.max(1, Math.floor(targetCash * pct));
    await db.adjustBalance(guildId, targetId, -amount);
    await db.adjustBalance(guildId, robberId, amount);
    await db.recordTransaction(guildId, { fromUserId: targetId, toUserId: robberId, amount, type: 'rob_success' });
    return { ok: true, success: true, amount };
  }

  const robberCash = await db.getBalance(guildId, robberId);
  const penalty = Math.min(robberCash, Math.floor(robberCash * cfg.failPenaltyPercent));
  if (penalty > 0) {
    await db.adjustBalance(guildId, robberId, -penalty);
    await db.recordTransaction(guildId, { toUserId: robberId, amount: -penalty, type: 'rob_fail' });
  }
  return { ok: true, success: false, penalty };
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
  payUser, adminAdjustBalance, creditEarning,
  linkPlayer, unlinkPlayer,
  scanDayzActivity, scanAllDayzActivity,
  doWork, doRisky,
  playSlots,
  newDeck, handValue, formatHand, validateBlackjackBet, settleBlackjack,
  depositMoney, withdrawMoney, robPlayer,
};
