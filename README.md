# Dawn Bot — CUTTHROAT

A fresh Discord/Nitrado foundation for the CUTTHROAT DayZ community.

## What is included

- `/setup` — creates the Discord structure
- `/feeds setup` — creates feed categories/channels
- `/feeds list` — shows feed channel mappings
- `/nitrado connect` — opens a secure Discord modal for the Nitrado token
- `/nitrado status` — validates the stored Nitrado connection
- `/nitrado disconnect` — removes the active connection
- Discord member join/leave logging
- Nitrado request timeout handling
- Encrypted Nitrado token storage in the running process
- Lightweight web health/control page
- No trader feeds

## Important

This is a clean foundation, not a fake guarantee of instant DayZ data.

Dawn Bot can only produce a true DayZ/Nitrado feed when the upstream Nitrado service/API exposes the corresponding data. The feed engine should use persistent/event-driven sources where available, cache state, suppress duplicates, and respect Nitrado/Discord rate limits.

The starter intentionally does not invent kill/death/player-log data that the connected API does not provide.

## Environment

Copy `.env.example` to `.env` and fill in:

- `DISCORD_TOKEN`
- `RED_DAWN_MASTER_KEY`
- optionally `DISCORD_DEV_GUILD_ID`
- `WEB_PORT`
- `PUBLIC_URL`

Generate a strong random `RED_DAWN_MASTER_KEY`. Never commit `.env`.

## Discord setup

1. Invite the bot with the `bot` and `applications.commands` scopes.
2. Give it the channel-management permissions needed to create categories/channels.
3. Run `/setup`.
4. Run `/nitrado connect`.
5. Paste the Nitrado API token into the private modal.
6. Run `/nitrado status`.

## Render

For the Discord bot, use a Background Worker with:

`npm start`

For the web service, use a Web Service with:

`npm run web`

Set the same environment variables in the Render service(s).

## Production upgrade path

The next production pass should add:

1. PostgreSQL persistence using `DATABASE_URL`
2. Per-guild encrypted credential records
3. Nitrado service/server selection
4. Persistent collector workers
5. Event queue with retry/backoff
6. Duplicate-event suppression
7. Feed latency metrics
8. Server/player state reconciliation
9. Admin audit log
10. Dashboard authentication and per-guild configuration

Never place a real token in source code, GitHub, screenshots, or Discord messages.
