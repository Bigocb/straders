import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
const OUT = process.env.UI_SHOT_DIR ?? "/tmp";
const errors = [], fail = [];
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fail.push(m); };
const envNoise = (t) => /fonts\.(googleapis|gstatic)|favicon|ERR_CONNECTION_RESET|status of 404/.test(t);

// Use a preinstalled Chromium when one is configured, otherwise let
// playwright-core find its own. Skips cleanly when neither is available.
const EXE = process.env.CHROMIUM_PATH
  || [
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ].find((p) => existsSync(p));
let b;
try {
  b = await chromium.launch(EXE ? { executablePath: EXE } : {});
} catch (err) {
  console.log("SKIP  no Chromium available — set CHROMIUM_PATH to run the UI smoke test");
  console.log("      " + err.message.split("\n")[0]);
  process.exit(0);
}
// ── auth gate: a server that requires a token ────────────────
// Simulated via request interception on a throwaway page rather than the
// shared mock server, which intentionally runs with no ST_DASHBOARD_TOKEN
// (matching local/dev use) for every other check in this file.
{
  const gp = await b.newPage({ viewport: { width: 1000, height: 800 } });
  await gp.route("**/api/**", (route) => {
    const auth = route.request().headers()["authorization"];
    if (auth !== "Bearer right-token") {
      return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "unauthorized" }) });
    }
    return route.continue();
  });
  await gp.goto("http://127.0.0.1:4173/index.html", { waitUntil: "networkidle" });
  await gp.waitForTimeout(600);
  ok(await gp.locator("#auth-gate").isVisible(), "auth gate shown when the server requires a token");
  ok(await gp.locator("#app-root").isHidden(), "dashboard hidden behind the gate");

  await gp.fill("#auth-token", "wrong-token");
  await gp.click("#auth-submit");
  await gp.waitForTimeout(500);
  ok((await gp.locator("#auth-err").innerText()).length > 0, "wrong token shows an error, not a silent failure");
  ok(await gp.locator("#auth-gate").isVisible(), "gate stays up on a wrong token");

  await gp.fill("#auth-token", "right-token");
  await gp.click("#auth-submit");
  await gp.waitForTimeout(800);
  ok(await gp.locator("#auth-gate").isHidden(), "correct token clears the gate");
  ok(await gp.locator("#app-root").isVisible(), "dashboard renders once authenticated");
  ok((await gp.locator("#credits").innerText()).includes("412,500"), "dashboard actually loaded data after auth");

  await gp.close();
}

const p = await b.newPage({ viewport: { width: 1680, height: 950 } });
p.on("console", (m) => { if (m.type() === "error" && !envNoise(m.text())) errors.push(m.text()); });
p.on("pageerror", (e) => errors.push("UNCAUGHT: " + e.message));
await fetch("http://127.0.0.1:4173/__reset", { method: "POST" });
await p.goto("http://127.0.0.1:4173/index.html", { waitUntil: "networkidle" });
await p.waitForTimeout(1800);
const text = (s) => p.locator(s).first().innerText().catch(() => "");
// Grid children default to min-width:auto, so unbreakable content (the
// ticker's nowrap feed, long fleet-table rows) can silently push a track —
// and the whole page — wider than the viewport. scrollWidth vs clientWidth
// on the root element is the reliable way to catch that; a visible
// scrollbar isn't a given depending on OS/browser chrome.
const noHScroll = (label) => p.evaluate(() =>
  document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
).then((overflowing) => ok(!overflowing, `no page-level horizontal scroll ${label}`));

// A server with no ST_DASHBOARD_TOKEN configured (this mock) must never
// show the gate — a local/dev user should never have to enter a token
// nothing on the server checks.
ok(await p.locator("#auth-gate").isHidden(), "auth gate skipped when the server doesn't require a token");
ok(await p.locator("#app-root").isVisible(), "dashboard visible without a token");
// `authed` (not authToken, which stays "" forever with no token configured)
// gates the whole timer-based polling loop. If this is false here, every
// every() timer silently never fires and nothing auto-refreshes — exactly
// the bug this session fixed.
ok(await p.evaluate(() => authed) === true, "past the gate with no token, the polling loop is still armed (authed, not authToken, gates it)");

