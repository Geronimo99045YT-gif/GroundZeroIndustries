// ─── Data Layer (Supabase) ─────────────────────────────────────────────────────
// Shared by the bot (index.js) and the dashboard (server.js).
// Falls back to an in-memory store for guild rules if Supabase is not configured.

const https = require('https');

const SUPABASE_URL = process.env.SUPABASE_URL ?? null;
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? null;

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

async function getTargetRole(guildId)    { return (await getGuildConfig(guildId)).target_role_id     ?? null; }
async function setTargetRole(guildId, v) { await saveGuildConfig(guildId, { target_role_id: v }); }

async function getWelcomeChannel(guildId)    { return (await getGuildConfig(guildId)).welcome_channel_id ?? null; }
async function setWelcomeChannel(guildId, v) { await saveGuildConfig(guildId, { welcome_channel_id: v }); }

async function getWelcomeMessage(guildId)    { return (await getGuildConfig(guildId)).welcome_message ?? null; }
async function setWelcomeMessage(guildId, v) { await saveGuildConfig(guildId, { welcome_message: v }); }

async function getAutoRole(guildId)    { return (await getGuildConfig(guildId)).auto_role_id ?? null; }
async function setAutoRole(guildId, v) { await saveGuildConfig(guildId, { auto_role_id: v }); }

async function getReportsChannel(guildId)    { return (await getGuildConfig(guildId)).reports_channel_id ?? null; }
async function setReportsChannel(guildId, v) { await saveGuildConfig(guildId, { reports_channel_id: v }); }

async function getHoneypotChannel(guildId)    { return (await getGuildConfig(guildId)).honeypot_channel_id ?? null; }
async function setHoneypotChannel(guildId, v) { await saveGuildConfig(guildId, { honeypot_channel_id: v }); }

async function getDayzProfilesPath(guildId)    { return (await getGuildConfig(guildId)).dayz_profiles_path ?? null; }
async function setDayzProfilesPath(guildId, v) { await saveGuildConfig(guildId, { dayz_profiles_path: v }); }

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

// ─── Warnings ──────────────────────────────────────────────────────────────────

async function addWarning(guildId, userId, moderatorId, reason) {
  return sbRequest('POST', '/rest/v1/warnings', { guild_id: guildId, user_id: userId, moderator_id: moderatorId, reason });
}

async function getWarnings(guildId, userId) {
  const rows = await sbRequest('GET', `/rest/v1/warnings?guild_id=eq.${guildId}&user_id=eq.${userId}&order=created_at.desc`);
  return Array.isArray(rows) ? rows : [];
}

async function removeWarning(id, guildId) {
  return sbRequest('DELETE', `/rest/v1/warnings?id=eq.${id}&guild_id=eq.${guildId}`);
}

async function getWarnPunishConfig(guildId) {
  const c = await getGuildConfig(guildId);
  return { threshold: c.warn_threshold ?? null, punishment: c.warn_punishment ?? null, muteMinutes: c.warn_mute_minutes ?? 60 };
}

async function setWarnPunishConfig(guildId, { threshold, punishment, muteMinutes }) {
  await saveGuildConfig(guildId, { warn_threshold: threshold, warn_punishment: punishment, warn_mute_minutes: muteMinutes });
}

// ─── Automod config ──────────────────────────────────────────────────────────

async function getAutomodConfig(guildId) {
  const c = await getGuildConfig(guildId);
  return {
    bannedWords: c.automod_banned_words ? c.automod_banned_words.split(',').map(w => w.trim()).filter(Boolean) : [],
    blockInvites: c.automod_block_invites ?? false,
    maxMentions: c.automod_max_mentions ?? null,
    blockCaps: c.automod_block_caps ?? false,
  };
}

async function setAutomodConfig(guildId, updates) {
  const patch = {};
  if ('bannedWords' in updates) patch.automod_banned_words = updates.bannedWords.join(',');
  if ('blockInvites' in updates) patch.automod_block_invites = updates.blockInvites;
  if ('maxMentions' in updates) patch.automod_max_mentions = updates.maxMentions;
  if ('blockCaps' in updates) patch.automod_block_caps = updates.blockCaps;
  await saveGuildConfig(guildId, patch);
}

