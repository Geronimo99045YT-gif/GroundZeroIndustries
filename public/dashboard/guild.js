const guildId = qs('id');
if (!guildId) window.location.href = 'index.html';

let CHANNELS = [];
let ROLES = [];

function channelOptions(selectedId) {
  return `<option value="">— none —</option>` +
    CHANNELS.map(c => `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>#${escapeHtml(c.name)}</option>`).join('');
}
function roleOptions(selectedId) {
  return `<option value="">— none —</option>` +
    ROLES.map(r => `<option value="${r.id}" ${r.id === selectedId ? 'selected' : ''}>@${escapeHtml(r.name)}</option>`).join('');
}
function flash(elId, text, type = 'success') {
  const el = document.getElementById(elId);
  el.textContent = text;
  el.className = `msg ${type}`;
  setTimeout(() => { el.className = 'msg hidden'; }, 4000);
}
function timeAgo(iso) {
  if (!iso) return 'Unknown';
  return new Date(iso).toLocaleString();
}

// ─── Tabs ──────────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// ─── Overview ──────────────────────────────────────────────────────────────

function renderOverview(o) {
  document.getElementById('guildName').textContent = o.name;
  document.getElementById('overviewStats').innerHTML = `
    <div class="stat-tile"><div class="v"><span class="dot ${o.botOnline ? 'on' : 'off'}"></span> ${o.botOnline ? 'Online' : 'Offline'}</div><div class="l">Status</div></div>
    <div class="stat-tile"><div class="v">${o.botPing ?? '—'}${o.botPing != null ? 'ms' : ''}</div><div class="l">Ping</div></div>
    <div class="stat-tile"><div class="v">${o.botUptime}</div><div class="l">Bot Uptime</div></div>
    <div class="stat-tile"><div class="v">${o.memberCount.toLocaleString()}</div><div class="l">Members</div></div>
  `;
}

// ─── Server Info ───────────────────────────────────────────────────────────

function renderServerInfo(info) {
  const f = document.getElementById('serverInfoForm');
  f.name.value = info?.name ?? '';
  f.password.value = info?.password ?? '';
  f.extra.value = info?.extra ?? '';
}
document.getElementById('serverInfoForm').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api(`/api/guilds/${guildId}/config`, {
      method: 'PUT',
      body: { serverInfo: { name: fd.get('name'), password: fd.get('password') || null, extra: fd.get('extra') || null } },
    });
    flash('serverInfoMsg', 'Saved.');
  } catch (err) { flash('serverInfoMsg', err.message, 'error'); }
});

// ─── Channels & Roles ──────────────────────────────────────────────────────

function renderChannelsRoles(cfg) {
  const f = document.getElementById('channelsForm');
  f.logChannel.innerHTML = channelOptions(cfg.logChannel);
  f.rulesChannel.innerHTML = channelOptions(cfg.rulesChannel);
  f.welcomeChannel.innerHTML = channelOptions(cfg.welcomeChannel);
  f.reportsChannel.innerHTML = channelOptions(cfg.reportsChannel);
  f.honeypotChannel.innerHTML = channelOptions(cfg.honeypotChannel);
  f.autoRole.innerHTML = roleOptions(cfg.autoRole);
  f.targetRole.innerHTML = roleOptions(cfg.targetRole);
  f.welcomeMessage.value = cfg.welcomeMessage ?? '';
}
document.getElementById('channelsForm').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api(`/api/guilds/${guildId}/config`, {
      method: 'PUT',
      body: {
        logChannel: fd.get('logChannel') || null,
        rulesChannel: fd.get('rulesChannel') || null,
        welcomeChannel: fd.get('welcomeChannel') || null,
        reportsChannel: fd.get('reportsChannel') || null,
        honeypotChannel: fd.get('honeypotChannel') || null,
        autoRole: fd.get('autoRole') || null,
        targetRole: fd.get('targetRole') || null,
        welcomeMessage: fd.get('welcomeMessage') || null,
      },
    });
    flash('channelsMsg', 'Saved.');
  } catch (err) { flash('channelsMsg', err.message, 'error'); }
});
document.getElementById('postWarningBtn').addEventListener('click', async () => {
  try {
    const r = await api(`/api/guilds/${guildId}/honeypot/warn`, { method: 'POST' });
    flash('channelsMsg', r.ok ? 'Warning banner posted.' : 'Set a honeypot channel first.', r.ok ? 'success' : 'error');
  } catch (err) { flash('channelsMsg', err.message, 'error'); }
});

// ─── Trash Talk ────────────────────────────────────────────────────────────

function renderTrashTalk(cfg) {
  document.getElementById('trashTalkToggle').checked = !!cfg.trashTalk;
}
document.getElementById('trashTalkToggle').addEventListener('change', async e => {
  try {
    await api(`/api/guilds/${guildId}/config`, { method: 'PUT', body: { trashTalk: e.target.checked } });
  } catch (err) { alert(err.message); e.target.checked = !e.target.checked; }
});

// ─── Rules ─────────────────────────────────────────────────────────────────

