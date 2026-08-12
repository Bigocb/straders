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
const p = await b.newPage({ viewport: { width: 1680, height: 950 } });
p.on("console", (m) => { if (m.type() === "error" && !envNoise(m.text())) errors.push(m.text()); });
p.on("pageerror", (e) => errors.push("UNCAUGHT: " + e.message));
await fetch("http://127.0.0.1:4173/__reset", { method: "POST" });
await p.goto("http://127.0.0.1:4173/index.html", { waitUntil: "networkidle" });
await p.waitForTimeout(1800);
const text = (s) => p.locator(s).first().innerText().catch(() => "");

// ── topbar: the rate is the score ──────────────────────────
ok((await text("#credits")).includes("412,500"), "credits shown");
ok(/\+18,200/.test(await text("#rate")), "rate shown as credits/hr (the scoreboard)");
ok((await text("#rate")).includes("▲"), "rate shows trend vs previous hour");
ok(await p.locator("#spark polyline").count() === 1, "sparkline drawn");
ok((await text("#forgone")).includes("2,300"), "forgone (cost of inaction) shown");

// ── Bridge ─────────────────────────────────────────────────
ok(await p.locator('.view[data-view="bridge"]').isVisible(), "Bridge is the default view");
ok(await p.locator("#triage .alert").count() === 3, "triage queue populated");
const first = await text("#triage .alert:first-child");
ok(/AG-2 stranded/.test(first), "highest cost-of-inaction item is first");
ok(/1,400/.test(first), "triage item shows its hourly cost");
ok(/Fuel tender dispatches/.test(first), "triage shows what the engine will do on its own");
ok(/no plan/.test(await text("#triage .alert:nth-child(2)")), "items the engine can't handle say so");
ok(await p.locator("#fleet-table tbody tr").count() === 6, "fleet table lists every hull");
ok((await text("#fleet-table")).includes("+6,110"), "per-ship earnings shown");
ok(await p.locator("#fleet-table tbody tr.warn").count() === 1, "stranded row flagged");
ok(await p.locator("#stranded-banner").isVisible(), "stranded banner visible");
ok(await p.locator("#map circle, #map g").count() > 0, "map renders");
ok((await text("#ticker")).length > 10, "ledger ticker populated");
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
await p.screenshot({ path: `${OUT}/syn-markets.png` });

// ── co-pilot drawer ────────────────────────────────────────
ok(!(await p.locator("#copilot").evaluate((e) => e.classList.contains("open"))), "co-pilot starts closed");
await p.click("#copilot-toggle");
await p.waitForTimeout(400);
ok(await p.locator("#copilot").evaluate((e) => e.classList.contains("open")), "co-pilot opens from any view");
await p.keyboard.press("Escape");
await p.waitForTimeout(300);
ok(!(await p.locator("#copilot").evaluate((e) => e.classList.contains("open"))), "Escape closes the co-pilot");

// ── keyboard nav + responsive ──────────────────────────────
await p.keyboard.press("1");
await p.waitForTimeout(300);
ok(await p.locator('.view[data-view="bridge"]').isVisible(), "number keys switch views");
await p.setViewportSize({ width: 860, height: 900 });
await p.waitForTimeout(400);
ok(!(await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)), "no horizontal scroll at 860px");
await p.screenshot({ path: `${OUT}/syn-narrow.png` });

console.log("\n--- console errors ---");
console.log(errors.length ? errors.join("\n") : "(none)");
ok(errors.length === 0, "no console/page errors");
await b.close();
console.log(fail.length ? `\n${fail.length} FAILING:\n- ${fail.join("\n- ")}` : "\nALL CHECKS PASSED");
process.exit(fail.length ? 1 : 0);
