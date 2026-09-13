# Red Dawn Bot v4

A grouped Discord + Nitrado command center for Red Dawn DayZ Xbox servers.

## What changed
The bot uses command groups so it can hold far more actions than a flat slash-command list while keeping Discord easy to navigate.

### Direct shortcuts
- `/ping`
- `/status`
- `/players`
- `/serverinfo`
- `/restart` (admin + confirmation)
- `/nitrado`
- `/help`

### Command groups
- `/server` — status, dashboard, info, players, services, service, notifications, IP, map, slots, online, refresh, health, latency, start, stop, restart, maintenance, announce, scheduled restart, daily restart, query, uptime
- `/player` — online list/search, tracked stats, ban/whitelist/priority lists, watchlist, notes, reports, snapshots
- `/settings` — available settings, sets, defaults, get, set, current server settings
- `/file` — list/search, tail/head/read, size/stat, download/upload, delete, move/copy, mkdir, log discovery, bookmarks
- `/backup` — list/count/info/reminder
- `/feed` — live log feeds, log discovery, file/channel mapping, tests, recent event views, start/stop
- `/stats` — leaderboards, kills, deaths, K/D, hits, activity, player view, reset/export
- `/moderation` — clear, slowmode, lock/unlock, timeout, warn/warnings, kick, ban/unban, audit, role configuration
- `/community` — announcements, polls, tickets, events, suggestions, rules, links, verification
- `/bot` — help, ping, uptime, about, health, latency, safe config, cache, channels, command counts

## Security
- Never commit `.env`.
- Discord and Nitrado tokens are environment variables only.
- Server start/stop/restart and file deletion require admin permission plus confirmation.
- Settings writes and file mutations are permission-gated.
- File paths reject `..` traversal segments.

## Install
```bat
npm install
node dawn.js
```

Required environment variables:
- `DISCORD_TOKEN`
- `DISCORD_GUILD_ID`
- `NITRADO_TOKEN`
- `NITRADO_SERVICE_ID`

Optional:
- `RED_DAWN_NAME`
- `RED_DAWN_RULES`
- `RED_DAWN_LINKS`
- `RED_DAWN_VERIFY`
- `FEED_POLL_MS`
- `NITRADO_LOG_DIR`
- `NITRADO_API_TIMEOUT_MS`

## Render
Use a Node Background Worker:
- Build command: `npm install`
- Start command: `node dawn.js`

Add the environment variables in Render. Do not upload `.env` to GitHub.

## Feeds
1. `/feed discover`
2. `/feed file-add path:<remote path>`
3. `/feed channel type:<feed type> channel:<channel>`
4. `/feed test type:<type>`
5. `/feed start`
6. `/feed status`

The parser is intentionally conservative. Actual DayZ log formats vary, so verify your real log lines with `/file tail` and expand parsing patterns from the logs you actually receive.

## Nitrado file server
The file tools use Nitrado's documented file-server list/search, seek, download, upload-token, delete, move, copy and mkdir flows. The upload/download/seek code uses the temporary tokens returned by Nitrado rather than exposing them in Discord.
