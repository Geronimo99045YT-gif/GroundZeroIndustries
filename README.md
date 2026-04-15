# DayZ Console Discord Bot

Moderation + DayZ console tips bot built with discord.js v14.

---

## Setup

### 1. Create the bot on Discord

1. Go to https://discord.com/developers/applications
2. **New Application** → give it a name
3. Go to **Bot** → **Reset Token** → copy the token
4. Under **Bot** → enable **Server Members Intent**
5. Go to **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot permissions: `Kick Members`, `Ban Members`, `Moderate Members`, `Send Messages`, `Embed Links`
6. Open the generated URL to invite the bot to your server

### 2. Install and configure

```bash
npm install
cp .env.example .env
```

Edit `.env` and fill in:
- `DISCORD_TOKEN` — your bot token
- `CLIENT_ID` — your application ID (General Information tab)
- `LOG_CHANNEL_ID` — channel ID for mod logs (optional, leave blank to disable)

To get a Channel ID: enable Developer Mode in Discord settings, then right-click the channel → Copy Channel ID.

### 3. Run

```bash
npm start
```

Slash commands register globally on first boot (takes up to 1 hour to propagate to all servers).

---

## Commands

### Tips

| Command | Description |
|---|---|
| `/tip` | Random DayZ console tip |
| `/tip [category]` | Tip from a specific category |
| `/tips` | List all categories |

**Categories:** Beginner, Survival, Medical, Combat, Loot, Vehicles, Base

### Moderation

| Command | Permission needed |
|---|---|
| `/kick @user [reason]` | Kick Members |
| `/ban @user [reason]` | Ban Members |
| `/mute @user [duration] [reason]` | Moderate Members |
| `/unmute @user` | Moderate Members |
| `/warn @user [reason]` | Moderate Members |

Warn DMs the target user and logs the action to your log channel.

### Fun / Utility

| Command | Description |
|---|---|
| `/roll [sides]` | Roll a dice (default d6) |
| `/ping` | Check bot latency |