async function loadRules() {
  const rules = await api(`/api/guilds/${guildId}/rules`);
  const cats = Object.keys(rules);
  const list = document.getElementById('rulesList');
  if (cats.length === 0) { list.innerHTML = `<p class="muted">No rules yet.</p>`; return; }
  list.innerHTML = cats.map(cat => `
    <div class="rule-cat">
      <h3>${escapeHtml(cat)}</h3>
      ${rules[cat].map((r, i) => `
        <div class="list-item">
          <span>#${i + 1} — ${escapeHtml(typeof r === 'object' ? r.text : r)}</span>
          <div class="actions"><button class="danger" data-cat="${escapeHtml(cat)}" data-num="${i + 1}" onclick="deleteRule(this)">Delete</button></div>
        </div>
      `).join('')}
    </div>
  `).join('');
}
async function deleteRule(btn) {
  try {
    await api(`/api/guilds/${guildId}/rules/${encodeURIComponent(btn.dataset.cat)}/${btn.dataset.num}`, { method: 'DELETE' });
    loadRules();
  } catch (err) { flash('rulesMsg', err.message, 'error'); }
}
document.getElementById('addRuleForm').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api(`/api/guilds/${guildId}/rules`, { method: 'POST', body: { category: fd.get('category'), rule: fd.get('rule') } });
    e.target.reset();
    loadRules();
  } catch (err) { flash('rulesMsg', err.message, 'error'); }
});
document.getElementById('postRulesBtn').addEventListener('click', async () => {
  try {
    await api(`/api/guilds/${guildId}/rules/post`, { method: 'POST' });
    flash('rulesMsg', 'Rules channel refreshed.');
  } catch (err) { flash('rulesMsg', err.message, 'error'); }
});

// ─── Schedules ─────────────────────────────────────────────────────────────

const TIME_LABELS = {
  once: 'Date/time (YYYY-MM-DD HH:MM)', minutes: 'Every how many minutes', hours: 'Every how many hours',
  daily: 'Time of day (HH:MM, UTC)', weekly: 'Time of day (HH:MM, UTC)',
};
document.getElementById('scheduleType').addEventListener('change', e => {
  document.getElementById('timeLabel').textContent = TIME_LABELS[e.target.value];
  document.getElementById('dayField').hidden = e.target.value !== 'weekly';
});

function scheduleTiming(s) {
  if (!s.recurring) return `Once at ${s.run_once_at ? new Date(s.run_once_at).toUTCString() : '?'}`;
  if (s.interval_type === 'minutes') return `Every ${s.interval_value}min`;
  if (s.interval_type === 'hours') return `Every ${s.interval_value}h`;
  if (s.interval_type === 'daily') return `Daily at ${s.run_at_time} UTC`;
  if (s.interval_type === 'weekly') {
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    return `Weekly ${days[s.interval_value ?? 0]} at ${s.run_at_time} UTC`;
  }
  return '';
}
async function loadSchedules() {
  const list = await api(`/api/guilds/${guildId}/schedules`);
  const el = document.getElementById('schedulesList');
  if (list.length === 0) { el.innerHTML = `<p class="muted">No active schedules.</p>`; return; }
  el.innerHTML = list.map(s => `
    <div class="list-item">
      <div>
        <div>\`${escapeHtml(s.message.slice(0, 60))}\`</div>
        <div class="meta">#${s.id} · &lt;#${s.channel_id}&gt; · ${scheduleTiming(s)}</div>
      </div>
      <div class="actions"><button class="danger" onclick="deleteSchedule(${s.id})">Delete</button></div>
    </div>
  `).join('');
}
async function deleteSchedule(id) {
  try { await api(`/api/guilds/${guildId}/schedules/${id}`, { method: 'DELETE' }); loadSchedules(); }
  catch (err) { flash('schedulesMsg', err.message, 'error'); }
}
document.getElementById('scheduleForm').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api(`/api/guilds/${guildId}/schedules`, {
      method: 'POST',
      body: { channelId: fd.get('channelId'), message: fd.get('message'), type: fd.get('type'), time: fd.get('time'), day: fd.get('day') },
    });
    e.target.reset();
    flash('schedulesMsg', 'Schedule created.');
    loadSchedules();
  } catch (err) { flash('schedulesMsg', err.message, 'error'); }
});

// ─── Giveaways ─────────────────────────────────────────────────────────────

async function loadGiveaways() {
  const list = await api(`/api/guilds/${guildId}/giveaways`);
  const el = document.getElementById('giveawaysList');
  if (list.length === 0) { el.innerHTML = `<p class="muted">No active giveaways.</p>`; return; }
  el.innerHTML = list.map(g => `
    <div class="list-item">
      <div>
        <div><strong>${escapeHtml(g.prize)}</strong></div>
        <div class="meta">Ends ${timeAgo(g.ends_at)} · ${g.entryCount} ${g.entryCount === 1 ? 'entry' : 'entries'} · ${g.winner_count} winner(s)</div>
      </div>
      <div class="actions">
        <button onclick="rerollGiveaway(${g.id})">Reroll</button>
        <button class="danger" onclick="endGiveawayNow(${g.id})">End Now</button>
      </div>
    </div>
  `).join('');
}
async function endGiveawayNow(id) {
  try { await api(`/api/guilds/${guildId}/giveaways/${id}/end`, { method: 'POST' }); flash('giveawaysMsg', 'Giveaway ended.'); loadGiveaways(); }
  catch (err) { flash('giveawaysMsg', err.message, 'error'); }
}
async function rerollGiveaway(id) {
  try { const r = await api(`/api/guilds/${guildId}/giveaways/${id}/reroll`, { method: 'POST' }); flash('giveawaysMsg', 'Rerolled.'); }
  catch (err) { flash('giveawaysMsg', err.message, 'error'); }
}
document.getElementById('giveawayForm').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api(`/api/guilds/${guildId}/giveaways`, {
      method: 'POST',
      body: { channelId: fd.get('channelId'), prize: fd.get('prize'), durationMins: fd.get('durationMins'), winners: fd.get('winners') },
    });
    e.target.reset();
    flash('giveawaysMsg', 'Giveaway started.');
    loadGiveaways();
  } catch (err) { flash('giveawaysMsg', err.message, 'error'); }
});

// ─── Player Stats ──────────────────────────────────────────────────────────