// ── topbar: the rate is the score ──────────────────────────
ok((await text("#credits")).includes("412,500"), "credits shown");
ok(/\+18,200/.test(await text("#rate")), "rate shown as credits/hr (the scoreboard)");
ok((await text("#rate")).includes("▲"), "rate shows trend vs previous hour");
ok(await p.locator("#spark polyline").count() === 1, "sparkline drawn");
ok((await text("#forgone")).includes("2,300"), "forgone (cost of inaction) shown");

// ── Bridge ─────────────────────────────────────────────────
ok(await p.locator('.view[data-view="bridge"]').isVisible(), "Bridge is the default view");
ok(await p.locator("#triage .alert").count() === 4, "triage queue populated");
const first = await text("#triage .alert:first-child");
ok(/AG-2 stranded/.test(first), "highest cost-of-inaction item is first");
ok(/1,400/.test(first), "triage item shows its hourly cost");
ok(/Fuel tender dispatches/.test(first), "triage shows what the engine will do on its own");
ok(/no plan/.test(await text("#triage .alert:nth-child(2)")), "items the engine can't handle say so");
// Two "earning nothing" cards for different ships must show DIFFERENT costs —
// this is the actual bug reported: every idle ship rendered the same number.
const idleCosts = await p.locator("#triage .alert .cost").allInnerTexts();
const uniqueCosts = new Set(idleCosts.map((t) => t.trim()));
ok(uniqueCosts.size === idleCosts.length, `triage costs are per-ship, not one repeated number (got ${JSON.stringify(idleCosts)})`);
ok(await p.locator("#fleet-table tbody tr").count() === 6, "fleet table lists every hull");
ok((await text("#fleet-table")).includes("+6,110"), "per-ship earnings shown");
ok(await p.locator("#fleet-table tbody tr.warn").count() === 1, "stranded row flagged");
ok(await p.locator("#stranded-banner").isVisible(), "stranded banner visible");
ok(await p.locator("#map circle, #map g").count() > 0, "map renders");
ok((await text("#ticker")).length > 10, "ledger ticker populated");
await noHScroll("on Bridge at 1680px");
await p.screenshot({ path: `${OUT}/syn-bridge.png` });

// sorting the fleet table
await p.click('#fleet-table th[data-key="fuel"]');
await p.waitForTimeout(200);
ok(await p.locator('#fleet-table th[data-key="fuel"].sorted').count() === 1, "fleet table sorts on click");

// triage action hits the per-ship endpoint, not a fleet-wide one
await p.click('#triage .alert:first-child button[data-kind="refuel"]');
await p.waitForTimeout(500);
let posted = await (await fetch("http://127.0.0.1:4173/__posted")).json();
ok(posted.some((x) => x.path === "/api/fleet/refuel" && x.body.shipSymbol === "AG-2"), "triage action targets the right ship");
ok(!posted.some((x) => x.path === "/api/fleet/pause"), "triage never reaches for the fleet-wide halt");

// ── Bridge: ship modal manual control ───────────────────────
// AG-1 is a miner sitting on an asteroid field: it should offer Hold and a
// field pin, not just the generic loadout panels.
await p.click('#fleet-table tbody tr[data-ship="AG-1"]');
await p.waitForTimeout(300);
ok(await p.locator("#trade-backdrop.open").isVisible(), "ship modal opens from the fleet table");
ok((await text("#trade-modal")).includes("Manual control"), "manual control section present");
ok(await p.locator('#trade-modal button.hold').count() === 1, "Hold offered for a doctrine-controlled ship");
ok(await p.locator('#trade-modal select.mine-field').count() === 1, "mining field picker offered for a miner");

