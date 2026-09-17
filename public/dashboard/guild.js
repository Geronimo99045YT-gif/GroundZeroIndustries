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

    document.getElementById('loading').hidden = true;
    document.getElementById('app').hidden = false;

    loadRules();
    loadSchedules();
    loadGiveaways();
    loadTopStats();
  } catch (err) {
    if (err.status === 401) { window.location.href = 'index.html'; return; }
    document.getElementById('loading').hidden = true;
    const box = document.getElementById('errorBox');
    box.hidden = false;
    box.textContent = err.message;
  }
})();
