# Game-design review

A critique of the command centre as a *game*, rather than as software, and two
directions it could go instead.

Rendered versions with wireframes and interactive mockups:

- [`mockups/game-design-review.html`](mockups/game-design-review.html) — this
  document, with layout wireframes
- [`mockups/bridge-and-standing-orders.html`](mockups/bridge-and-standing-orders.html)
  — full desktop mockups of both alternatives, populated with a realistic
  seven-ship fleet

---

## The diagnosis: the engine has a loop, the player doesn't

Look at what the player actually does, minute to minute. They open the page. They
watch a credit counter go up. Then nothing — because nothing is ever asked of
them.

Every good management game runs on a supervisory loop: the system produces a
situation, the situation demands a judgement, the judgement produces feedback,
and the feedback teaches you to build a better system. Factorio calls this
outgrowing your factory. RimWorld calls it a raid. What they share is that the
automation is never the end state — it is the thing that generates the next
decision.

Startraders has the automation and stops there. Credits rise on their own.
Nothing threatens them. Nothing is scarce that the player controls. No decision
is ever forced, and no decision is ever scored.

**This is not a UI bug.** Every button on the page can be wired correctly and it
will still be a screensaver.

> The interface's real job is not to display the fleet. It is to manufacture the
> moments where a human judgement beats the engine's default — and to make the
> outcome of that judgement legible afterwards.

The raw material for that loop already exists in the codebase, unused. The engine
knows when a ship is stranded. It knows why a ship went idle. It computes a
`ShipGoal` for every ship on every tick. It keeps a full ledger. All of it is
either written to `console.log` or flattened into a single number in the topbar.

---

## What's already right

- **The aesthetic is a real one.** Amber on void, a condensed display face
  against mono data, the serif captain's log. It commits to a world.
- **The map is well-built.** `vector-effect: non-scaling-stroke` and
  `calc(2px / var(--map-zoom))` to hold stroke weights and label sizes constant
  under zoom are the correct techniques, done properly.
- **The room metaphor is a good instinct.** A mining desk and a trading desk
  genuinely want different controls.
- **The co-pilot has a voice.** *"You call the human operator captain."* Someone
  thought about character.

---

## Six failures of play

These would all still be wrong if every endpoint were wired perfectly.

### The score is a level, not a rate

The topbar reads `412,500`. It only ever goes up, and it goes up whether or not
the player did anything. In a management game the *derivative* is the score.
"Did my last decision help?" is currently unanswerable.

**Fix:** credits per hour, trending against recent hours, attributed per ship.

### Nothing is ever at risk

You cannot lose. Ships strand, and the engine dispatches a fuel tender before you
notice. No threat means no tension, and no tension means no reason to open the
tab.

**Fix:** the stake in a fleet game is opportunity cost, and it is already
computable. Price idleness out loud — "3 ships idle · 4,200c/hr forgone". Give
the auto-rescue a visible countdown so intervening early is a real choice rather
than a redundant one.

### Interventions are unpriced bets

Move, Refuel, Buy, Scout — each is a button with no stated cost and no stated
consequence. A decision the player cannot evaluate is a dice roll, and players
stop pressing buttons whose effects they cannot perceive.

**Fix:** price every action inline. "Move to C3 — 34 fuel (~2,400c), 4m transit,
interrupts a mining cycle worth 6,100c." The dispatch picker's "(89 fuel)" is
already the right pattern; generalise it.

### Ships are interchangeable

Every card shows symbol, status, role and waypoint. None shows how the ship is
*doing*. A fleet game where units cannot be compared has no fleet decisions in
it — only ship decisions, taken blind.

**Fix:** per-ship earnings over the last hour, idle time, and the engine's
current goal in plain words. `ShipGoal` is computed every tick and never leaves
the process.

### Rooms fragment the one question that matters

The actual job — "which of my ships is underperforming?" — is cross-cutting.
Answering it means visiting several rooms and comparing from memory. The metaphor
serves the fiction and fights the work.

> Note: the Comms room added in `3ad2ec1` takes the room count to eight. That was
> a deliberate short-term trade — the right drawer it replaced was strictly
> worse, hiding the same content behind a toggle *and* a tab. This finding stands
> against both.

### The fiction is quarantined in a tab

The captain's log, the co-pilot's voice, the room names — the whole fictional
layer is well-written and lives somewhere most sessions never open. Worse, the
LLM narrator that would make the log genuinely alive is fully implemented and
never called.

**Fix:** decide whether the fiction is the frame or the garnish. At minimum, make
the co-pilot proactive: *"Captain — IRON_ORE just spiked at A1. Want AG-3
rerouted?"* An advisor that only answers when asked is a search box with a
personality.

---

## Incremental path

Keeping the room model intact, in descending order of value per hour of work.

1. **Put a rate in the topbar.** Credits per hour with a trend and a sparkline.
   One change, and every other decision in the app acquires a scoreboard.
2. **Turn Overview into a bridge.** An alert queue ranked by cost-of-inaction,
   above one table of every ship with earnings and idle time.
3. **Surface the engine's reasoning.** "No mining target in range." "Holding —
   can't reach a market on this tank." Already logged, never shown.
4. **Price every button.** Cost, duration, and what it interrupts.
5. **Animate the map along routes.** Ships currently sit at their origin until
   they teleport on arrival, because position comes from `waypointSymbol`.
   `nav.route` carries departure and arrival times.
6. **Wire the narrator; make the co-pilot speak first.** Both are built.

---

## Two alternatives

The incremental path improves the current design without resolving its central
confusion: it is trying to be an operations console *and* an atmospheric idle
game, and those want opposite things from every pixel.

### Design constraints

Stated by the project owner, and they rule things out:

