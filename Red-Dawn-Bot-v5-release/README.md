# Red Dawn Bot v5

A public, multi-server Red Dawn Discord + Nitrado control center. v5 changes the architecture so each Discord server has its own encrypted Nitrado configuration and its own stats/configuration record.

## Security architecture

- **Per-server Nitrado credentials:** every Discord guild stores its own Nitrado token and service ID. Credentials are never shared between guilds.
- **Encrypted configuration:** the entire guild configuration is encrypted with AES-256-GCM before it is stored in Postgres. The encryption master key is supplied only through `RED_DAWN_MASTER_KEY`.
- **Owner/admin authorization:** the Discord server owner can connect/disconnect Nitrado and set the Red Dawn admin role. Nitrado management commands accept the server owner, Administrator, Manage Server, or the configured Red Dawn admin role.
- **No secrets in source:** `.env` is ignored and the real Render secrets stay in Render Environment Variables.
- **Public-ready command registration:** commands register globally by default. Use `DISCORD_DEV_GUILD_ID` only while developing.

## New `/setup` commands

- `/setup connect` — owner-only secure Nitrado connection dialog
- `/setup import-env` — owner-only migration from the old single-server `NITRADO_TOKEN` / `NITRADO_SERVICE_ID` Render variables
- `/setup disconnect` — owner-only credential removal
- `/setup status` — admin-safe setup status
- `/setup admin-role` — owner-only admin role assignment
- `/setup test` — admin-only Nitrado connectivity test
- `/setup security` — admin-safe explanation of this server's security state

`/setup connect` validates the supplied Nitrado credentials before saving them, then encrypts the configuration for this guild. The bot never echoes the token.

## Required Render environment variables

```text
DISCORD_TOKEN=
DATABASE_URL=
RED_DAWN_MASTER_KEY=
```

Optional while developing locally:

```text
DISCORD_DEV_GUILD_ID=
```

Optional performance/settings variables:

```text
DB_POOL_MAX=5
FEED_POLL_MS=10000
NITRADO_API_TIMEOUT_MS=12000
NITRADO_LOG_DIR=dayzstandalone/logs
RED_DAWN_NAME=Red Dawn
RED_DAWN_RULES=
RED_DAWN_LINKS=
RED_DAWN_VERIFY=
```

### Generate the encryption key

After installing dependencies, run:

```bat
node scripts/generate-master-key.js
```

Copy the 64-character result into Render as `RED_DAWN_MASTER_KEY`. **Keep it permanently.** If you lose it, the bot cannot decrypt the stored guild configurations. Do not put it in GitHub.

## Render database setup

Create a Render Postgres database and use its **internal connection URL** when possible. Render documents internal database connections as the low-latency option for services in the same region, and the Postgres connection string is exposed from the database's Connect menu.

Then add `DATABASE_URL` to the bot's Environment Variables. Render recommends environment variables for secrets and says not to commit `.env` to source control.

The bot automatically creates its `red_dawn_guilds` table when it starts.

## Install

```bat
npm install
node dawn.js
```

## Migrating your existing Red Dawn server

Your old v4 deployment used these global Render variables:

```text
NITRADO_TOKEN
NITRADO_SERVICE_ID
```

For the first migration:

1. Keep those legacy variables in Render temporarily.
2. Add `DATABASE_URL` and `RED_DAWN_MASTER_KEY`.
3. Deploy v5.
4. In your Red Dawn Discord server, run `/setup import-env`.
5. Run `/setup test`.
6. Remove `NITRADO_TOKEN` and `NITRADO_SERVICE_ID` from Render.

After that, every new Discord server must connect its own Nitrado account with `/setup connect`.

## Public installation

The bot is designed for global slash commands. On the Discord Developer Portal, use **Guild Install** with the `bot` and `applications.commands` scopes. Discord provides command-level permission controls under Server Settings → Integrations, so administrators can further restrict commands per role or channel.

## Existing v4 features

The v4 command groups remain in this project: server controls, player lists and staff tools, settings, file browser, backups, feeds, stats, Discord moderation, community tools, bot diagnostics, and the 100+ grouped actions.

The key v5 change is that those features now resolve their Nitrado connection from the **current Discord guild's encrypted configuration**, not from one global Nitrado token.

## Feeds

Use the existing feed commands after connecting the server:

```text
/feed discover
/feed file-add path:<remote path>
/feed channel type:<feed type> channel:<channel>
/feed test type:<type>
/feed start
/feed status
```

The parser remains conservative because DayZ log formats can vary. Verify your actual Xbox log lines before relying on automated PvP/kill attribution.

## Safety notes

- Never commit `.env`, `RED_DAWN_MASTER_KEY`, Discord tokens, or Nitrado tokens.
- Do not log Nitrado credentials.
- Destructive server actions use confirmation buttons and admin authorization.
- Nitrado credentials are encrypted before being written to Postgres.
- Discord command permissions can also be tightened from Server Settings → Integrations.
