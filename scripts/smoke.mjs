// Live smoke test: node scripts/smoke.mjs [url]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(process.argv[2] ?? "http://localhost:3000/mcp")));
console.log("tools:", (await client.listTools()).tools.map(t => t.name).join(", "));
const call = async (name, args) => { const t = Date.now(); const r = await client.callTool({ name, arguments: args }); console.log(`\n===== ${name} ${JSON.stringify(args)} (${Date.now() - t} ms)${r.isError ? " ERROR" : ""}\n${r.content[0].text}`); return r; };
const s = await call("search_markets", { query: "Fed rate", limit: 4 });
const json = JSON.parse(s.content[1].text.replace(/^```json\n|\n```$/g, ""));
const poly = json.markets.find(m => m.venue === "polymarket"), kal = json.markets.find(m => m.venue === "kalshi");
if (poly) await call("get_market_odds", { venue: "polymarket", id: poly.id });
if (kal) await call("get_market_odds", { venue: "kalshi", id: kal.id });
await call("compare_markets", { query: "Fed decision October 2026", limit: 5 });
await call("market_briefing", { topic: "Bitcoin", limit: 5 });
await call("trending_markets", { limit: 3 });
await client.close();
