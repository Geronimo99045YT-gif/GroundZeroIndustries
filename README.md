# 🪖 DayZ Console Bot

A Discord bot built for DayZ console (Xbox) communities. Includes a loot finder with live spawn heatmaps, server join info, server rules, DayZ tips, moderation tools, and a live status web page.

---

## 📁 Files

| File | Purpose |
|---|---|
| `index.js` | Main bot — this is what runs |
| `server.js` | Status web page (auto-starts with the bot) |
| `package.json` | Node.js dependencies |
| `livonia_map.jpg` | Livonia map image used for loot heatmaps |
| `loot_items.json` | Parsed loot table from `types.xml` |
| `loot_buildings.json` | Building positions from `mapgrouppos.xml` |
| `config.json` | Auto-generated at runtime — stores all settings |

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
   - Bot Permissions: tick `Kick Members`, `Ban Members`, `Moderate Members`, `Send Messages`, `Embed Links`, `Attach Files`, `Read Message History`, `Manage Messages`
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
| `/mute @user [duration] [reason]` | Moderate Members | Timeout a member (1 min – 28 days) |
| `/unmute @user` | Moderate Members | Remove a timeout |
| `/warn @user [reason]` | Moderate Members | Warn a member — DMs them the reason |
| `/setlogchannel #channel` | Admin | Set the mod log channel |
| `/logchannel` | Admin | Show the current log channel |

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

## 🔒 Secrets

Only two env vars needed — set in Render's Environment tab:

```
DISCORD_TOKEN=your_bot_token
CLIENT_ID=your_application_id
```

Never commit these to GitHub. Keep your repo **Private**.

---

## 📝 Notes

- Slash commands register globally on startup — up to **1 hour** to appear in Discord after first boot
- `config.json` is created automatically and stores log channel, rules channel, server info and rules — do **not** commit it
- The Livonia map image is cached in memory after first load for fast heatmap generation
- If you update your economy files (`types.xml` / `mapgrouppos.xml`), regenerate `loot_items.json` and `loot_buildings.json`