async function loadTopStats() {
  const list = await api(`/api/guilds/${guildId}/stats/top`);
  const el = document.getElementById('topStatsList');
  if (list.length === 0) { el.textContent = 'No activity tracked yet.'; return; }
  el.innerHTML = list.slice(0, 10).map(s => `
    <div class="list-item">
      <span>${escapeHtml(s.username ?? s.user_id)}</span>
      <span class="meta">${(s.message_count ?? 0).toLocaleString()} messages</span>
      <div class="actions"><button onclick="lookupStats('${s.user_id}')">View</button></div>
    </div>
  `).join('');
}
document.getElementById('statsForm').addEventListener('submit', e => {
  e.preventDefault();
  lookupStats(new FormData(e.target).get('userId').trim());
});
async function lookupStats(userId) {
  const el = document.getElementById('statsResult');
  el.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    const { stats, analysis } = await api(`/api/guilds/${guildId}/stats/${userId}`);
    const cc = stats.channel_counts ?? {};
    const topChannels = Object.entries(cc).sort((a,b) => b[1]-a[1]).slice(0,3)
      .map(([id, cnt]) => `&lt;#${id}&gt; — ${cnt} msgs`).join('<br>') || 'No data';
    const ha = stats.hourly_activity ?? {};
    const peak = Object.entries(ha).sort((a,b) => b[1]-a[1])[0];
    const peakLabel = peak ? `${peak[0]}:00 UTC (${peak[1]} msgs)` : 'Unknown';

    el.innerHTML = `
      <div class="grid cols-3" style="margin-top:14px">
        <div class="stat-tile"><div class="v">${stats.message_count.toLocaleString()}</div><div class="l">Messages</div></div>
        <div class="stat-tile"><div class="v" style="font-size:13px">${timeAgo(stats.first_seen)}</div><div class="l">First Seen</div></div>
        <div class="stat-tile"><div class="v" style="font-size:13px">${timeAgo(stats.last_seen)}</div><div class="l">Last Active</div></div>
      </div>
      <div class="section-title">Most active in</div>
      <p>${topChannels}</p>
      <div class="section-title">Peak hours</div>
      <p>${peakLabel}</p>
      ${analysis ? `
        <div class="section-title">AI Style Analysis</div>
        <div class="grid cols-3">
          <div class="stat-tile"><div class="v">${escapeHtml(analysis.vibe)}</div><div class="l">Vibe</div></div>
          <div class="stat-tile"><div class="v">${escapeHtml(analysis.energy)}</div><div class="l">Energy</div></div>
          <div class="stat-tile"><div class="v">${escapeHtml(analysis.helps_others)}</div><div class="l">Helps Others</div></div>
        </div>
        <p style="margin-top:10px">${escapeHtml(analysis.summary ?? '')}</p>
        ${analysis.standout ? `<p class="muted">✨ ${escapeHtml(analysis.standout)}</p>` : ''}
        ${analysis.red_flags && analysis.red_flags !== 'null' ? `<p style="color:var(--red)">🚩 ${escapeHtml(analysis.red_flags)}</p>` : ''}
      ` : `<p class="muted">Not enough messages yet for an AI style analysis.</p>`}
    `;
  } catch (err) {
    el.innerHTML = `<p class="msg error">${escapeHtml(err.message)}</p>`;
  }
}

// ─── Moderation ──────────────────────────────────────────────────────────────

document.getElementById('purgeForm').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const r = await api(`/api/guilds/${guildId}/moderation/purge`, {
      method: 'POST',
      body: { channelId: fd.get('channelId'), amount: fd.get('amount'), userId: fd.get('userId') || null },
    });
    flash('purgeMsg', `Deleted ${r.deleted} message(s).`);
  } catch (err) { flash('purgeMsg', err.message, 'error'); }
});

document.getElementById('setSlowmodeBtn').addEventListener('click', async () => {
  const channelId = document.getElementById('modChannelSelect').value;
  const seconds = document.getElementById('slowmodeSeconds').value;
  if (!channelId) return flash('lockMsg', 'Choose a channel first.', 'error');
  try {
    await api(`/api/guilds/${guildId}/moderation/slowmode`, { method: 'POST', body: { channelId, seconds } });
    flash('lockMsg', 'Slowmode updated.');
  } catch (err) { flash('lockMsg', err.message, 'error'); }
});
document.getElementById('lockBtn').addEventListener('click', async () => {
  const channelId = document.getElementById('modChannelSelect').value;
  if (!channelId) return flash('lockMsg', 'Choose a channel first.', 'error');
  try {
    await api(`/api/guilds/${guildId}/moderation/lock`, { method: 'POST', body: { channelId } });
    flash('lockMsg', 'Channel locked.');
  } catch (err) { flash('lockMsg', err.message, 'error'); }
});
document.getElementById('unlockBtn').addEventListener('click', async () => {
  const channelId = document.getElementById('modChannelSelect').value;
  if (!channelId) return flash('lockMsg', 'Choose a channel first.', 'error');
  try {
    await api(`/api/guilds/${guildId}/moderation/unlock`, { method: 'POST', body: { channelId } });
    flash('lockMsg', 'Channel unlocked.');
  } catch (err) { flash('lockMsg', err.message, 'error'); }
});

document.getElementById('softbanForm').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api(`/api/guilds/${guildId}/moderation/softban`, { method: 'POST', body: { userId: fd.get('userId'), reason: fd.get('reason') } });
    e.target.reset();
    flash('banMsg', 'User softbanned.');
  } catch (err) { flash('banMsg', err.message, 'error'); }
});
document.getElementById('tempbanForm').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api(`/api/guilds/${guildId}/moderation/tempban`, {
      method: 'POST',
      body: { userId: fd.get('userId'), durationMins: fd.get('durationMins'), reason: fd.get('reason') },
    });
    e.target.reset();
    flash('banMsg', 'User temp-banned.');
    loadTempbans();
  } catch (err) { flash('banMsg', err.message, 'error'); }
});
async function loadTempbans() {
  const list = await api(`/api/guilds/${guildId}/moderation/tempbans`);
  const el = document.getElementById('tempbansList');
  if (list.length === 0) { el.textContent = 'No active temp-bans.'; return; }
  el.innerHTML = 'Active temp-bans: ' + list.map(t => `${escapeHtml(t.user_id)} (unbans ${timeAgo(t.unban_at)})`).join(', ');
}

