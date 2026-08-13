# Docs

## Greenfield architecture

A ground-up redesign of the fleet engine, using the current feature set as the
spec. Written after an audit that found four critical defects, all of them the
same root cause: eight independent mechanisms can each claim a ship, and none of
them can see the others.

| Document | Covers |
| --- | --- |
| [`greenfield-design.md`](greenfield-design.md) | **Start here.** The target architecture — one ship/one owner, cargo that carries its intent, a single scheduler holding the API budget, persisted per-ship state, and a split read model. Includes the eight invariants the whole design exists to enforce. |
| [`greenfield-migration.md`](greenfield-migration.md) | How to get there without losing the fleet — eight strangler-fig stages, each shippable and revertable on its own, with the dual-write/parity technique that makes each one safe. |

Stage 0 of the migration is five small independent fixes worth doing regardless
of whether the rest happens: they take back roughly 90% of the coordinator's API
budget and remove a live Halt hazard.

## Reviews

Two reviews of Startraders, carried out against commit `1e8da27`. Status notes in
each reflect the current head of `claude/space-traders-assessment-t1d5aq`.

| Document | Covers |
| --- | --- |
| [`engineering-review.md`](engineering-review.md) | Security, correctness, performance and architecture of the engine, server and dashboard. **Starts with the one critical item: the command centre has no authentication.** |
| [`game-design-review.md`](game-design-review.md) | The command centre as a *game* — why the player has no loop, six failures of play, and two alternative directions. |

## Mockups

Standalone HTML, no build step and no external assets. Open directly in a
browser.

| File | What it is |
| --- | --- |
| [`mockups/game-design-review.html`](mockups/game-design-review.html) | The game-design review with layout wireframes for the current UI and both alternatives. |
| [`mockups/bridge-and-standing-orders.html`](mockups/bridge-and-standing-orders.html) | Interactive desktop mockups of both alternatives, populated with a realistic seven-ship fleet. Toggle between them at the top. |

Both render dark; the review page adapts to the viewer's light/dark preference,
and the mockups commit to dark deliberately because they depict a dark cockpit
UI.
