# HyperCoreX Promo Bot

A Discord staff promotion bot that posts a styled embed and assigns roles when a staff member is promoted.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server + Discord bot (port 8080)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- Required env: `DISCORD_BOT_TOKEN` — Discord bot token (from Discord Developer Portal)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- Discord: discord.js v14
- DB: PostgreSQL + Drizzle ORM (available but not used by bot)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/bot/index.ts` — Discord bot, /promote command logic
- `artifacts/api-server/src/index.ts` — Entry point; starts HTTP server + bot together

## Architecture decisions

- The Discord bot runs in the same process as the Express server. Both start from `src/index.ts`.
- Slash commands are registered per-guild at bot startup (and again on `guildCreate`) for instant availability without global propagation delay.
- The bot uses `deferReply()` so role assignment (which takes time) doesn't cause a timeout.

## Product

- `/promote @member @role [reason]` — assigns the role to the member and posts a Staff Promotion embed with signer info, member mention, role mention, reason, and a random Promotion ID.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- The bot needs **Manage Roles** permission in the server, and its highest role must be above any role it tries to assign.
- Bot must be invited with the `applications.commands` scope for slash commands to work.
- Slash commands are registered per-guild at startup — if you add the bot to a new server, restart the workflow once.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
