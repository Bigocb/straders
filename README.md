# Startraders

Autonomous SpaceTraders fleet engine. Phase 1: an AI-run survival loop that mines asteroids, sells ore, refuels, and grows credits — with a persistent store (SQLite) already capturing market snapshots and trade ledger for the analytics phases ahead.

## Roadmap

- **Phase 1 (done)** — API client + survival loop: orbit → navigate → extract → sell → refuel
- **Phase 2 (done)** — Autonomous trading engine: contract pipeline, fleet manager, ship purchases, arbitrage trader
- **Phase 3 (done)** — Web command center: astrogation map, fleet registry, live trade feed, contracts
- **Phase 4 (done)** — Galaxy intelligence: price history, profit-rank analysis, stored-snapshot arbitrage
- **Phase 5 (done)** — Command & Control: pause/resume fleet, dispatch ships, release to autonomy
- **Phase 6 (done)** — Loadout optimizer: shipyard scoring by cargo/fuel/mounts per credit
- **Phase 7 (done)** — Narrative co-pilot: captain's log generated from the live event stream
- **Phase 8 (done)** — Discord relay: webhook status + notable-event posts
- **Phase 9 (done)** — Co-pilot: in-app chat agent with a fleet-native personality, reads live fleet/market/ledger data to plan and answer questions

## Ideas beyond the roadmap

- Genetic-algorithm loadout search across systems
- LLM-driven narrative (swap the templated log for a real model)
- Full Discord bot with slash commands
- Multi-system expansion (jump gates, foreign markets)

## Quickstart

1. Get an **account token** at https://my.spacetraders.io (Settings → Generate Account Token).
2. Create `.env` from `.env.example`:
   ```
   ST_ACCOUNT_TOKEN=your-account-token
   ST_AGENT_SYMBOL=MYAGENT01
   ```
3. Install and run:
   ```
   npm install
   npm start
   ```

On first run it registers the agent (saving the agent token to `.st-token`), then runs the fleet engine. Subsequent runs use the saved token.

## Commands

| Command | Description |
| --- | --- |
| `npm start` | Run the engine + command center (first run registers agent) |
| `npm run typecheck` | Typecheck (`tsc --noEmit`) |
| `npm run build` | Build to `dist/` |

The command center serves on `http://localhost:3000` (override with `ST_PORT`).

## Env vars

| Var | Purpose |
| --- | --- |
| `ST_ACCOUNT_TOKEN` | Account token, needed only to register new agents |
| `ST_TOKEN` | Agent token (overrides `.st-token`) |
| `ST_AGENT_SYMBOL` | Symbol to register on first run |
| `ST_FACTION` | Starting faction (default `COSMIC`) |
| `ST_MAX_TICKS` | Engine tick cap (default 100000) |
| `ST_DB` | SQLite path (default `.st-data/startraders.db`) |
| `ST_PORT` | Command center port (default 3000) |
| `ST_LLM_API_KEY` | API key for the co-pilot chat agent (OpenAI-compatible) |
| `ST_LLM_MODEL` | Co-pilot model (default `deepseek-v4-flash:0731`) |
| `ST_LLM_BASE_URL` | Co-pilot endpoint (default `https://ollama.com/v1`) |

## Layout

```
src/
  core/client.ts   typed API client (rate-limit, retry, auth)
  core/auth.ts     token mgmt + registration (account-token flow)
  core/schema.d.ts generated from the OpenAPI spec
  engine/agent.ts  per-ship state machine (mining survival loop)
  engine/trader.ts arbitrage trader (buy-low → sell-high)
  engine/contract.ts contract pipeline (accept, deliver, fulfill)
  engine/fleet.ts  fleet coordinator (roles, purchases)
  engine/market.ts market intelligence + opportunity scoring
  engine/store.ts  SQLite ledger + market price history + activity feed
  engine/state.ts  shared in-memory snapshot for the dashboard
  engine/agentChat.ts co-pilot chat agent (read-only tactical AI)
  core/chatLLM.ts  dependency-free OpenAI-compatible chat client (tool calls)
  server/index.ts  Express command-center server
  cli/index.ts     driver: register → discover → run fleet + server
public/index.html  command-center dashboard
```

Regenerate the API types after spec changes: `npx openapi-typescript openapi.json -o src/core/schema.d.ts`

## Reviews

See [`docs/`](docs/) for two reviews of the project:

- [Engineering review](docs/engineering-review.md) — security, correctness,
  performance and architecture. **Read the first item before exposing the
  command center to a network.**
- [Game-design review](docs/game-design-review.md) — the command center as a
  game, and two alternative directions, with
  [interactive mockups](docs/mockups/bridge-and-standing-orders.html).
