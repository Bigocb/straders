# Reviews

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
