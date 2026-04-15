const http = require('http');

const PORT = process.env.PORT || 3000;

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

const server = http.createServer((req, res) => {
  if (req.url === '/status' && req.method === 'GET') {
    const online  = botClient?.isReady() ?? false;
    const payload = {
      online,
      ping:    online ? botClient.ws.ping : null,
      uptime:  formatUptime(Date.now() - startTime),
      guilds:  online ? botClient.guilds.cache.size : 0,
      tag:     online ? botClient.user.tag : null,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }

  const online  = botClient?.isReady() ?? false;
  const uptime  = formatUptime(Date.now() - startTime);
  const ping    = online ? botClient.ws.ping : '—';
  const guilds  = online ? botClient.guilds.cache.size : 0;
  const tag     = online ? botClient.user.tag : 'Offline';
  const dot     = online ? '#22c55e' : '#ef4444';
  const status  = online ? 'Online' : 'Offline';

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html>
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
      <a href="/status">JSON status</a>
    </div>
  </div>
</body>
</html>`);
});

server.listen(PORT, () => {
  console.log(`Status page running on port ${PORT}`);
});

module.exports = { setBotClient };