- Must have **stakes** and **things to do**
- Owner **likes tinkering with the fleet**
- Owner **loves automation** — it has to stay autonomous
- Target is a **desktop browser**

The original second alternative — *The Long Watch*, a two-minute-twice-a-day
ambient narrative game with no direct control — fails "likes tinkering"
outright. It was rebuilt as **Standing Orders**, below, which keeps the
automation-first spirit but gives the player something to tune and a way to be
measurably wrong.

### A · The Bridge — you tinker with ships

One screen, no navigation. The engine flies everything; the player's job is to
notice the handful of situations where a human beats its defaults.

- **Triage queue** ranked by credits-per-hour of inaction. The top item is always
  what is costing you most right now — this is what turns a notification list
  into a game.
- Every alert states **what the engine will do on its own, and when**, so
  ignoring it is a legitimate choice with a visible price.
- **The map becomes the work surface** — ships animate along routes, lanes tinted
  by profitability, click a ship to command it in place.
- **Fleet table** sorted by earnings, with role as a dropdown. You are not
  steering hulls one at a time; you are retasking them and letting the autonomy
  re-plan.

*Loop:* scan → spot the outlier → retask or intervene → watch the rate move.

**Wins:** scales to 30 ships, rewards attention, every decision is scored.
**Costs:** the fiction mostly dies; dense and unfriendly on a first visit.

### B · Standing Orders — you tinker with the automation

You never touch a ship. You write the doctrine the engine flies by, then read
what it produced and adjust.

- **Every rule carries its own P&L.** The doctrine panel is a scoreboard as much
  as a settings screen — "margin floor `+22,100`", "fleet growth `−210,000`".
- **"Unruled losses"** is the sharpest number on the screen: credits that bled
  through gaps the doctrine doesn't cover. That is the game telling the player
  where to write the next rule.
- Decisions still arrive, but the important button is **"Make this doctrine"** —
  a one-off call becomes a standing rule, so fiddling compounds instead of
  repeating.

*Loop:* read the shift → find the loss → write or tune a rule → get scored next
shift.

**Wins:** automation-native, the tinkering accumulates, being wrong is
measurable.
**Costs:** slower feedback; needs the rule engine built before any of it means
anything.

### Where the balance sits

These are not opposites. Both keep the engine running and both give the player
something to fiddle with. The real difference is **what you tinker with and how
fast feedback returns**:

| | The Bridge | Standing Orders |
| --- | --- | --- |
| You tinker with | Ships | Rules |
| Feedback horizon | Seconds to minutes | Hours to shifts |
| Fixes | *That* situation | *Every future instance* |
| Session | 20 min, focused, at a desk | Read, adjust, walk away |
| The map | Primary work surface | Ambient |
| Reuses today | Map, ledger, stranded detection, loadout scoring | Narrator, co-pilot, activity feed, ledger |

---

## C · All three, ranked — the resolution

The owner wanted both alternatives *and* the current dashboard's reference data
(market snapshots, available hulls, price history). That is the right answer,
provided the surfaces are **ranked rather than peer**.

The eight-room problem was never *too many surfaces*. It was peer surfaces with
no hierarchy, so nothing was more important than anything else and the
cross-fleet question had nowhere to live. Three ranked views is a different
shape, because the three things operate on different objects and horizons:

| View | Acts on | Horizon | You go there when |
| --- | --- | --- | --- |
| **Bridge** *(default)* | a ship | seconds–minutes | Something is wrong now |
| **Doctrine** | a rule | hours–shifts | Something keeps happening |
| **Markets** | a question | on demand | You want to know what's out there |

### What keeps it from collapsing back into rooms

Each view hands off to the next **with state attached**, so one loop runs across
three surfaces rather than three apps sharing a topbar:

- **Bridge → Doctrine.** A triage card's third button is *"Make this doctrine"*,
  opening Doctrine with the rule pre-filled from the situation just resolved.
- **Doctrine → Markets.** *"Unruled losses"* is a link, opening Markets filtered
  to the goods and waypoints where the money actually leaked.
- **Markets → Bridge.** Buying a hull or committing to a route drops a task into
  triage rather than silently succeeding, so the consequence lands where you're
  watching.

### The Markets view fixes a live bug

It is the current dashboard's reference data kept whole, with routes re-ranked.
Today `bestTrades()` sorts by margin percentage, which is why IRON_ORE at 111%
reads as the best trade in the game when it is three units of volume 41 fuel
away. Ranking by profit per trip net of fuel puts the real earner on top. See the
corresponding finding in [`engineering-review.md`](engineering-review.md).

### Build order, by cost

The three are not equally expensive, and that should drive the order more than
taste does.

| View | Cost | Why |
| --- | --- | --- |
| **Markets** | Cheapest | Almost entirely a re-rank and re-layout of data already in SQLite. Snapshots, price history, shipyard inventory and module catalog all exist. |
| **Bridge** | Moderate | Map, ledger, stranded detection and per-ship goals exist. Missing: per-ship earnings attribution and a cost-of-inaction score. Both derivable from the ledger; neither computed today. |
| **Doctrine** | Most | Needs a rule engine that does not exist — rules evaluated each tick, plus attribution so every rule carries its own P&L. The attribution is the hard half, and it is the whole point. |

**Recommendation: Markets → Bridge → Doctrine.**

Markets first because it is nearly free and immediately fixes advice that is
currently wrong in both the UI and the co-pilot. Then Bridge, which makes the
fleet legible and supplies the rate to judge everything else by. Then Doctrine,
once time in triage has shown which decisions you keep making by hand — the rules
worth writing are the ones you have already made three times.

Each stage stands alone. Markets is useful without Bridge; Bridge is useful
without Doctrine. Nothing is stranded half-built if you stop.
