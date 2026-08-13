import "dotenv/config";
import { getToken, saveToken, registerAgent } from "../core/auth.js";
import { Client, SpaceTradersAPI } from "../core/client.js";
import { MarketIntel } from "../engine/market.js";
import { ContractManager } from "../engine/contract.js";
import { FleetManager } from "../engine/fleet.js";
import { Store } from "../engine/store.js";
import { FleetState } from "../engine/state.js";
import { ChatAgent } from "../engine/agentChat.js";
import { startServer } from "../server/index.js";

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main(): Promise<void> {
  const maxTicks = Number(process.env.ST_MAX_TICKS ?? process.argv[2] ?? "100000");
  const faction = process.env.ST_FACTION ?? "COSMIC";
  const noRegister = process.argv.includes("--no-register");
  const agentSymbol = process.env.ST_AGENT_SYMBOL;

  let token = getToken();
  if (!token && !noRegister) {
    if (!agentSymbol) {
      log("No token found and no agent symbol set. Set ST_TOKEN or ST_AGENT_SYMBOL.");
      process.exit(1);
    }
    if (!process.env.ST_ACCOUNT_TOKEN) {
      log(
        "To register a new agent you need an account token. Get one at https://my.spacetraders.io (Settings → Generate Account Token), then set ST_ACCOUNT_TOKEN.",
      );
      process.exit(1);
    }
    log(`Registering agent ${agentSymbol} with faction ${faction}...`);
    const res = await registerAgent(agentSymbol, faction);
    saveToken(res.token);
    token = res.token;
    log(`Registered ${res.agentSymbol} (HQ ${res.headquarters}), starting with ${res.credits} credits`);
  }
  if (!token) {
    log("No token available. Set ST_TOKEN or remove --no-register.");
    process.exit(1);
  }

  const client = new Client({
    token,
    onRateLimited: (sec, attempt) => log(`rate limited, backing off ${sec}s (attempt ${attempt})`),
  });
  const api = new SpaceTradersAPI(client, token);
  const store = new Store();
  const state = new FleetState();
  const serverOpts: { state: FleetState; store: Store; fleet?: FleetManager; chat?: ChatAgent; port?: number } = { state, store };
  startServer(serverOpts);

  const agent = await api.getMyAgent();
  const systemSymbol = agent.headquarters.slice(0, agent.headquarters.lastIndexOf("-"));
  log(`Agent ${agent.symbol} @ ${agent.headquarters}, ${agent.credits} credits, ${agent.shipCount} ships`);

  const waypoints = await api.getAllSystemWaypoints(systemSymbol);
  const positions = waypoints.map((w) => ({ symbol: w.symbol, x: w.x, y: w.y, type: w.type }));

  log(`Discovering markets in ${systemSymbol} (${waypoints.length} waypoints)...`);
  state.update({
    agent,
    ships: [],
    contracts: [],
    systemSymbol,
    waypoints: waypoints.map((w) => ({ symbol: w.symbol, x: w.x, y: w.y, type: w.type, traits: w.traits.map((t) => t.symbol) })),
    systems: [{
      symbol: systemSymbol,
      waypoints: waypoints.map((w) => ({ symbol: w.symbol, x: w.x, y: w.y, type: w.type, traits: w.traits.map((t) => t.symbol) })),
      jumpGates: waypoints.filter((w) => w.type === "JUMP_GATE").map((w) => w.symbol),
    }],
    jumpConnections: [],
    totals: store.ledgerTotals(),
  });

  const intel = new MarketIntel(api);
  const markets = await intel.getSystemMarkets(systemSymbol);
  log(`Found ${markets.length} markets.`);
  for (const m of markets) {
    for (const g of Object.values(m.tradeGoods)) {
      store.recordMarket({
        systemSymbol: m.systemSymbol,
        waypointSymbol: m.symbol,
        goodSymbol: g.symbol,
        type: g.type,
        supply: g.supply,
        purchasePrice: g.purchasePrice,
        sellPrice: g.sellPrice,
        tradeVolume: g.tradeVolume,
      });
    }
  }

  const contracts = new ContractManager(api);
  const fleet = new FleetManager({
    api,
    contracts,
    store,
    log,
    recordLedger: (e) => store.recordLedger(e),
    onActivity: (kind, detail, credits) => store.recordActivity({ timestamp: new Date().toISOString(), shipSymbol: "fleet", kind, detail, credits }),
    minCashReserve: 20_000,
  });
  // The SpaceTraders API occasionally returns transient 500s during the burst of
  // init requests; retry the whole init indefinitely (long backoff) so the engine
  // self-heals when the API recovers instead of crashing on a bad response.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fleet.init(markets);
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`fleet init attempt ${attempt} failed (${msg}); retrying in ${Math.min(60, attempt * 5)}s`);
      await new Promise((r) => setTimeout(r, Math.min(60, attempt * 5) * 1000));
    }
  }
  serverOpts.fleet = fleet;
  // Co-pilot agent: read-only tactical AI for the command center chat panel.
  // Enabled when an LLM API key is configured (ST_LLM_API_KEY / ST_LLM_MODEL).
  if (process.env.ST_LLM_API_KEY || process.env.ST_LLM_MODEL) {
    serverOpts.chat = new ChatAgent({
      state,
      store,
      fleet,
      api,
      agentSymbol,
      onEvent: (e) => log(`[copilot] ${e.type}: ${e.detail}`),
    });
    log(`Co-pilot enabled (model ${process.env.ST_LLM_MODEL ?? "deepseek-v4-flash:0731"})`);
  }
  // Kick off any persistent construction missions (e.g. the jump gate) so they resume.
  const activeMissions = fleet.getMissions().filter((m) => m.status === "active");
  if (activeMissions.length > 0) {
    for (const m of activeMissions) await fleet.startMission(m.targetWaypoint);
  } else if (process.env.ST_MISSION_GATE) {
    await fleet.startMission(process.env.ST_MISSION_GATE);
  }

  // Refresh the shared dashboard snapshot on a slow cadence so it never
  // competes with the engine for the API rate limit.
  const refreshState = async () => {
    try {
      const agent = await api.getMyAgent();
      const ships = await api.listAllShips();
      const contracts = await api.getContracts();
      const systems = fleet.getGalaxy().listSystems().map((s) => ({
        symbol: s.symbol,
        waypoints: s.waypoints.map((w) => ({ symbol: w.symbol, x: w.x, y: w.y, type: w.type, traits: w.traits.map((t) => t.symbol) })),
        jumpGates: s.jumpGates.map((jg) => jg.symbol),
      }));
      state.update({
        agent,
        ships,
        contracts: contracts.filter((c) => !c.fulfilled),
        systemSymbol,
        waypoints: waypoints.map((w) => ({ symbol: w.symbol, x: w.x, y: w.y, type: w.type, traits: w.traits.map((t) => t.symbol) })),
        systems,
        jumpConnections: fleet.getGalaxy().jumpConnections(),
        totals: store.ledgerTotals(),
      });
    } catch (err) {
      log(`state refresh error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  await refreshState();
  setInterval(refreshState, 20_000);

  const accepted = await contracts.acceptBest();
  if (accepted) {
    log(`Accepted contract ${accepted.id.slice(0, 8)} (+${accepted.terms.payment.onAccepted} upfront)`);
  }

  let credits = agent.credits;
  const report = async () => {
    const a = await api.getMyAgent();
    const total = await store.ledgerTotals();
    log(
      `Status: ${a.credits} credits (net +${a.credits - credits}), ships=${a.shipCount}, ` +
        `ledger sells=${total.sells}, buys=${total.buys}`,
    );
    credits = a.credits;
  };

  await report();
  await fleet.run(maxTicks);
  await report();
  store.close();
  log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