await p.selectOption('#trade-modal select.mine-field', "X1-AA-E5");
await p.click('#trade-modal button.pin-mine');
await p.waitForTimeout(400);
posted = await (await fetch("http://127.0.0.1:4173/__posted")).json();
ok(posted.some((x) => x.path === "/api/fleet/mine" && x.body.shipSymbol === "AG-1" && x.body.waypointSymbol === "X1-AA-E5"), "pinning a field posts the ship and waypoint");

await p.click('#trade-modal button.hold');
await p.waitForTimeout(400);
posted = await (await fetch("http://127.0.0.1:4173/__posted")).json();
ok(posted.some((x) => x.path === "/api/fleet/hold" && x.body.shipSymbol === "AG-1"), "Hold posts to /api/fleet/hold");

// AG-3 is marked paused by the mock fleet/status, so its modal should offer
// Release instead of Hold.
await p.click('#trade-modal .close');
await p.waitForTimeout(200);
await p.click('#fleet-table tbody tr[data-ship="AG-3"]');
await p.waitForTimeout(300);
ok(await p.locator('#trade-modal button.release').count() === 1, "a held ship offers Release, not Hold");
await p.click('#trade-modal .close');

// ── Doctrine ───────────────────────────────────────────────
await p.click('#view-switch button[data-view="doctrine"]');
await p.waitForTimeout(900);
ok(await p.locator('.view[data-view="doctrine"]').isVisible(), "Doctrine view opens");
ok(await p.locator("#rules .rule").count() === 6, "all doctrine rules listed");
ok((await text("#rules")).includes("Cash floor"), "rules are named in plain language");
ok(await p.locator("#rules .rule .tag.live").count() === 6, "rules marked as actually applied");
ok(await p.locator("#rules .rule.off").count() === 1, "a disabled rule renders as off");
ok((await text("#shift-log")).length > 10, "shift log populated");
ok((await text("#narrative")).includes("Quiet shift"), "captain's log shown");
ok(/net ledger/i.test(await text("#verdict")), "verdict bar shown");
await noHScroll("on Doctrine at 1680px");
await p.screenshot({ path: `${OUT}/syn-doctrine.png` });

// editing a rule persists through the API
const num = p.locator('#rules .rule[data-key="cashFloor"] input[type=number]');
await num.fill("45000");
await num.press("Enter");
await p.waitForTimeout(600);
posted = await (await fetch("http://127.0.0.1:4173/__posted")).json();
const d = posted.filter((x) => x.path === "/api/doctrine").pop();
ok(d && d.body.key === "cashFloor" && d.body.value === 45000, `editing a rule POSTs it (${JSON.stringify(d?.body)})`);
await p.waitForTimeout(300);
ok((await p.locator('#rules .rule[data-key="cashFloor"] input[type=range]').inputValue()) === "45000", "slider and number field stay in sync");

await p.click('#rules .rule[data-key="marginFloor"] .sw');
await p.waitForTimeout(600);
posted = await (await fetch("http://127.0.0.1:4173/__posted")).json();
ok(posted.some((x) => x.path === "/api/doctrine" && x.body.key === "marginFloor" && x.body.enabled === false), "toggling a rule off POSTs enabled:false");

