# Dawn Bot V6

A secure DayZ Discord server-management foundation for Cutthroat / Red Dawn.

## Features
- Protected bot core: Discord users configure the server, not source files.
- `/setup` creates the complete feed layout.
- `/dashboard`, `/feeds`, `/diagnostics`, `/server`, and `/audit`.
- Detailed Discord embeds.
- PostgreSQL-backed configuration and event queue.
- Idempotency protection.
- Priority queueing.
- Retry with exponential backoff + jitter.
- Dead-letter handling.
- Configurable worker concurrency.
- Role-based command authorization.
- Nitrado credentials stored only in environment variables.
- No trader-feed subsystem.

## Important
This package deliberately does not invent unsupported DayZ/Nitrado events. The `src/adapters/nitrado.js` adapter is the integration boundary where the currently supported Nitrado data source should be connected.

## Render
Background Worker:
- Build Command: `npm ci`
- Start Command: `npm start`

Set these environment variables:
- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_GUILD_ID`
- `DATABASE_URL`
- `NITRADO_TOKEN` (when the supported Nitrado integration is connected)
- `NITRADO_SERVICE_ID` (when required by the supported integration)
- `DAWN_OWNER_ROLE_ID` (optional)
- `WORKER_CONCURRENCY` (default 4)
