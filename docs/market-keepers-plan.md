# Market Keepers: Keeping Prices Fresh (Gameplay Design)

## The problem

The dispatcher prices routes from market snapshots up to 90 minutes old. When a
market's inventory rotates or prices move inside that window, traders get sent to
dead routes, the live-price guard rejects the buy, and they waste trips bouncing
between stale markets.

This is **not a code bug** — the freshness window, the live-price guard, and the
dispatcher all work as designed. It's an **intel coverage** problem: nobody is
visiting the markets that matter, so their prices go stale.

## The key insight

Look at which markets are fresh vs stale right now:

| Fresh (<90m) | Stale (>90m) |
|---|---|
| A1, A2, A3, A4, D45, F51, FX5Z, G53, G54, H55, H57 | B6, B7, C43, C44, D46, E47, E48, E49, F52, H56, H58, I59, I60, K85, RH14-A1, SJ22-A1 |

**The fresh markets are the ones the traders themselves visit constantly** —
A1/A2/A3/A4 (sell hubs), G54 (buy hub), H55/H57 (mining sell). Trader activity
self-refreshes them. No keeper needed.

**The stale markets are the outer buy-side markets** — C43, D46, E48, E49, F52,
K85, H56. These are exactly the buy markets for the best routes (SHIP_PARTS,
ADVANCED_CIRCUITRY, POLYNUCLEOTIDES, ELECTRONICS, FOOD, EQUIPMENT). Traders visit
them rarely, so their prices rot.

**Design principle: station keepers at the buy-side markets traders don't
naturally visit.**

## The keeper concept

A **keeper** is a ship stationed at one market that polls prices on a timer
(every ~5 min: dock → `getMarket` → record snapshot → stay put). One keeper keeps
one market permanently fresh.

Three hulls can do this:

| Hull | Fuel | Can it reach outer markets? | Cost | Opportunity cost |
|---|---|---|---|---|
| FRAME_PROBE (satellite) | 0 | **No** — can only sit where it spawns (shipyards) | ~20k | None (0 fuel, useless otherwise) |
| FRAME_SHUTTLE (light shuttle) | 300 | **Yes** — can fly anywhere and stay | ~80k | Loses tour coverage |
| FRAME_DRONE (mining drone) | 80 | **Yes** — can fly anywhere and stay | ~37k | **Loses mining income** |

### Why miners are the best keepers for the outer markets

The 4 excavators (FRAME_DRONE) earn **~1.5k–3k/hr each** mining ore at FX5Z —
combined, less than one trader makes in a single trip. A drone parked at D46
keeping ADVANCED_CIRCUITRY fresh enables the fleet's best route (+49k/trip),
which is worth more than the drone's entire mining output for a day.

The trade is lopsided: **one drone's mining income ≈ 1–2 trader trips**, but one
drone keeping a buy market fresh keeps the whole fleet's best routes alive.

**Proposed split:**
- **4 miners → 2 keepers, 2 stay mining.** The 2 remaining miners still cover
  FX5Z extraction (and the surveyors keep the pool stocked).
- Keepers take the two highest-value stale markets: **D46** (ADVANCED_CIRCUITRY,
  575m stale) and **E48** (POLYNUCLEOTIDES, 377m stale).
- Shuttles keep touring (discovery + shipyard stock + inner markets) — no
  shuttle sacrificed.

## Charting: the mechanic we missed

`POST /my/ships/{sym}/chart` reveals the waypoint's traits and pays a **one-time
credit reward** per waypoint. Any ship can do it at its current location — no
mounts, no fuel cost, no cooldown beyond the standard one.

**We scrapped 4 probes earlier without charting them first.** Each probe was
sitting at a shipyard (A2) — a free chart + credit reward we threw away. The
probe is the cheapest charting bot in the game: buy at shipyard → chart → keep
as a keeper or scrap.

**Why it matters beyond credits:**
- Charted waypoints reveal **traits** (MARKETPLACE, SHIPYARD, ASTEROID_FIELD,
  etc.) — the same data our tour shuttles and scouts spend fuel to discover.
- The chart reward is pure profit on a hull that otherwise does nothing.
- Every new system we jump into has uncharted waypoints; a probe bought at the
  local shipyard charts its waypoint for free before becoming a keeper.

**Rule going forward:** every probe purchase charts its spawn waypoint before
anything else. (The scout already charts via `chartShip` — `src/engine/scout.ts:279` —
but probes were never wired into that path.)

## Phase 1: Probe keepers at the 3 shipyard-markets

Probes can't move, but they don't need to — **A2, C43, H56 are all shipyards
AND markets**. A probe bought at each shipyard sits there forever, keeping that
market fresh.