// ── Markets ────────────────────────────────────────────────
await p.click('#view-switch button[data-view="markets"]');
await p.waitForTimeout(1200);
ok(await p.locator('.view[data-view="markets"]').isVisible(), "Markets view opens");
const routes = await p.locator("#routes .route").allInnerTexts();
ok(routes.length === 3, "routes listed");
ok(/CLOTHING/.test(routes[0]), "routes ranked by profit per trip — CLOTHING first");
ok(/IRON_ORE/.test(routes[2]), "the 111% margin route ranks LAST, not first");
ok(/111\.1%/.test(routes[2]) && /\+12\/trip/.test(routes[2]), "the misleading margin is shown alongside the real profit");
ok((await text("#routes .callout")).includes("not margin percentage"), "callout explains the ranking change");
ok(/134m old/.test(routes[1]), "stale snapshots are flagged");
ok((await text("#snapshots")).includes("CLOTHING"), "market snapshots shown");
ok(await p.locator("#price-good option").count() === 3, "price picker populated");
ok(await p.locator("#price-chart svg path").count() >= 2, "price history chart drawn");
ok((await text("#shipyard-intel")).includes("Mining Drone"), "yards and modules shown");
const dispatchRows = await p.locator("#dispatch-list .dispatch-row").allInnerTexts();
ok(dispatchRows.length === 3, "dispatch list shows every assignment");
ok(dispatchRows.some((r) => /AG-1/.test(r) && /A1 → C3/.test(r) && !/buy|sell/i.test(r)), "a direct assignment shows its buy→sell route with no role tag");
ok(dispatchRows.some((r) => /AG-3/.test(r) && /buy/i.test(r) && /C3 → warehouse/.test(r)), "a buy-role assignment is tagged and routes to the warehouse");
ok(dispatchRows.some((r) => /AG-4/.test(r) && /sell/i.test(r) && /warehouse → A1/.test(r) && /manual/i.test(r)), "a sell-role assignment is tagged, routes from the warehouse, and shows manual source");
ok((await text("#warehouse-count")).includes("AG-5"), "warehouse pane shows the designated ship");
const warehouseRows = await p.locator("#warehouse-goods .warehouse-row").allInnerTexts();
ok(warehouseRows.length === 2, "warehouse goods listed");
ok(warehouseRows.some((r) => /IRON_ORE/.test(r) && /120u/.test(r) && /2,160c/.test(r)), "warehouse row shows units and value");
// Both dropdowns are built from dispatchRoutes' *good* field, not goodSymbol
// (that name only exists on the separate /api/markets shape) — regression
// coverage for a bug where both silently rendered blank options.
const dispatchGoodOptions = await p.locator("#dispatch-good option").allTextContents();
ok(dispatchGoodOptions.includes("IRON_ORE") && dispatchGoodOptions.every((o) => o.length > 0), "dispatch good picker has real, non-blank options");
const warehouseGoodOptions = await p.locator("#warehouse-good option").allTextContents();
ok(warehouseGoodOptions.includes("IRON_ORE") && warehouseGoodOptions.includes("CLOTHING") && warehouseGoodOptions.every((o) => o.length > 0), "warehouse good picker has real, non-blank options");
ok((await text("#warehouse-summary")).includes("17,680c"), "warehouse total value shown");
ok(await p.locator("#warehouse-warning .callout.warn").count() === 0, "no warning while a warehouse ship is designated");

const warehouseTargetRows = await p.locator("#warehouse-targets .warehouse-target-row").allInnerTexts();
ok(warehouseTargetRows.length === 1, "warehouse curated targets listed");
ok(warehouseTargetRows.some((r) => /IRON_ORE/.test(r) && /300u/.test(r) && !/mission/i.test(r)), "curated target row shows the good and target units, no mission tag when not flagged");

await p.fill("#warehouse-target-good", "gold");
await p.fill("#warehouse-target-units", "50");
await p.check("#warehouse-target-mission");
await p.click("#warehouse-target-add");
await p.waitForTimeout(300);
const targetRowsAfterAdd = await p.locator("#warehouse-targets .warehouse-target-row").allInnerTexts();
ok(targetRowsAfterAdd.length === 2, "adding a curated good adds a row");
ok(targetRowsAfterAdd.some((r) => /GOLD/.test(r) && /50u/.test(r) && /mission/i.test(r)), "the new row shows the good uppercased, its target, and the mission tag");
ok((await p.inputValue("#warehouse-target-good")) === "", "the good input clears after adding");
ok(!(await p.isChecked("#warehouse-target-mission")), "the mission checkbox clears after adding");