// ─── Temp-bans ─────────────────────────────────────────────────────────────────

async function addTempBan(guildId, userId, unbanAt, reason) {
  return sbRequest('POST', '/rest/v1/temp_bans', { guild_id: guildId, user_id: userId, unban_at: unbanAt, reason });
}

async function getDueTempBans() {
  const now = new Date().toISOString();
  const rows = await sbRequest('GET', `/rest/v1/temp_bans?unban_at=lt.${now}`);
  return Array.isArray(rows) ? rows : [];
}

async function removeTempBan(id) {
  return sbRequest('DELETE', `/rest/v1/temp_bans?id=eq.${id}`);
}

async function getActiveTempBans(guildId) {
  const rows = await sbRequest('GET', `/rest/v1/temp_bans?guild_id=eq.${guildId}&order=unban_at`);
  return Array.isArray(rows) ? rows : [];
}

// ─── Scheduler data ────────────────────────────────────────────────────────────

const DAY_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

async function getSchedules(guildId) {
  const path = guildId
    ? `/rest/v1/schedules?guild_id=eq.${guildId}&enabled=eq.true&order=id`
    : `/rest/v1/schedules?enabled=eq.true`;
  const rows = await sbRequest('GET', path);
  return Array.isArray(rows) ? rows : [];
}

async function createSchedule(row) {
  return sbRequest('POST', '/rest/v1/schedules', row);
}

async function deleteSchedule(id, guildId) {
  return sbRequest('DELETE', `/rest/v1/schedules?id=eq.${id}&guild_id=eq.${guildId}`);
}

// ─── Giveaway data ─────────────────────────────────────────────────────────────