- **A2** — already fresh (traders visit), but a probe makes it permanent.
- **C43** — currently **238m stale**. Shipyard + market (SHIP_PARTS, SHIP_PLATING,
  ELECTRONICS, PROBE, SIPHON_DRONE). High value.
- **H56** — currently **377m stale**. Shipyard + market (MINING_DRONE,
  SURVEYOR). Medium value.

**Steps:**
1. Raise `shipCap:FRAME_PROBE` from 0 → 3 in doctrine.
2. Buy 3 probes at A2 (they spawn there).
3. **Chart each probe's waypoint first** (`POST /chart`) — free credits + reveals
   traits (see the Charting section above).
4. Assign each probe as a keeper: poll its market every 5 min, record snapshot.
5. Cost: ~60k total. Permanent freshness for 3 markets, including 2 that are
   currently stale.

**Coverage gained:** C43, H56, A2 — permanently fresh.

## Phase 2: Miner keepers at the high-value outer markets

Repurpose **2 of the 4 excavators** as stationary keepers at the two
highest-value stale buy markets. The remaining 2 miners + 2 surveyors keep FX5Z
production going.

| Market | Stale for | Goods it sells (buy side) | Value |
|---|---|---|---|
| D46 | 575m | ADVANCED_CIRCUITRY, SHIP_PLATING, ELECTRONICS | **High** — best route in the game |
| E48 | 377m | POLYNUCLEOTIDES, MACHINERY | High |
| K85 | 362m | FOOD, EQUIPMENT, CLOTHING | High |
| F52 | 169m | ELECTRONICS | Medium |
| E49 | 217m | POLYNUCLEOTIDES, MEDICINE | Medium |

**Steps:**
1. Fly 2 excavators to D46 and E48 (80 fuel is enough — both are within range
   of FX5Z).
2. Station them: dock, poll every 5 min, record snapshot.
3. Cost: 0 (already owned). Lost mining income: ~2–6k/hr — far less than the
   value of keeping the fleet's best routes priced.
4. If a third market (K85) still matters after Phases 1–2, convert a third
   miner or a shuttle.

**Coverage gained:** D46 + E48 — the buy side of the two best routes.

## Phase 3 (optional): shuttle keepers / more shuttles

If coverage is still thin after Phases 1–2, station 1–2 of the 4 light shuttles
at K85/F52 (they're currently touring; keep 2 touring for discovery + shipyard
stock). Or buy 1–2 more shuttles (~80k each) — the fleet is at ~810k credits.

## Coverage math after Phases 1–2

- **Permanently fresh (keepers):** A2, C43, H56 (probes) + D46, E48 (miners)
  = **5 markets**
- **Self-refreshing (trader activity):** A1, A3, A4, D45, F51, G53, G54, H55,
  H57, FX5Z = **10 markets**
- **Remaining stale:** B6, B7, C44, E47, E49, F52, H58, I59, I60, K85,
  RH14-A1, SJ22-A1 = **12 markets** — mostly low-value (ore, fuel, distant
  systems). The tour shuttles still cycle through these on a slow rotation.

The markets that matter for trading (the ones the dispatcher prices routes
from) are all covered.

## Implementation sketch (small, not a rewrite)

1. **Keeper role** in `FleetManager.assignRole` — a new role for probes,
   shuttles, and repurposed miners: `keeper` with an assigned market.
2. **Keeper loop** in `ShipAgent` — like `tourScout` but stationary: every
   `KEEPER_POLL_MIN` (5 min), dock → `recordMarketSnapshot` → stay. Reuses the
   existing `recordMarketSnapshot` path (`fleet.ts:371`).
3. **Keeper assignment** — a simple map in `FleetManager` (market → keeper
   ship), or extend the dispatcher. Probes get shipyard-markets; miners get the
   outer buy markets; shuttles keep touring.
4. **Doctrine**: `keeperPollMin` (default 5), `shipCap:FRAME_PROBE` raised to 3.
5. **Chart-on-spawn**: when a probe is bought, chart its waypoint before
   parking.

## Why this is the right shape

- **Probes finally have a job** — they're 0-fuel, so parking them at shipyards
  is the only thing they can do, and it's genuinely useful.
- **Miners are the right sacrifice** — an excavator earns ~1.5–3k/hr mining;
  one trader trip on a fresh route earns more than that. Trading a miner's
  income for permanent freshness on the fleet's best buy markets is a net win.
- **Shuttles stop being a bottleneck** — instead of 4 shuttles cycling 27
  markets (each visited every ~30–60 min), the important ones get permanent
  coverage and the rest get slow rotation.
- **No code rewrite** — the keeper is a small variant of the existing tour loop;
  the dispatcher, freshness window, and live-price guard stay as they are.
- **It's a gameplay decision, not a hack** — you're choosing where intel
  coverage lives, which is exactly the kind of thing the doctrine tab should
  expose (keeper assignments visible/overridable like dispatch).