await p.locator('#warehouse-targets button[data-remove-good="GOLD"]').click();
await p.waitForTimeout(300);
const targetRowsAfterRemove = await p.locator("#warehouse-targets .warehouse-target-row").allInnerTexts();
ok(targetRowsAfterRemove.length === 1, "removing a curated good removes its row");

// Goods on the books with no ship holding them (e.g. from a manual Adjust
// before ever designating a ship) must be flagged, not shown as if they
// were real cargo. Exercised directly against the render function so this
// doesn't require a second mock-server scenario.
await p.evaluate(() => {
  warehouseState = { ship: null, goods: [{ goodSymbol: "IRON_ORE", units: 10, avgCost: 5, value: 50 }], totalValue: 50, ledger: [] };
  renderWarehouse();
});
ok((await text("#warehouse-warning")).includes("No warehouse ship designated"), "warns when goods are on the books with no ship to hold them");
ok((await text("#warehouse-warning")).includes("bookkeeping only"), "explains that it's bookkeeping only, not real cargo");
await p.evaluate(() => { warehouseState = { ship: null, goods: [], totalValue: 0, ledger: [] }; renderWarehouse(); });
ok(await p.locator("#warehouse-warning .callout.warn").count() === 0, "no warning when the warehouse is genuinely empty");
await p.evaluate(() => loadWarehouse()); // restore the real mocked state for the screenshot below

// Dispatch and Keeper stations used to only ever load once, when you first
// clicked into Markets — staying on the tab (or backgrounding it and coming
// back) left them stale forever. visibilitychange now re-runs loadViewData
// for whatever's on screen; simulate "tab became visible again" directly
// since Playwright's page is never actually hidden.
const staleRefreshCalls = await p.evaluate(() => {
  window.__calls = { dispatch: 0, keepers: 0 };
  const origDispatch = loadDispatch, origKeepers = loadKeepers;
  loadDispatch = (...a) => { window.__calls.dispatch++; return origDispatch(...a); };
  loadKeepers = (...a) => { window.__calls.keepers++; return origKeepers(...a); };
  document.dispatchEvent(new Event("visibilitychange"));
  return true;
});
await p.waitForTimeout(300);
const refreshCalls = await p.evaluate(() => window.__calls);
ok(staleRefreshCalls && refreshCalls.dispatch >= 1, "returning to a visible tab refreshes the Dispatch pane, not just header stats");
ok(refreshCalls.keepers >= 1, "returning to a visible tab refreshes the Keeper stations pane too");

await noHScroll("on Markets at 1680px");
await p.screenshot({ path: `${OUT}/syn-markets.png` });

// ── Ops: contracts & construction missions ──────────────────
await p.click('#view-switch button[data-view="ops"]');
await p.waitForTimeout(900);
ok(await p.locator('.view[data-view="ops"]').isVisible(), "Ops view opens");
ok(await p.locator("#contracts .ops-card").count() === 1, "contract card shown");
ok((await text("#contracts")).includes("PROCUREMENT"), "contract type shown");
ok((await text("#contracts")).includes("IRON_ORE"), "contract delivery good shown");
ok((await text("#contracts")).includes("34/100"), "contract delivery progress shown");
ok(await p.locator("#missions .ops-card").count() === 1, "mission card shown");
ok((await text("#missions")).includes("480/1200"), "mission material progress shown");
await noHScroll("on Ops at 1680px");
await p.screenshot({ path: `${OUT}/syn-ops.png` });

await p.click('#contracts button[data-act="accept"]');
await p.waitForTimeout(400);
posted = await (await fetch("http://127.0.0.1:4173/__posted")).json();
ok(posted.some((x) => x.path === "/api/contracts/accept" && x.body.contractId === "c1"), "accepting a contract posts its id");

