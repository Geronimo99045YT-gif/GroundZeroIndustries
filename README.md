# 🪖 DayZ Console Bot

A Discord bot built for DayZ console (Xbox) communities. Includes a loot finder with live spawn heatmaps, server join info, server rules, DayZ tips, moderation tools, and a live status web page.

Made by raptor — [support on Ko-fi](https://ko-fi.com/raptormakesstuff) if you find it useful.

---

## 📁 Files

| File | Purpose |
|---|---|
| `index.js` | Main bot — this is what runs |
| `db.js` | Supabase data layer (shared by the bot and the dashboard) |
| `actions.js` | Shared logic that needs the live Discord client (rules posting, giveaways, AI stats) |
| `ftp.js` | Nitrado FTP access for the dashboard's Server Management section |
| `server.js` | Status page + admin dashboard (auto-starts with the bot) |
| `public/dashboard/` | Dashboard frontend (HTML/CSS/JS) |
| `package.json` | Node.js dependencies |
| `livonia_map.jpg` | Livonia map image used for loot heatmaps |
| `loot_items.json` | Parsed loot table from `types.xml` |
| `loot_buildings.json` | Building positions from `mapgrouppos.xml` |

---

## 🚀 Render Setup (Step by Step)

### Step 1 — Create the Discord bot

1. Go to **https://discord.com/developers/applications**
2. Click **New Application**, give it a name
3. Go to **Bot** → click **Reset Token** → copy the token (save it somewhere safe)
4. Under **Bot**, enable these two intents:
   - ✅ **Server Members Intent**
   - ✅ **Message Content Intent**
5. Go to **OAuth2 → URL Generator**:
   - Scopes: tick `bot` and `applications.commands`
   - Bot Permissions: tick `Kick Members`, `Ban Members`, `Moderate Members`, `Send Messages`, `Embed Links`, `Attach Files`, `Read Message History`, `Manage Messages`, `Manage Channels`, `Manage Roles`
6. Copy the generated URL at the bottom and open it in your browser to invite the bot to your server

---

### Step 2 — Put the files on GitHub

1. Create a **free GitHub account** at https://github.com if you don't have one
2. Click **New repository**, name it (e.g. `dayz-bot`), set it to **Private**, click Create
3. Upload all the bot files:
   - `index.js`
   - `server.js`
   - `package.json`
   - `livonia_map.jpg`
   - `loot_items.json`
   - `loot_buildings.json`
4. Do **not** upload `config.json` — it gets created automatically when the bot runs

---

### Step 3 — Deploy on Render

1. Go to **https://render.com** and sign in (free account works)
2. Click **New** → **Web Service**
3. Connect your GitHub account and select your bot repo
4. Fill in the settings:

| Setting | Value |
|---|---|
| **Name** | anything you like |
| **Region** | closest to you |
| **Branch** | `main` |
| **Runtime** | `Node` |
| **Build Command** | `npm install` |
| **Start Command** | `node index.js` |

5. Scroll down to **Environment Variables** and add these two:

| Key | Value |
|---|---|
| `DISCORD_TOKEN` | your bot token from Step 1 |
| `CLIENT_ID` | your Application ID (found on the General Information page in the developer portal) |

6. Click **Create Web Service**

Render will build and deploy the bot. First deploy takes ~2 minutes.

---

### Step 4 — First run checklist

- ✅ Bot comes online in your Discord server (green dot)
- ✅ Slash commands appear — **allow up to 1 hour** for Discord to propagate them globally
- ✅ Your Render URL (e.g. `https://your-bot.onrender.com`) shows the status page
- ✅ Run `/setlogchannel #your-log-channel` to enable mod logging
- ✅ Run `/setserver` to configure your Xbox server join info
- ✅ Run `/addrule` a few times to add your rules, then `/setruleschannel` and `/postrules`

---

## 💬 Commands

### 🔍 Loot Finder

| Command | Description |
|---|---|
| `/loot [item]` | Generates a spawn heatmap for any item on Livonia |

- Searches 990 active items from your `types.xml`
- Overlays a colour-coded heatmap on the Livonia map (blue = low density → red = high)
- Respects tier zones: 🟢 Tier 1 North · 🔵 Tier 2 Middle · 🟡 Tier 3 South
- Shows spawn slot counts, location types, rarity and max-in-world
- Example classnames: `AK74`, `M4A1`, `BandageDressing`, `SalineIVBag`, `Jeans_Blue`

---

### 🎮 Server Join Info

| Command | Permission | Description |
|---|---|---|
| `/setserver` | Admin | Set Xbox server name, host gamertag, password, extra info |
| `/join` | Everyone | Shows step-by-step how to find and join the server |

- The bot also **auto-detects** messages like "how do I join", "whats the server", "cant find the server" etc. and replies automatically

---

### 📜 Server Rules

| Command | Permission | Description |
|---|---|---|
| `/addrule [category] [rule]` | Admin | Add a rule to a category |
| `/removerule [category] [number]` | Admin | Remove a rule by number |
| `/setruleschannel #channel` | Admin | Set the channel rules get posted to |
| `/postrules` | Admin | Post or refresh rules in the rules channel |
| `/rules` | Everyone | View all rules inline |

- Rules are split into categories — name them whatever you like (General, Combat, Base, Vehicles etc.)
- Each category gets its own colour-coded embed with emoji
- `/postrules` wipes old bot messages in the rules channel and reposts everything fresh
- After adding or removing rules, run `/postrules` to refresh the channel

---

### 💡 Tips

| Command | Description |
|---|---|
| `/tip` | Random DayZ console tip |
| `/tip [category]` | Tip from a specific category |
| `/tips` | List all categories |

**Categories:** Beginner · Survival · Medical · Combat · Loot · Vehicles · Base

---

### 🔨 Moderation

All mod actions post an embed to your configured log channel.

| Command | Permission | Description |
|---|---|---|
| `/kick @user [reason]` | Kick Members | Kick a member |
| `/ban @user [reason]` | Ban Members | Ban a member |
| `/softban @user [reason]` | Ban Members | Ban + immediately unban — wipes their recent messages, they can rejoin |
| `/tempban @user [duration] [reason]` | Ban Members | Ban for a set number of minutes, then auto-unban |
| `/mute @user [duration] [reason]` | Moderate Members | Timeout a member (1 min – 28 days) |
| `/unmute @user` | Moderate Members | Remove a timeout |
| `/warn @user [reason]` | Moderate Members | Warn a member — DMs them, tracks a running count, can auto-punish |
| `/warnings @user` | Moderate Members | View a member's full warning history |
| `/delwarning [id]` | Moderate Members | Remove one warning by ID |
| `/setwarnpunish [threshold] [action]` | Admin | Auto-mute/kick/ban once a member hits N warnings (0 = off) |
| `/purge [amount] [user?]` | Manage Messages | Bulk-delete recent messages, optionally from one user |
| `/slowmode [seconds] [channel?]` | Manage Channels | Set slowmode (0 = off, max 6h) |
| `/lock [channel?] [reason?]` | Manage Channels | Stop everyone posting in a channel |
| `/unlock [channel?]` | Manage Channels | Restore posting in a locked channel |
| `/setlogchannel #channel` | Admin | Set the mod log channel |
| `/logchannel` | Admin | Show the current log channel |
| `/sync` | Admin | Force-refresh the bot's channel/role cache from Discord |

> **If the bot was invited before this update:** `/lock`, `/unlock`, and `/slowmode` need the bot to hold **Manage Channels** and **Manage Roles** in your server, which the original invite didn't request. Fastest fix — no re-invite needed: Server Settings → Roles → the bot's role → toggle on Manage Channels and Manage Roles.

---

### 🛡️ Automod

Auto-deletes messages that trip a filter and logs them to the mod log channel. All filters are off by default and configured per-server.

| Command | Description |
|---|---|
| `/automod status` | Show current filter settings |
| `/automod bannedword-add / bannedword-remove [word]` | Manage the banned words/phrases list |
| `/automod invites [on/off]` | Block Discord invite links |
| `/automod mentions [max]` | Block messages with more than N mentions (0 = off) |
| `/automod caps [on/off]` | Block messages that are mostly uppercase |

---

### 💰 Economy & Linking

Requires FTP set up (see below) — earnings are pulled from the real `.ADM` server log, not self-reported. A background job scans for new log activity every 3 minutes.

| Command | Description |
|---|---|
| `/link [name]` | Link your Discord to your in-game name — verified by checking recent server logs for that name actually connecting |
| `/unlink` | Remove your link |
| `/linked [user?]` | Check a user's linked in-game name |
| `/balance [user?]` | Check cash, bank, and total |
| `/pay [user] [amount]` | Pay another player (from your cash) |
| `/deposit [amount]` | Move cash into your bank — safe from `/rob` |
| `/withdraw [amount]` | Move money from your bank back to cash |
| `/rob [user]` | Try to steal from another player's cash on hand — can fail and cost you a cut of your own cash (cooldown) |
| `/addmoney` / `/removemoney` | Admin: give or take cash, with a reason |
| `/setkillfeedchannel` / `/killfeedchannel` | Set or view where DayZ kills get posted |
| `/work` | Earn a small guaranteed payout — has a cooldown |
| `/crime` | Risk it for a bigger payout — can fail and cost you instead (cooldown) |
| `/slut` | Same as /crime with different flavor text (cooldown) |
| `/slots [bet]` | Spin the slot machine |
| `/blackjack [bet]` | Play a full hand of blackjack against the dealer (Hit/Stand buttons) |

Every earning source (kills, playtime, chat, work, crime, slut, slots, blackjack) pays out to **cash**, which is what `/rob` can steal — depositing to the bank is the only way to protect it.

Players earn automatically for: DayZ kills, DayZ playtime (10-minute increments), and Discord chat activity (rate-limited) — plus the commands above for active/manual earning and gambling. All reward amounts, odds, cooldowns, bet limits, the currency name, and the killfeed channel are configurable in the dashboard's **Economy** tab, which also shows a leaderboard, transaction history, and a give/take-money tool.

---

### 🚩 Factions & Zones

Requires FTP set up (see below). Zones watch the DayZ server's periodic `PlayerList` snapshot in the `.ADM` log — how often that snapshot is written controls how fast a zone alert can fire, on top of the usual 3-minute scan interval.

| Command | Description |
|---|---|
| `/faction create [name] [channel]` | Create a faction with a channel for zone/intrusion alerts |
| `/faction delete [name]` | Delete a faction and all of its zones |
| `/faction addmember [user] [faction]` | Add a member — a user can only be in one faction at a time |
| `/faction removemember [user]` | Remove a member from their faction |
| `/faction info [name]` | Show a faction's alert channel and member list |
| `/faction list` | List all factions |
| `/faction zone-create [faction] [name] [x] [z] [radius] [allowlist?] [allowlist_role?]` | Create a base zone — pings the faction's alert channel when someone not on the allowlist, not holding the allowlist role, and not a faction member is detected inside |
| `/faction zone-delete [name]` | Delete a zone |
| `/faction zone-list [faction?]` | List zones, optionally filtered to one faction |

A zone's allowlist can be in-game names, a Discord role, or both — anyone holding the allowlist role is exempt as long as they've linked their in-game name (`/link`), same as a faction member. Only unrecognized names trigger an alert, and only once per new intrusion (it won't re-ping every scan while the same person stays inside). Everything above is also manageable from the dashboard's **Factions** tab.

---

### 🎲 Utility

| Command | Description |
|---|---|
| `/roll [sides]` | Roll a dice — default d6, up to d1000 |
| `/ping` | Check bot websocket latency |

---

## 🌐 Status Page

Your Render URL serves a live status page showing:
- 🟢 Pulsing green dot when online / 🔴 red when offline
- Ping · Uptime · Server count
- Full command list

Also available as JSON at `/status` for uptime monitors.
Page auto-refreshes every 30 seconds.

---

## 🖥️ Admin Dashboard

A web control panel lives at `https://your-bot.onrender.com/dashboard/`. Anyone can open the link, but it only shows servers where **both** are true:
- GroundZeroAI is in the server, and
- the logged-in Discord account has **Administrator** there.

It's split into two sections:

- **Discord Management** — everything about the bot and community: channels/roles, rules, moderation (purge, slowmode/lock/unlock, softban/tempban, automod filters, warnings), trash talk, scheduled messages, giveaways, player stats, the economy (settings, leaderboard, transactions, give/take money, link lookup), and factions & zones (create/delete factions and base zones, manage members).
- **Server Management** — the actual DayZ game server, over FTP: server join info, a parsed activity log (connects, disconnects, kills — read from the `.ADM` admin log), a file browser for the server's FTP files (view and edit text files), and a ban list editor. Requires the `FTP_*` env vars below; without them this section shows a setup notice instead of erroring.

Quick in-the-moment moderation actions (`/kick /ban /mute`) stay as slash commands on purpose.

### One-time setup

1. In the [Discord Developer Portal](https://discord.com/developers/applications) → your app → **OAuth2 → General**, add a redirect URL:
   ```
   https://your-bot.onrender.com/auth/discord/callback
   ```
2. On the same page, copy the **Client Secret** (click "Reset Secret" if you've never generated one).
3. Add two more environment variables in Render's **Environment** tab:

| Key | Value |
|---|---|
| `DISCORD_CLIENT_SECRET` | the Client Secret from step 2 |
| `SESSION_SECRET` | any long random string (e.g. run `openssl rand -hex 32`, or mash the keyboard) |

4. Redeploy, then open `https://your-bot.onrender.com/dashboard/` and log in with Discord.

If your Render URL ever changes, update the redirect URL in the Developer Portal to match — otherwise login will fail with a redirect mismatch error.

---

## 🔒 Secrets

Env vars, set in Render's Environment tab:

```
DISCORD_TOKEN=your_bot_token
CLIENT_ID=your_application_id
DISCORD_CLIENT_SECRET=your_oauth_client_secret   (dashboard login)
SESSION_SECRET=any_long_random_string            (dashboard login)
FTP_HOST=your_nitrado_ftp_host                   (dashboard Server Management)
FTP_USER=your_nitrado_ftp_username
FTP_PASS=your_nitrado_ftp_password
FTP_PORT=21                                      (usually 21 — optional, defaults to 21)
FTP_SECURE=true                                  (optional — set to false only if your host uses plain FTP, not FTPS)
```

Find your FTP host/username/password in Nitrado's web panel under your DayZ service → **FTP & File Access**. Never commit these to GitHub. Keep your repo **Private**.

---

## 📝 Notes

- Slash commands register globally on startup — up to **1 hour** to appear in Discord after first boot
- `config.json` is created automatically and stores log channel, rules channel, server info and rules — do **not** commit it
- The Livonia map image is cached in memory after first load for fast heatmap generation
- If you update your economy files (`types.xml` / `mapgrouppos.xml`), regenerate `loot_items.json` and `loot_buildings.json`