document.getElementById('warnPunishForm').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api(`/api/guilds/${guildId}/warnpunish`, {
      method: 'PUT',
      body: { threshold: fd.get('threshold'), punishment: fd.get('punishment'), muteMinutes: fd.get('muteMinutes') },
    });
    flash('warnPunishMsg', 'Saved.');
  } catch (err) { flash('warnPunishMsg', err.message, 'error'); }
});
async function loadWarnPunish() {
  const cfg = await api(`/api/guilds/${guildId}/warnpunish`);
  const f = document.getElementById('warnPunishForm');
  f.threshold.value = cfg.threshold ?? 0;
  f.punishment.value = cfg.punishment ?? '';
  f.muteMinutes.value = cfg.muteMinutes ?? 60;
}

let AUTOMOD_WORDS = [];
async function loadAutomod() {
  const cfg = await api(`/api/guilds/${guildId}/automod`);
  AUTOMOD_WORDS = cfg.bannedWords;
  renderBannedWords();
  document.getElementById('blockInvitesToggle').checked = !!cfg.blockInvites;
  document.getElementById('blockCapsToggle').checked = !!cfg.blockCaps;
  document.getElementById('maxMentionsInput').value = cfg.maxMentions ?? 0;
}
function renderBannedWords() {
  const el = document.getElementById('bannedWordsList');
  el.innerHTML = AUTOMOD_WORDS.length === 0
    ? `<p class="muted">No banned words yet.</p>`
    : AUTOMOD_WORDS.map(w => `
        <div class="list-item"><span>${escapeHtml(w)}</span>
          <div class="actions"><button class="danger" data-word="${escapeHtml(w)}" onclick="removeBannedWord(this.dataset.word)">Remove</button></div>
        </div>`).join('');
}
async function removeBannedWord(word) {
  AUTOMOD_WORDS = AUTOMOD_WORDS.filter(w => w !== word);
  renderBannedWords();
  try { await api(`/api/guilds/${guildId}/automod`, { method: 'PUT', body: { bannedWords: AUTOMOD_WORDS } }); }
  catch (err) { flash('automodMsg', err.message, 'error'); }
}
document.getElementById('bannedWordForm').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const word = fd.get('word').trim().toLowerCase();
  if (word && !AUTOMOD_WORDS.includes(word)) AUTOMOD_WORDS.push(word);
  renderBannedWords();
  e.target.reset();
  try { await api(`/api/guilds/${guildId}/automod`, { method: 'PUT', body: { bannedWords: AUTOMOD_WORDS } }); }
  catch (err) { flash('automodMsg', err.message, 'error'); }
});
document.getElementById('saveAutomodBtn').addEventListener('click', async () => {
  try {
    await api(`/api/guilds/${guildId}/automod`, {
      method: 'PUT',
      body: {
        blockInvites: document.getElementById('blockInvitesToggle').checked,
        blockCaps: document.getElementById('blockCapsToggle').checked,
        maxMentions: parseInt(document.getElementById('maxMentionsInput').value, 10) || 0,
      },
    });
    flash('automodMsg', 'Automod settings saved.');
  } catch (err) { flash('automodMsg', err.message, 'error'); }
});

document.getElementById('warningsLookupForm').addEventListener('submit', e => {
  e.preventDefault();
  lookupWarnings(new FormData(e.target).get('userId').trim());
});
async function lookupWarnings(userId) {
  const el = document.getElementById('warningsResult');
  el.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    const list = await api(`/api/guilds/${guildId}/warnings/${userId}`);
    if (list.length === 0) { el.innerHTML = `<p class="muted">No warnings for that user.</p>`; return; }
    el.innerHTML = list.map(w => `
      <div class="list-item">
        <div><div>${escapeHtml(w.reason)}</div><div class="meta">#${w.id} · by ${escapeHtml(w.moderator_id)} · ${timeAgo(w.created_at)}</div></div>
        <div class="actions"><button class="danger" data-id="${w.id}" data-user="${escapeHtml(userId)}" onclick="deleteWarning(this.dataset.id, this.dataset.user)">Remove</button></div>
      </div>
    `).join('');
  } catch (err) {
    el.innerHTML = `<p class="msg error">${escapeHtml(err.message)}</p>`;
  }
}
async function deleteWarning(id, userId) {
  try { await api(`/api/guilds/${guildId}/warnings/${id}`, { method: 'DELETE' }); lookupWarnings(userId); }
  catch (err) { alert(err.message); }
}

// ─── DayZ Server Management (FTP) ──────────────────────────────────────────

let DAYZ_CONFIGURED = false;
let DAYZ_PROFILES_PATH = null;

function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function joinPath(dir, name) {
  return dir.replace(/\/$/, '') + '/' + name;
}

async function loadDayzStatus() {
  const status = await api(`/api/guilds/${guildId}/dayz/status`);
  DAYZ_CONFIGURED = status.configured;
  DAYZ_PROFILES_PATH = status.profilesPath;

  for (const [gateId, appId] of [
    ['dayzNotConfigured', 'dayzActivityApp'],
    ['dayzFilesNotConfigured', 'dayzFilesApp'],
    ['dayzBansNotConfigured', 'dayzBansApp'],
  ]) {
    document.getElementById(gateId).hidden = DAYZ_CONFIGURED;
    document.getElementById(appId).hidden = !DAYZ_CONFIGURED;
  }
  if (!DAYZ_CONFIGURED) return;

  if (DAYZ_PROFILES_PATH) {
    document.getElementById('dayzPathForm').path.value = DAYZ_PROFILES_PATH;
    document.getElementById('banPathForm').path.value = joinPath(DAYZ_PROFILES_PATH, 'ban.txt');
    fileBrowse(DAYZ_PROFILES_PATH);
  } else {
    fileBrowse('/');
  }
}