await p.click('#missions button[data-act="pause"]');
await p.waitForTimeout(400);
posted = await (await fetch("http://127.0.0.1:4173/__posted")).json();
ok(posted.some((x) => x.path === "/api/missions/pause" && x.body.waypoint === "X1-AA-D4"), "holding a mission posts its waypoint");

// Choosing a ship for a mission: the picker offers miners/traders (AG-1,
// AG-2 miners, plus AG-3 the mission's own current carrier), not the tour
// or surveyor ships.
const carrierOptions = await p.locator('#missions select.assign-carrier option').allInnerTexts();
ok(carrierOptions.some((t) => /^1$/.test(t.trim())) && carrierOptions.some((t) => /^2$/.test(t.trim())), `carrier picker offers cargo-capable ships (got ${JSON.stringify(carrierOptions)})`);
await p.selectOption('#missions select.assign-carrier', "AG-1");
await p.click('#missions button[data-act="assign"]');
await p.waitForTimeout(400);
posted = await (await fetch("http://127.0.0.1:4173/__posted")).json();
ok(posted.some((x) => x.path === "/api/missions/assign" && x.body.waypoint === "X1-AA-D4" && x.body.shipSymbol === "AG-1"), "assigning a carrier posts the ship and mission");

// ── co-pilot drawer ────────────────────────────────────────
ok(!(await p.locator("#copilot").evaluate((e) => e.classList.contains("open"))), "co-pilot starts closed");
await p.click("#copilot-toggle");
await p.waitForTimeout(400);
ok(await p.locator("#copilot").evaluate((e) => e.classList.contains("open")), "co-pilot opens from any view");

// Sending a message must actually reach the backend and render the reply —
// a real regression: sendChat referenced undeclared chatInput/chatSend/
// chatStatus/chatLog globals, so clicking Send threw a ReferenceError before
// the fetch ever happened and silently did nothing.
await p.fill("#chat-input", "how's the fleet doing?");
await p.click("#chat-send");
await p.waitForTimeout(500);
posted = await (await fetch("http://127.0.0.1:4173/__posted")).json();
ok(posted.some((x) => x.path === "/api/chat" && x.body.message === "how's the fleet doing?"), "sending a message posts it to /api/chat");
ok((await text("#chat-log")).includes("how's the fleet doing?"), "the user's message appears in the log");
ok((await text("#chat-log")).includes("mock co-pilot heard"), "the co-pilot's reply is rendered");
ok((await p.inputValue("#chat-input")) === "", "the input clears after sending");

await p.keyboard.press("Escape");
await p.waitForTimeout(300);
ok(!(await p.locator("#copilot").evaluate((e) => e.classList.contains("open"))), "Escape closes the co-pilot");

// ── keyboard nav + responsive ──────────────────────────────
await p.keyboard.press("1");
await p.waitForTimeout(300);
ok(await p.locator('.view[data-view="bridge"]').isVisible(), "number keys switch views");

// A common laptop width, above the 900px breakpoint where the grid is still
// multi-column — this is the width the original bug report came from.
await p.setViewportSize({ width: 1440, height: 900 });
await p.waitForTimeout(400);
await noHScroll("on Bridge at 1440px (laptop width)");

await p.setViewportSize({ width: 860, height: 900 });
await p.waitForTimeout(400);
await noHScroll("at 860px");
await p.screenshot({ path: `${OUT}/syn-narrow.png` });

// ── mobile page ───────────────────────────────────────────
// Below 680px the tab-based desktop layout gives way entirely to a single
// curated page (glance data + missions/contracts/warehouse/dispatch/doctrine
// controls) rather than reflowing six dense desktop panes onto a phone.
await p.setViewportSize({ width: 390, height: 3200 });
await p.waitForTimeout(500);
ok(await p.locator("#view-switch").isHidden(), "the desktop tab switcher is hidden on the mobile page");
ok(await p.locator("#mobile-view").isVisible(), "the mobile page is shown instead");
ok(await p.locator('.view[data-view="bridge"]').isHidden(), "desktop views are hidden, not just the tab switcher");

