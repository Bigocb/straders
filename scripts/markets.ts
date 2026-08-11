import { Client, SpaceTradersAPI } from "../src/core/client.js";
import { getToken } from "../src/core/auth.js";
const token = getToken()!;
const api = new SpaceTradersAPI(new Client({ token }), token);
const sys = await api.getSystemWaypoints("X1-BY69");
const mw = sys.filter(w=>w.traits.some(t=>t.symbol==="MARKETPLACE"));
for (const w of mw) {
  const m = await api.getMarket("X1-BY69", w.symbol);
  console.log(`== ${w.symbol}`);
  for (const g of m.tradeGoods ?? [])
    console.log(`   ${g.symbol.padEnd(22)} ${g.type.padEnd(8)} buy=${g.purchasePrice} sell=${g.sellPrice} vol=${g.tradeVolume} supply=${g.supply}`);
}