document.getElementById('dayzPathForm').addEventListener('submit', async e => {
  e.preventDefault();
  const path = new FormData(e.target).get('path').trim();
  try {
    await api(`/api/guilds/${guildId}/dayz/profiles-path`, { method: 'PUT', body: { path } });
    DAYZ_PROFILES_PATH = path;
    document.getElementById('banPathForm').path.value = joinPath(path, 'ban.txt');
    flash('dayzPathMsg', 'Saved.');
  } catch (err) { flash('dayzPathMsg', err.message, 'error'); }
});

// ── Activity log ──
const EVENT_LABELS = { connect: 'Connect', disconnect: 'Disconnect', kill: 'Hit', death: 'Death', chat: 'Chat', session: 'Session', raw: 'Info' };
let LAST_ACTIVITY_EVENTS = [];
function renderActivity(events) {
  const showRaw = document.getElementById('showRawEvents').checked;
  const filtered = showRaw ? events : events.filter(e => e.type !== 'raw');
  const el = document.getElementById('activityLog');
  if (filtered.length === 0) { el.innerHTML = `<p class="muted">No events found.</p>`; return; }
  el.innerHTML = filtered.map(e => `
    <div class="event-row">
      <span class="event-time">${escapeHtml(e.time || '')}</span>
      <span class="event-badge ${e.type}">${EVENT_LABELS[e.type] || e.type}</span>
      <span>${escapeHtml(e.raw)}</span>
    </div>
  `).join('');
}
async function loadActivity() {
  if (!DAYZ_PROFILES_PATH) { flash('activityMsg', 'Set a profiles path first.', 'error'); return; }
  document.getElementById('activityLog').innerHTML = `<p class="muted">Loading…</p>`;
  try {
    const { events } = await api(`/api/guilds/${guildId}/dayz/activity`);
    LAST_ACTIVITY_EVENTS = events;
    renderActivity(events);
  } catch (err) {
    flash('activityMsg', err.message, 'error');
    document.getElementById('activityLog').innerHTML = '';
  }
}
document.getElementById('refreshActivityBtn').addEventListener('click', loadActivity);
document.getElementById('showRawEvents').addEventListener('change', () => renderActivity(LAST_ACTIVITY_EVENTS));

// ── File browser ──
let CURRENT_FILE_PATH = null;

function breadcrumbHtml(path) {
  const parts = path.split('/').filter(Boolean);
  let acc = '';
  const crumbs = [`<button data-path="/">root</button>`];
  for (const part of parts) {
    acc += '/' + part;
    crumbs.push(`<button data-path="${escapeHtml(acc)}">${escapeHtml(part)}</button>`);
  }
  return crumbs.join(' / ');
}
document.getElementById('fileBreadcrumb').addEventListener('click', e => {
  const btn = e.target.closest('[data-path]');
  if (btn) fileBrowse(btn.dataset.path);
});
document.getElementById('fileListing').addEventListener('click', e => {
  const row = e.target.closest('[data-path]');
  if (!row) return;
  if (row.dataset.isDir === 'true') fileBrowse(row.dataset.path);
  else viewFile(row.dataset.path);
});

async function fileBrowse(path) {
  document.getElementById('fileViewerCard').hidden = true;
  document.getElementById('fileBreadcrumb').innerHTML = breadcrumbHtml(path);
  document.getElementById('fileListing').innerHTML = `<p class="muted">Loading…</p>`;
  try {
    const entries = await api(`/api/guilds/${guildId}/dayz/browse?path=${encodeURIComponent(path)}`);
    if (entries.length === 0) { document.getElementById('fileListing').innerHTML = `<p class="muted">Empty folder.</p>`; return; }
    document.getElementById('fileListing').innerHTML = entries.map(e => `
      <div class="file-row" data-path="${escapeHtml(joinPath(path, e.name))}" data-is-dir="${e.isDirectory}">
        <span class="fname">${e.isDirectory ? '📁' : '📄'} ${escapeHtml(e.name)}</span>
        <span class="fmeta">${e.isDirectory ? '' : formatBytes(e.size)}</span>
      </div>
    `).join('');
  } catch (err) {
    flash('filesMsg', err.message, 'error');
    document.getElementById('fileListing').innerHTML = '';
  }
}