async function createGiveaway(guildId, channelId, prize, durationMins, winnerCount, hostId) {
  const endsAt = new Date(Date.now() + durationMins * 60 * 1000).toISOString();
  const row = { guild_id: guildId, channel_id: channelId, prize, winner_count: winnerCount, ends_at: endsAt, host_id: hostId, ended: false };
  return new Promise((resolve) => {
    const body = JSON.stringify(row);
    const req = https.request({
      hostname: new URL(SUPABASE_URL).hostname,
      path: '/rest/v1/giveaways',
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'return=representation',
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { const rows = JSON.parse(data); resolve(rows[0] ?? null); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

async function getActiveGiveaways(guildId = null) {
  const path = guildId
    ? `/rest/v1/giveaways?ended=eq.false&guild_id=eq.${guildId}&select=*`
    : `/rest/v1/giveaways?ended=eq.false&select=*`;
  const rows = await sbRequest('GET', path);
  return Array.isArray(rows) ? rows : [];
}

async function getGiveawayEntries(giveawayId) {
  const rows = await sbRequest('GET', `/rest/v1/giveaway_entries?giveaway_id=eq.${giveawayId}&select=user_id`);
  return Array.isArray(rows) ? rows.map(r => r.user_id) : [];
}

async function getGiveawayById(id) {
  const rows = await sbRequest('GET', `/rest/v1/giveaways?id=eq.${id}&limit=1`);
  return Array.isArray(rows) ? rows[0] ?? null : null;
}

async function getGiveawayByMessageId(guildId, messageId) {
  const rows = await sbRequest('GET', `/rest/v1/giveaways?message_id=eq.${messageId}&guild_id=eq.${guildId}&limit=1`);
  return Array.isArray(rows) ? rows[0] ?? null : null;
}

async function markGiveawayEnded(gw) {
  return sbRequest('POST', '/rest/v1/giveaways', { ...gw, ended: true });
}

// ─── Economy config ──────────────────────────────────────────────────────────

async function getEconomyConfig(guildId) {
  const c = await getGuildConfig(guildId);
  return {
    currencyName: c.economy_currency_name ?? 'Scrap',
    killReward: c.economy_kill_reward ?? 50,
    playtimeRate: c.economy_playtime_rate ?? 5,
    chatReward: c.economy_chat_reward ?? 1,
    chatCooldownSec: c.economy_chat_cooldown_sec ?? 60,
  };
}

async function setEconomyConfig(guildId, updates) {
  const patch = {};
  if ('currencyName' in updates) patch.economy_currency_name = updates.currencyName;
  if ('killReward' in updates) patch.economy_kill_reward = updates.killReward;
  if ('playtimeRate' in updates) patch.economy_playtime_rate = updates.playtimeRate;
  if ('chatReward' in updates) patch.economy_chat_reward = updates.chatReward;
  if ('chatCooldownSec' in updates) patch.economy_chat_cooldown_sec = updates.chatCooldownSec;
  await saveGuildConfig(guildId, patch);
}

async function getKillfeedChannel(guildId)    { return (await getGuildConfig(guildId)).killfeed_channel_id ?? null; }
async function setKillfeedChannel(guildId, v) { await saveGuildConfig(guildId, { killfeed_channel_id: v }); }

// Tracks how far into the current ADM log the economy/killfeed poller has read,
// so it only ever processes new lines (never double-credits or double-posts).
async function getDayzScanState(guildId) {
  const c = await getGuildConfig(guildId);
  return { log: c.dayz_scan_log ?? null, offset: c.dayz_scan_offset ?? 0 };
}
async function setDayzScanState(guildId, log, offset) {
  await saveGuildConfig(guildId, { dayz_scan_log: log, dayz_scan_offset: offset });
}

// Open DayZ sessions (in-game name -> ISO connect time) so playtime can be
// credited even when a session's connect and disconnect land in different polls.
async function getOpenSessions(guildId) {
  const c = await getGuildConfig(guildId);
  return c.dayz_open_sessions ?? {};
}
async function setOpenSessions(guildId, sessions) {
  await saveGuildConfig(guildId, { dayz_open_sessions: sessions });
}

// ─── Minigame config ────────────────────────────────────────────────────────

async function getWorkConfig(guildId) {
  const c = await getGuildConfig(guildId);
  return {
    cooldownSec: c.economy_work_cooldown_sec ?? 3600,
    min: c.economy_work_min ?? 10,
    max: c.economy_work_max ?? 40,
  };
}
async function setWorkConfig(guildId, updates) {
  const patch = {};
  if ('cooldownSec' in updates) patch.economy_work_cooldown_sec = updates.cooldownSec;
  if ('min' in updates) patch.economy_work_min = updates.min;
  if ('max' in updates) patch.economy_work_max = updates.max;
  await saveGuildConfig(guildId, patch);
}

// Shared by /crime and /slut — same mechanic, different flavor text.
async function getRiskyConfig(guildId) {
  const c = await getGuildConfig(guildId);
  return {
    cooldownSec: c.economy_risky_cooldown_sec ?? 1800,
    min: c.economy_risky_min ?? 20,
    max: c.economy_risky_max ?? 80,
    successChance: c.economy_risky_success_chance ?? 0.6,
    failMin: c.economy_risky_fail_min ?? 10,
    failMax: c.economy_risky_fail_max ?? 40,
  };
}
async function setRiskyConfig(guildId, updates) {
  const map = {
    cooldownSec: 'economy_risky_cooldown_sec', min: 'economy_risky_min', max: 'economy_risky_max',
    successChance: 'economy_risky_success_chance', failMin: 'economy_risky_fail_min', failMax: 'economy_risky_fail_max',
  };
  const patch = {};
  for (const [key, col] of Object.entries(map)) if (key in updates) patch[col] = updates[key];
  await saveGuildConfig(guildId, patch);
}

async function getGamblingConfig(guildId) {
  const c = await getGuildConfig(guildId);
  return {
    slotsMinBet: c.economy_slots_min_bet ?? 5,
    slotsMaxBet: c.economy_slots_max_bet ?? 500,
    blackjackMinBet: c.economy_blackjack_min_bet ?? 5,
    blackjackMaxBet: c.economy_blackjack_max_bet ?? 500,
  };
}
async function setGamblingConfig(guildId, updates) {
  const map = {
    slotsMinBet: 'economy_slots_min_bet', slotsMaxBet: 'economy_slots_max_bet',
    blackjackMinBet: 'economy_blackjack_min_bet', blackjackMaxBet: 'economy_blackjack_max_bet',
  };
  const patch = {};
  for (const [key, col] of Object.entries(map)) if (key in updates) patch[col] = updates[key];
  await saveGuildConfig(guildId, patch);
}

// ─── Cooldowns (persisted so redeploys don't reset them) ───────────────────────

async function getCooldown(guildId, userId, command) {
  const rows = await sbRequest('GET', `/rest/v1/command_cooldowns?guild_id=eq.${guildId}&user_id=eq.${userId}&command=eq.${command}&limit=1`);
  return Array.isArray(rows) && rows[0] ? new Date(rows[0].used_at) : null;
}
async function setCooldown(guildId, userId, command) {
  return sbRequest('POST', '/rest/v1/command_cooldowns', { guild_id: guildId, user_id: userId, command, used_at: new Date().toISOString() });
}

// ─── Economy (balances & transactions) ─────────────────────────────────────────
// "balance" = cash (on-hand, robbable). "bank" = deposited, safe from /rob.

async function getBalance(guildId, userId) {
  const rows = await sbRequest('GET', `/rest/v1/player_economy?guild_id=eq.${guildId}&user_id=eq.${userId}&limit=1`);
  return Array.isArray(rows) && rows[0] ? rows[0].balance : 0;
}

// Not atomic (read-modify-write over REST) — acceptable for this use case; a rare
// concurrent double-spend on a hobby server economy isn't worth a stored procedure.
async function adjustBalance(guildId, userId, delta) {
  const current = await getBalance(guildId, userId);
  const next = current + delta;
  await sbRequest('POST', '/rest/v1/player_economy', { guild_id: guildId, user_id: userId, balance: next, updated_at: new Date().toISOString() });
  return next;
}

async function getBankBalance(guildId, userId) {
  const rows = await sbRequest('GET', `/rest/v1/player_economy?guild_id=eq.${guildId}&user_id=eq.${userId}&limit=1`);
  return Array.isArray(rows) && rows[0] ? rows[0].bank : 0;
}

async function adjustBankBalance(guildId, userId, delta) {
  const current = await getBankBalance(guildId, userId);
  const next = current + delta;
  await sbRequest('POST', '/rest/v1/player_economy', { guild_id: guildId, user_id: userId, bank: next, updated_at: new Date().toISOString() });
  return next;
}

async function recordTransaction(guildId, { fromUserId = null, toUserId, amount, type, reason = null }) {
  return sbRequest('POST', '/rest/v1/economy_transactions', { guild_id: guildId, from_user_id: fromUserId, to_user_id: toUserId, amount, type, reason });
}

async function getTransactions(guildId, limit = 50) {
  const rows = await sbRequest('GET', `/rest/v1/economy_transactions?guild_id=eq.${guildId}&order=created_at.desc&limit=${limit}`);
  return Array.isArray(rows) ? rows : [];
}

// Ranked by total (cash + bank). Fetched in full and sorted in JS since
// PostgREST can't easily order by a computed sum, and guild player counts
// here are small enough that this is cheap.
async function getLeaderboard(guildId, limit = 10) {
  const rows = await sbRequest('GET', `/rest/v1/player_economy?guild_id=eq.${guildId}&select=user_id,balance,bank`);
  if (!Array.isArray(rows)) return [];
  return rows
    .map(r => ({ user_id: r.user_id, cash: r.balance ?? 0, bank: r.bank ?? 0, total: (r.balance ?? 0) + (r.bank ?? 0) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

async function getRobConfig(guildId) {
  const c = await getGuildConfig(guildId);
  return {
    cooldownSec: c.economy_rob_cooldown_sec ?? 1800,
    successChance: c.economy_rob_success_chance ?? 0.5,
    minPercent: c.economy_rob_min_percent ?? 0.1,
    maxPercent: c.economy_rob_max_percent ?? 0.4,
    failPenaltyPercent: c.economy_rob_fail_penalty_percent ?? 0.2,
    minTargetCash: c.economy_rob_min_target_cash ?? 20,
  };
}
async function setRobConfig(guildId, updates) {
  const map = {
    cooldownSec: 'economy_rob_cooldown_sec', successChance: 'economy_rob_success_chance',
    minPercent: 'economy_rob_min_percent', maxPercent: 'economy_rob_max_percent',
    failPenaltyPercent: 'economy_rob_fail_penalty_percent', minTargetCash: 'economy_rob_min_target_cash',
  };
  const patch = {};
  for (const [key, col] of Object.entries(map)) if (key in updates) patch[col] = updates[key];
  await saveGuildConfig(guildId, patch);
}

// ─── Player links (Discord <-> in-game name) ───────────────────────────────────

async function getLinkByUser(guildId, userId) {
  const rows = await sbRequest('GET', `/rest/v1/player_links?guild_id=eq.${guildId}&user_id=eq.${userId}&limit=1`);
  return Array.isArray(rows) ? rows[0] ?? null : null;
}

async function getLinkByIgn(guildId, ign) {
  const rows = await sbRequest('GET', `/rest/v1/player_links?guild_id=eq.${guildId}&ign_lower=eq.${encodeURIComponent(ign.toLowerCase())}&limit=1`);
  return Array.isArray(rows) ? rows[0] ?? null : null;
}

async function createLink(guildId, userId, ign) {
  return sbRequest('POST', '/rest/v1/player_links', { guild_id: guildId, user_id: userId, ign, ign_lower: ign.toLowerCase() });
}

async function removeLink(guildId, userId) {
  return sbRequest('DELETE', `/rest/v1/player_links?guild_id=eq.${guildId}&user_id=eq.${userId}`);
}

// ─── Player stats data ─────────────────────────────────────────────────────────

async function getPlayerStats(guildId, userId) {
  const rows = await sbRequest('GET', `/rest/v1/player_stats?guild_id=eq.${guildId}&user_id=eq.${userId}&limit=1`);
  return Array.isArray(rows) ? rows[0] ?? null : null;
}

async function getTopPlayerStats(guildId, limit = 25) {
  const rows = await sbRequest('GET', `/rest/v1/player_stats?guild_id=eq.${guildId}&order=message_count.desc&limit=${limit}`);
  return Array.isArray(rows) ? rows : [];
}

async function savePlayerStats(record) {
  return sbRequest('POST', '/rest/v1/player_stats', record);
}

module.exports = {
  SUPABASE_URL, SUPABASE_KEY,
  sbRequest,
  getGuildConfig, saveGuildConfig,
  getLogChannel, setLogChannel,
  getServerInfo, setServerInfo,
  getTrashTalk, setTrashTalk,
  getRulesChannel, setRulesChannel,
  getTargetRole, setTargetRole,
  getWelcomeChannel, setWelcomeChannel,
  getWelcomeMessage, setWelcomeMessage,
  getAutoRole, setAutoRole,
  getReportsChannel, setReportsChannel,
  getHoneypotChannel, setHoneypotChannel,
  getDayzProfilesPath, setDayzProfilesPath,
  getRules, addRule, removeRule,
  addWarning, getWarnings, removeWarning,
  getWarnPunishConfig, setWarnPunishConfig,
  getAutomodConfig, setAutomodConfig,
  addTempBan, getDueTempBans, removeTempBan, getActiveTempBans,
  DAY_NAMES, getSchedules, createSchedule, deleteSchedule,
  createGiveaway, getActiveGiveaways, getGiveawayEntries,
  getGiveawayById, getGiveawayByMessageId, markGiveawayEnded,
  getPlayerStats, getTopPlayerStats, savePlayerStats,
  getEconomyConfig, setEconomyConfig,
  getKillfeedChannel, setKillfeedChannel,
  getDayzScanState, setDayzScanState,
  getOpenSessions, setOpenSessions,
  getBalance, adjustBalance, getBankBalance, adjustBankBalance,
  recordTransaction, getTransactions, getLeaderboard,
  getRobConfig, setRobConfig,
  getLinkByUser, getLinkByIgn, createLink, removeLink,
  getWorkConfig, setWorkConfig, getRiskyConfig, setRiskyConfig, getGamblingConfig, setGamblingConfig,
  getCooldown, setCooldown,
};
