# Red Dawn Bot v3

A fast, modular Discord + Nitrado bot for Red Dawn DayZ servers.

## What changed
- Exactly 100 guild slash commands.
- Fast Nitrado API calls with short-lived caching and request timeouts.
- Admin/mod permission gates.
- Kill/PvP/hit/death/build/placement/join/leave feed engine based on Nitrado DayZ logs.
- Feed testing tools so you can validate your server's log format before enabling live feeds.
- Player stats, reports, staff notes, watchlist, Discord moderation, polls, events, giveaways, and dashboards.
- Uses `MessageFlags.Ephemeral` rather than the deprecated `ephemeral: true` interaction option.

## Install
```bat
npm install
```
Copy `.env.example` to `.env` and fill in:
- `DISCORD_TOKEN`
- `DISCORD_GUILD_ID`
- `NITRADO_TOKEN`
- `NITRADO_SERVICE_ID`

Optional:
- `NITRADO_LOG_DIR=dayzstandalone/logs`
- `FEED_POLL_MS=10000`

Start:
```bat
node dawn.js
```

## Feed setup
1. `/findlogs` — see log paths available through the Nitrado file server.
2. `/feedfile path:<path>` — add a log file to poll.
3. Set feed channels with `/setkillfeed`, `/setpvpfeed`, `/sethitfeed`, `/setdeathfeed`, `/setbuildfeed`, `/setplacementfeed`, `/setconnectfeed`.
4. `/feedtest` — test parsing against sample lines.
5. `/feedstart` — start polling.

### Important Xbox limitation
DayZ console servers do not expose the same PC RCON/admin-command surface. Nitrado documents PC-only DayZ admin/RCON commands, while its console documentation focuses on console server settings. The feed system here therefore uses **Nitrado log files**, not fake RCON events. citeturn180237search1turn180237search5

A kill feed is only as accurate as the log lines your particular DayZ/Xbox server writes. If your logs use a different format, update `detectLine()` in `dawn.js` with the actual sample lines from `/findlogs`/your Nitrado log file.

## Security
Never paste your Discord or Nitrado token into Discord or source code. Keep them in `.env`, and do not commit `.env` to Git.