async function viewFile(path) {
  CURRENT_FILE_PATH = path;
  document.getElementById('fileViewerCard').hidden = false;
  document.getElementById('fileViewerName').textContent = path;
  document.getElementById('fileViewerContent').innerHTML = `<p class="muted">Loading…</p>`;
  document.getElementById('saveFileBtn').hidden = true;
  document.getElementById('cancelEditBtn').hidden = true;
  document.getElementById('editFileBtn').hidden = false;
  try {
    const { text, truncated } = await api(`/api/guilds/${guildId}/dayz/file?path=${encodeURIComponent(path)}`);
    document.getElementById('fileViewerContent').dataset.original = text;
    document.getElementById('fileViewerContent').innerHTML =
      (truncated ? '<p class="msg error">File is larger than 500KB — showing the first 500KB only.</p>' : '') +
      `<pre class="code-block">${escapeHtml(text)}</pre>`;
  } catch (err) {
    document.getElementById('fileViewerContent').innerHTML = `<p class="msg error">${escapeHtml(err.message)}</p>`;
  }
}
document.getElementById('editFileBtn').addEventListener('click', () => {
  const original = document.getElementById('fileViewerContent').dataset.original ?? '';
  document.getElementById('fileViewerContent').innerHTML = `<textarea id="fileEditArea" rows="18" style="font-family:'Consolas','Courier New',monospace;font-size:12px">${escapeHtml(original)}</textarea>`;
  document.getElementById('editFileBtn').hidden = true;
  document.getElementById('saveFileBtn').hidden = false;
  document.getElementById('cancelEditBtn').hidden = false;
});
document.getElementById('cancelEditBtn').addEventListener('click', () => viewFile(CURRENT_FILE_PATH));
document.getElementById('saveFileBtn').addEventListener('click', async () => {
  const content = document.getElementById('fileEditArea').value;
  try {
    await api(`/api/guilds/${guildId}/dayz/file`, { method: 'PUT', body: { path: CURRENT_FILE_PATH, content } });
    flash('filesMsg', 'Saved.');
    viewFile(CURRENT_FILE_PATH);
  } catch (err) {
    flash('filesMsg', err.message, 'error');
  }
});

// ── Ban list ──
let BAN_LIST_PATH = null;
let BAN_ENTRIES = [];

document.getElementById('banPathForm').addEventListener('submit', async e => {
  e.preventDefault();
  await loadBanList(new FormData(e.target).get('path').trim());
});

async function loadBanList(path) {
  BAN_LIST_PATH = path;
  document.getElementById('banList').innerHTML = `<p class="muted">Loading…</p>`;
  try {
    const { text } = await api(`/api/guilds/${guildId}/dayz/file?path=${encodeURIComponent(path)}`);
    BAN_ENTRIES = text.split('\n').map(l => l.trim()).filter(Boolean);
    renderBanList();
  } catch (err) {
    flash('bansMsg', err.message, 'error');
    document.getElementById('banList').innerHTML = '';
  }
}
function renderBanList() {
  const el = document.getElementById('banList');
  if (BAN_ENTRIES.length === 0) { el.innerHTML = `<p class="muted">No entries loaded.</p>`; return; }
  el.innerHTML = BAN_ENTRIES.map((entry, i) => `
    <div class="list-item">
      <span>${escapeHtml(entry)}</span>
      <div class="actions"><button class="danger" data-idx="${i}" onclick="removeBanEntry(this.dataset.idx)">Remove</button></div>
    </div>
  `).join('');
}
async function saveBanList() {
  await api(`/api/guilds/${guildId}/dayz/file`, { method: 'PUT', body: { path: BAN_LIST_PATH, content: BAN_ENTRIES.join('\n') + '\n' } });
}
async function removeBanEntry(idx) {
  BAN_ENTRIES.splice(parseInt(idx, 10), 1);
  renderBanList();
  try { await saveBanList(); flash('bansMsg', 'Saved.'); }
  catch (err) { flash('bansMsg', err.message, 'error'); }
}
document.getElementById('addBanForm').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const entry = fd.get('entry').trim();
  if (!entry) return;
  if (!BAN_LIST_PATH) { flash('bansMsg', 'Load a ban file first.', 'error'); return; }
  BAN_ENTRIES.push(entry);
  renderBanList();
  e.target.reset();
  try { await saveBanList(); flash('bansMsg', 'Added.'); }
  catch (err) { flash('bansMsg', err.message, 'error'); }
});

// ─── Economy ────────────────────────────────────────────────────────────────

async function loadEconomyConfig() {
  const cfg = await api(`/api/guilds/${guildId}/economy/config`);
  const f = document.getElementById('economyConfigForm');
  f.currencyName.value = cfg.currencyName;
  f.killReward.value = cfg.killReward;
  f.playtimeRate.value = cfg.playtimeRate;
  f.chatReward.value = cfg.chatReward;
  f.chatCooldownSec.value = cfg.chatCooldownSec;
  f.killfeedChannel.innerHTML = channelOptions(cfg.killfeedChannel);
}
document.getElementById('economyConfigForm').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api(`/api/guilds/${guildId}/economy/config`, {
      method: 'PUT',
      body: {
        currencyName: fd.get('currencyName'),
        killReward: parseInt(fd.get('killReward'), 10),
        playtimeRate: parseInt(fd.get('playtimeRate'), 10),
        chatReward: parseInt(fd.get('chatReward'), 10),
        chatCooldownSec: parseInt(fd.get('chatCooldownSec'), 10),
        killfeedChannel: fd.get('killfeedChannel') || null,
      },
    });
    flash('economyConfigMsg', 'Saved.');
  } catch (err) { flash('economyConfigMsg', err.message, 'error'); }
});

