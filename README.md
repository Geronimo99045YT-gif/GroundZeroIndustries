# 🪖 DayZ Console Bot

A Discord bot built for DayZ console communities. Includes a loot finder with live spawn heatmaps, DayZ tips, moderation tools, and a status web page — all in one.

---

## Files

| File | Purpose |
|---|---|
| `index.js` | Main bot file — start this |
| `server.js` | Status web page (starts automatically with the bot) |
| `package.json` | Node.js dependencies |
| `livonia_map.jpg` | Livonia map used for loot heatmaps |
| `loot_items.json` | Parsed loot table (from `types.xml`) |
| `loot_buildings.json` | Building positions (from `mapgrouppos.xml`) |
| `config.json` | Auto-generated at runtime — stores log channel settings |

---

## Setup

### 1. Create the bot on Discord

1. Go to https://discord.com/developers/applications
2. Click **New Application** and give it a name
3. Go to **Bot** → **Reset Token** → copy the token
4. Under **Bot**, enable **Server Members Intent**
5. Go to **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot permissions: `Kick Members`, `Ban Members`, `Moderate Members`, `Send Messages`, `Embed Links`, `Attach Files`
6. Open the generated URL to invite the bot to your server

### 2. Deploy on Render

1. Push all files to a GitHub repo
2. Create a new **Web Service** on Render pointing to the repo
3. Set the following:
   - **Build command:** `npm install`
   - **Start command:** `node index.js`
4. Under **Environment**, add these two secrets:

| Variable | Value |
|---|---|
| `DISCORD_TOKEN` | Your bot token |
| `CLIENT_ID` | Your application ID (General Information tab) |

> `PORT` is set automatically by Render — no need to add it.

### 3. First run

On first boot the bot will:
- Log in and print its tag to the console
- Register all slash commands globally (takes up to 1 hour to appear in Discord)
- Start the status web page on your Render URL

---

## Status Page

Once deployed, your Render URL (e.g. `https://your-bot.onrender.com`) serves a live status page showing:

- 🟢 Pulsing green dot when online / 🔴 red when offline
- Bot ping (ms)
- Uptime
- Number of servers the bot is in
- List of all commands

A JSON endpoint is also available at `/status` for programmatic monitoring.

The page auto-refreshes every 30 seconds.

---

## Commands

### 🔍 Loot Finder

| Command | Description |
|---|---|
| `/loot [item]` | Search for any item by classname and get a spawn heatmap |

- Searches 990 active items parsed from the server's `types.xml`
- Generates a heatmap image overlaid on the Livonia map showing where the item spawns
- Heatmap colour ramp: **blue → cyan → green → yellow → red** (low → high density)
- Respects tier zone restrictions (Tier 1 / 2 / 3) from the map economy
- Shows spawn slot counts per zone, location types, rarity, and max-in-world count
- If multiple items match your search, lists them so you can pick the right classname
- Example classnames: `AK74`, `M4A1`, `BandageDressing`, `SalineIVBag`, `Jeans_Blue`

**Tier zones on Livonia:**

| Zone | Colour | Area |
|---|---|---|
| Tier 1 | 🟢 Green | North |
| Tier 2 | 🔵 Blue | Middle |
| Tier 3 | 🟡 Yellow | South |
| Special | 🟣 Purple | Unique / contaminated |

---

### 💡 Tips

| Command | Description |
|---|---|
| `/tip` | Get a random DayZ console tip |
| `/tip [category]` | Get a tip from a specific category |
| `/tips` | List all tip categories |

**Tip categories:** Beginner, Survival, Medical, Combat, Loot, Vehicles, Base

50+ handwritten tips covering console-specific gameplay across all categories.

---

### 🔨 Moderation

All mod actions are posted as embeds to your configured log channel.

| Command | Permission | Description |
|---|---|---|
| `/kick @user [reason]` | Kick Members | Kicks a member from the server |
| `/ban @user [reason]` | Ban Members | Bans a member from the server |
| `/mute @user [duration] [reason]` | Moderate Members | Times out a member (1 min – 28 days) |
| `/unmute @user` | Moderate Members | Removes a timeout from a member |
| `/warn @user [reason]` | Moderate Members | Warns a member and DMs them the reason |

---

### ⚙️ Admin / Config

| Command | Permission | Description |
|---|---|---|
| `/setlogchannel #channel` | Administrator | Set the channel for mod action logs |
| `/logchannel` | Administrator | Show the currently configured log channel |

- The log channel is saved to `config.json` and persists across restarts
- When set, a confirmation message is posted to the chosen channel
- No environment variable needed — configured entirely through Discord

---

### 🎲 Fun / Utility

| Command | Description |
|---|---|
| `/roll [sides]` | Roll a dice — default d6, up to d1000 |
| `/ping` | Check the bot's websocket latency |

---

## Secrets

Only two environment variables are required — set these in Render's Environment tab:

```
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_application_id_here
```

Never commit these to GitHub. The `.gitignore` already excludes `.env` and `config.json`.

---

## Notes

- Slash commands are registered **globally** on startup — allow up to 1 hour for them to appear in Discord after first boot
- The loot heatmap uses building positions from `mapgrouppos.xml` and item data from `types.xml` — if you update your economy files, regenerate `loot_items.json` and `loot_buildings.json`
- The Livonia map image is cached in memory after first load for fast repeated heatmap generation
- `config.json` is auto-created at runtime and stores per-server log channel settings — do not commit it