ok((await text("#mobile-triage")).includes("stranded"), "mobile page shows the same triage alerts as Bridge");
const mobileFleetRows = await p.locator("#mobile-fleet .dispatch-row").allInnerTexts();
ok(mobileFleetRows.length === 6, "mobile fleet summary lists every ship");
ok(mobileFleetRows.some((r) => /AG-1/.test(r) && /miner/.test(r)), "mobile fleet row shows ship and role");

ok((await text("#mobile-contracts")).includes("PROCUREMENT"), "mobile page shows contracts");
ok((await text("#mobile-missions")).includes("ADVANCED_CIRCUITRY"), "mobile page shows construction missions");

ok((await text("#mobile-warehouse-summary")).includes("AG-5"), "mobile page shows the warehouse ship");
const mobileWarehouseRows = await p.locator("#mobile-warehouse-goods .warehouse-row").allInnerTexts();
ok(mobileWarehouseRows.some((r) => /IRON_ORE/.test(r) && /2,160c/.test(r)), "mobile warehouse row shows the full value, not clipped");

await p.fill("#mobile-warehouse-target-good", "silicon");
await p.fill("#mobile-warehouse-target-units", "75");
await p.click("#mobile-warehouse-target-add");
await p.waitForTimeout(300);
const mobileTargetRowsAfterAdd = await p.locator("#mobile-warehouse-targets .warehouse-target-row").allInnerTexts();
ok(mobileTargetRowsAfterAdd.some((r) => /SILICON/.test(r) && /75u/.test(r) && !/mission/i.test(r)), "adding a curated good from the mobile page adds a row, no mission tag when unchecked");
await p.locator('#mobile-warehouse-targets button[data-remove-good="SILICON"]').click();
await p.waitForTimeout(300);
const mobileTargetRowsAfterRemove = await p.locator("#mobile-warehouse-targets .warehouse-target-row").allInnerTexts();
ok(!mobileTargetRowsAfterRemove.some((r) => /SILICON/.test(r)), "removing a curated good from the mobile page removes its row");

const mobileDispatchRows = await p.locator("#mobile-dispatch .dispatch-row").allInnerTexts();
ok(mobileDispatchRows.some((r) => /AG-3/.test(r) && /warehouse/.test(r)), "mobile dispatch shows warehouse routing, not truncated");

const mobileDoctrineRows = await p.locator("#mobile-doctrine .dispatch-row").allInnerTexts();
ok(mobileDoctrineRows.length >= 5, "mobile page lists doctrine rules as toggles");
ok(mobileDoctrineRows.some((r) => /Cash floor/.test(r)), "mobile doctrine toggle shows the rule name");
ok(!(await p.locator("#mobile-doctrine input[type=range]").count()), "mobile doctrine is toggle-only, no value sliders");

// Toggling a rule from the mobile page must round-trip through the same
// /api/doctrine endpoint the desktop sliders use.
await p.locator('#mobile-doctrine .dispatch-row[data-key="marginFloor"] .sw').click();
await p.waitForTimeout(400);
posted = await (await fetch("http://127.0.0.1:4173/__posted")).json();
ok(posted.some((x) => x.path === "/api/doctrine" && x.body.key === "marginFloor"), "toggling a rule on the mobile page posts to /api/doctrine");

await noHScroll("on the mobile page at 390px");
await p.screenshot({ path: `${OUT}/syn-mobile.png`, fullPage: true });

console.log("\n--- console errors ---");
console.log(errors.length ? errors.join("\n") : "(none)");
ok(errors.length === 0, "no console/page errors");
await b.close();
console.log(fail.length ? `\n${fail.length} FAILING:\n- ${fail.join("\n- ")}` : "\nALL CHECKS PASSED");
process.exit(fail.length ? 1 : 0);