async function loadMinigamesConfig() {
  const { work, risky, gambling, rob } = await api(`/api/guilds/${guildId}/economy/minigames`);
  const f = document.getElementById('minigamesForm');
  f.work_cooldownSec.value = work.cooldownSec;
  f.work_min.value = work.min;
  f.work_max.value = work.max;
  f.risky_cooldownSec.value = risky.cooldownSec;
  f.risky_successChance.value = risky.successChance;
  f.risky_min.value = risky.min;
  f.risky_max.value = risky.max;
  f.risky_failMin.value = risky.failMin;
  f.risky_failMax.value = risky.failMax;
  f.gambling_slotsMinBet.value = gambling.slotsMinBet;
  f.gambling_slotsMaxBet.value = gambling.slotsMaxBet;
  f.gambling_blackjackMinBet.value = gambling.blackjackMinBet;
  f.gambling_blackjackMaxBet.value = gambling.blackjackMaxBet;
  f.rob_cooldownSec.value = rob.cooldownSec;
  f.rob_successChance.value = rob.successChance;
  f.rob_minTargetCash.value = rob.minTargetCash;
  f.rob_minPercent.value = rob.minPercent;
  f.rob_maxPercent.value = rob.maxPercent;
  f.rob_failPenaltyPercent.value = rob.failPenaltyPercent;
}
document.getElementById('minigamesForm').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const num = name => parseFloat(fd.get(name));
  try {
    await api(`/api/guilds/${guildId}/economy/minigames`, {
      method: 'PUT',
      body: {
        work: { cooldownSec: num('work_cooldownSec'), min: num('work_min'), max: num('work_max') },
        risky: {
          cooldownSec: num('risky_cooldownSec'), successChance: num('risky_successChance'),
          min: num('risky_min'), max: num('risky_max'), failMin: num('risky_failMin'), failMax: num('risky_failMax'),
        },
        gambling: {
          slotsMinBet: num('gambling_slotsMinBet'), slotsMaxBet: num('gambling_slotsMaxBet'),
          blackjackMinBet: num('gambling_blackjackMinBet'), blackjackMaxBet: num('gambling_blackjackMaxBet'),
        },
        rob: {
          cooldownSec: num('rob_cooldownSec'), successChance: num('rob_successChance'), minTargetCash: num('rob_minTargetCash'),
          minPercent: num('rob_minPercent'), maxPercent: num('rob_maxPercent'), failPenaltyPercent: num('rob_failPenaltyPercent'),
        },
      },
    });
    flash('minigamesMsg', 'Saved.');
  } catch (err) { flash('minigamesMsg', err.message, 'error'); }
});

document.getElementById('grantForm').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const r = await api(`/api/guilds/${guildId}/economy/grant`, {
      method: 'POST',
      body: { userId: fd.get('userId'), amount: fd.get('amount'), reason: fd.get('reason') },
    });
    e.target.reset();
    flash('grantMsg', `Done — new balance: ${r.newBalance}.`);
    loadLeaderboard();
    loadTransactions();
  } catch (err) { flash('grantMsg', err.message, 'error'); }
});

async function loadLeaderboard() {
  const list = await api(`/api/guilds/${guildId}/economy/leaderboard`);
  const el = document.getElementById('economyLeaderboard');
  if (list.length === 0) { el.innerHTML = `<p class="muted">No balances yet.</p>`; return; }
  el.innerHTML = list.map((row, i) => `
    <div class="list-item">
      <span>#${i + 1} — ${escapeHtml(row.user_id)}</span>
      <span class="meta">${row.total.toLocaleString()} total (${row.cash.toLocaleString()} cash / ${row.bank.toLocaleString()} bank)</span>
    </div>
  `).join('');
}

async function loadTransactions() {
  const list = await api(`/api/guilds/${guildId}/economy/transactions`);
  const el = document.getElementById('economyTransactions');
  if (list.length === 0) { el.innerHTML = `<p class="muted">No transactions yet.</p>`; return; }
  el.innerHTML = list.map(t => `
    <div class="list-item">
      <div>
        <div>${t.from_user_id ? `${escapeHtml(t.from_user_id)} → ` : ''}${escapeHtml(t.to_user_id)}: ${t.amount > 0 ? '+' : ''}${t.amount.toLocaleString()}</div>
        <div class="meta">${escapeHtml(t.type)}${t.reason ? ` · ${escapeHtml(t.reason)}` : ''} · ${timeAgo(t.created_at)}</div>
      </div>
    </div>
  `).join('');
}

document.getElementById('linkLookupForm').addEventListener('submit', async e => {
  e.preventDefault();
  const userId = new FormData(e.target).get('userId').trim();
  const el = document.getElementById('linkLookupResult');
  el.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    const link = await api(`/api/guilds/${guildId}/economy/link/${userId}`);
    el.innerHTML = link
      ? `<div class="list-item"><span>Linked to <strong>${escapeHtml(link.ign)}</strong></span>
          <div class="actions"><button class="danger" data-user="${escapeHtml(userId)}" onclick="removeLinkLookup(this.dataset.user)">Remove Link</button></div>
        </div>`
      : `<p class="muted">Not linked.</p>`;
  } catch (err) {
    el.innerHTML = `<p class="msg error">${escapeHtml(err.message)}</p>`;
  }
});
async function removeLinkLookup(userId) {
  try {
    await api(`/api/guilds/${guildId}/economy/link/${userId}`, { method: 'DELETE' });
    document.getElementById('linkLookupResult').innerHTML = `<p class="muted">Not linked.</p>`;
  } catch (err) { alert(err.message); }
}

// ─── Factions & Zones ───────────────────────────────────────────────────────

let FACTIONS = [];

function channelNameById(id) {
  const c = CHANNELS.find(c => c.id === id);
  return c ? `#${escapeHtml(c.name)}` : null;
}
function roleNameById(id) {
  const r = ROLES.find(r => r.id === id);
  return r ? `@${escapeHtml(r.name)}` : null;
}
function factionOptions(valueKey) {
  if (FACTIONS.length === 0) return `<option value="">— create a faction first —</option>`;
  return FACTIONS.map(f => `<option value="${escapeHtml(String(f[valueKey]))}">${escapeHtml(f.name)}</option>`).join('');
}

async function loadFactions() {
  FACTIONS = await api(`/api/guilds/${guildId}/factions`);
  const el = document.getElementById('factionsList');
  el.innerHTML = FACTIONS.length === 0 ? `<p class="muted">No factions yet.</p>` : FACTIONS.map(f => `
    <div class="list-item">
      <span><strong>${escapeHtml(f.name)}</strong> — ${f.memberCount} member${f.memberCount === 1 ? '' : 's'}${f.channel_id ? ` · alerts in ${channelNameById(f.channel_id) ?? 'unknown channel'}` : ' · no alert channel set'}</span>
      <div class="actions"><button class="danger" data-id="${f.id}" onclick="deleteFaction(this.dataset.id)">Delete</button></div>
    </div>
  `).join('');

  document.getElementById('addMemberForm').factionId.innerHTML = factionOptions('id');
  document.getElementById('createZoneForm').factionName.innerHTML = factionOptions('name');
}
async function deleteFaction(id) {
  try {
    await api(`/api/guilds/${guildId}/factions/${id}`, { method: 'DELETE' });
    loadFactions();
    loadZones();
  } catch (err) { alert(err.message); }
}
document.getElementById('createFactionForm').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api(`/api/guilds/${guildId}/factions`, {
      method: 'POST',
      body: { name: fd.get('name').trim(), channelId: fd.get('channelId') || null },
    });
    e.target.reset();
    flash('factionsMsg', 'Faction created.');
    loadFactions();
  } catch (err) { flash('factionsMsg', err.message, 'error'); }
});

document.getElementById('addMemberForm').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const factionId = fd.get('factionId');
  if (!factionId) { flash('membersMsg', 'Create a faction first.', 'error'); return; }
  try {
    await api(`/api/guilds/${guildId}/factions/${factionId}/members`, {
      method: 'POST',
      body: { userId: fd.get('userId').trim() },
    });
    e.target.reset();
    flash('membersMsg', 'Member added.');
    loadFactions();
  } catch (err) { flash('membersMsg', err.message, 'error'); }
});

document.getElementById('removeMemberForm').addEventListener('submit', async e => {
  e.preventDefault();
  const userId = new FormData(e.target).get('userId').trim();
  try {
    await api(`/api/guilds/${guildId}/factions/members/${userId}`, { method: 'DELETE' });
    e.target.reset();
    flash('membersMsg', 'Member removed.');
    loadFactions();
  } catch (err) { flash('membersMsg', err.message, 'error'); }
});

async function loadZones() {
  const zones = await api(`/api/guilds/${guildId}/zones`);
  const el = document.getElementById('zonesList');
  el.innerHTML = zones.length === 0 ? `<p class="muted">No zones yet.</p>` : zones.map(z => {
    const faction = FACTIONS.find(f => f.id === z.faction_id);
    const allow = Array.isArray(z.allowlist) ? z.allowlist : [];
    const roleName = z.allowlist_role_id ? roleNameById(z.allowlist_role_id) : null;
    return `
    <div class="list-item">
      <span><strong>${escapeHtml(z.name)}</strong> — ${faction ? escapeHtml(faction.name) : 'unknown faction'} · center (${z.center_x}, ${z.center_z}) · radius ${z.radius}m${allow.length ? ` · allowlist: ${escapeHtml(allow.join(', '))}` : ''}${roleName ? ` · role: ${roleName}` : ''}</span>
      <div class="actions"><button class="danger" data-id="${z.id}" onclick="deleteZone(this.dataset.id)">Delete</button></div>
    </div>
  `; }).join('');
}
async function deleteZone(id) {
  try {
    await api(`/api/guilds/${guildId}/zones/${id}`, { method: 'DELETE' });
    loadZones();
  } catch (err) { alert(err.message); }
}
document.getElementById('createZoneForm').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const factionName = fd.get('factionName');
  if (!factionName) { flash('zonesMsg', 'Create a faction first.', 'error'); return; }
  const allowlist = (fd.get('allowlist') || '').split(',').map(s => s.trim()).filter(Boolean);
  try {
    await api(`/api/guilds/${guildId}/zones`, {
      method: 'POST',
      body: {
        factionName, name: fd.get('name').trim(),
        centerX: fd.get('centerX'), centerZ: fd.get('centerZ'), radius: fd.get('radius'),
        allowlist, allowlistRoleId: fd.get('allowlistRoleId') || null,
      },
    });
    e.target.reset();
    flash('zonesMsg', 'Zone created.');
    loadZones();
  } catch (err) { flash('zonesMsg', err.message, 'error'); }
});

// ─── Init ──────────────────────────────────────────────────────────────────

(async function init() {
  try {
    const [overview, channels, roles, config] = await Promise.all([
      api(`/api/guilds/${guildId}/overview`),
      api(`/api/guilds/${guildId}/channels`),
      api(`/api/guilds/${guildId}/roles`),
      api(`/api/guilds/${guildId}/config`),
    ]);
    CHANNELS = channels;
    ROLES = roles;

    renderOverview(overview);
    renderServerInfo(config.serverInfo);
    renderChannelsRoles(config);
    renderTrashTalk(config);

    document.getElementById('scheduleForm').channelId.innerHTML = channelOptions(null);
    document.getElementById('giveawayForm').channelId.innerHTML = channelOptions(null);
    document.getElementById('purgeForm').channelId.innerHTML = channelOptions(null);
    document.getElementById('modChannelSelect').innerHTML = channelOptions(null);
    document.getElementById('createFactionForm').channelId.innerHTML = channelOptions(null);
    document.getElementById('createZoneForm').allowlistRoleId.innerHTML = roleOptions(null);

    document.getElementById('loading').hidden = true;
    document.getElementById('app').hidden = false;

    loadRules();
    loadSchedules();
    loadGiveaways();
    loadTopStats();
    loadWarnPunish();
    loadAutomod();
    loadTempbans();
    loadDayzStatus();
    loadEconomyConfig();
    loadMinigamesConfig();
    loadLeaderboard();
    loadTransactions();
    loadFactions().then(loadZones);
  } catch (err) {
    if (err.status === 401) { window.location.href = 'index.html'; return; }
    document.getElementById('loading').hidden = true;
    const box = document.getElementById('errorBox');
    box.hidden = false;
    box.textContent = err.message;
  }
})();
