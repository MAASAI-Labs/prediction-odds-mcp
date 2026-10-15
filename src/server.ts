import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as M from "./markets.js";

const venue = z.enum(["both", "polymarket", "kalshi"]).optional().describe("default both");
const run = (fn: (a: any) => Promise<{ markdown: string } & Record<string, unknown>>) => async (a: any) => {
  try { const r = await fn(a); return { content: [{ type: "text" as const, text: r.markdown }, { type: "text" as const, text: "```json\n" + JSON.stringify({ ...r, markdown: undefined }, null, 2) + "\n```" }] }; }
  catch (e) { return { isError: true, content: [{ type: "text" as const, text: (e as Error).message }] }; }
};

async function both(query: string, v: string, limit: number) {
  const [p, k] = await Promise.allSettled([
    v === "kalshi" ? Promise.resolve(null) : M.searchPolymarket(query, limit),
    v === "polymarket" ? Promise.resolve(null) : M.searchKalshi(query, limit),
  ]);
  const errors: string[] = []; const sources: M.Sourced["sources"] = [];
  const poly = p.status === "fulfilled" && p.value ? (sources.push(p.value.source), p.value.markets) : (p.status === "rejected" && errors.push("Polymarket: " + (p.reason as Error).message), []);
  if (k.status === "fulfilled" && k.value && !k.value.indexComplete) errors.push(`Kalshi: still indexing open events (${k.value.eventsIndexed} so far); results may be incomplete, retry in a few seconds`);
  const kal = k.status === "fulfilled" && k.value ? (sources.push(k.value.source), k.value.markets) : (k.status === "rejected" && errors.push("Kalshi: " + (k.reason as Error).message), []);
  if (!poly.length && !kal.length && errors.length) throw new Error(errors.join("; "));
  return { poly: poly as M.Market[], kal: kal as M.Market[], errors, sources };
}
const rank = (q: string) => (a: M.Market, b: M.Market) => M.similarity(q, `${b.event} ${b.title} ${b.outcome}`) - M.similarity(q, `${a.event} ${a.title} ${a.outcome}`) || (b.volume24h ?? 0) - (a.volume24h ?? 0);

export async function searchMarkets(a: { query: string; venue?: string; limit?: number }) {
  const limit = a.limit ?? 10;
  const r = await both(a.query, a.venue ?? "both", limit);
  const poly = r.poly.sort(rank(a.query)).slice(0, limit), kal = r.kal.sort(rank(a.query)).slice(0, limit);
  let md = `## Markets matching "${a.query}"\n\n` + (poly.length + kal.length ? M.marketTable([...poly, ...kal]) : "No open markets found.\n");
  if (r.errors.length) md += `\n> Partial results: ${r.errors.join("; ")}\n`;
  md += "\n" + M.sourcesMd(r.sources);
  return { markets: [...poly, ...kal], errors: r.errors, sources: r.sources, markdown: md };
}

export async function marketOdds(a: { venue: M.Venue; id: string }) {
  const r = await M.getMarket(a.venue, a.id); const m = r.market;
  let md = `## ${m.title}\n\n**${m.outcome}: ${M.pct(m.yesProbability)}** implied (${m.venue === "polymarket" ? "Polymarket" : "Kalshi"}) ${M.chg(m.change24h)} 24h\n\n- Bid / ask: ${m.yesBid ?? "-"} / ${m.yesAsk ?? "-"}  |  Last: ${m.lastPrice ?? "-"}\n- Volume: ${m.venue === "kalshi" ? (m.volume ?? "-") + " contracts" : M.usd(m.volume)}  |  24h: ${m.venue === "kalshi" ? (m.volume24h ?? "-") + " contracts" : M.usd(m.volume24h)}\n- Closes: ${m.closeTime ?? "-"}  |  Status: ${m.status}\n- Link: ${m.url}\n`;
  if (r.book && (r.book.bids.length || r.book.asks.length)) {
    md += `\n### Order book (YES, top 5)\n\n| Bid price | Size | Ask price | Size |\n|---:|---:|---:|---:|\n`;
    for (let i = 0; i < Math.max(r.book.bids.length, r.book.asks.length); i++) md += `| ${r.book.bids[i]?.[0] ?? ""} | ${r.book.bids[i]?.[1] ?? ""} | ${r.book.asks[i]?.[0] ?? ""} | ${r.book.asks[i]?.[1] ?? ""} |\n`;
  }
  md += "\n" + M.sourcesMd(r.sources);
  return { ...r, markdown: md };
}

export async function compare(a: { query?: string; polymarketSlug?: string; kalshiTicker?: string; minSimilarity?: number; limit?: number }) {
  let pairs: M.Pair[]; let sources: M.Sourced["sources"] = []; let errors: string[] = [];
  if (a.polymarketSlug && a.kalshiTicker) {
    const [p, k] = await Promise.all([M.getMarket("polymarket", a.polymarketSlug), M.getMarket("kalshi", a.kalshiTicker)]);
    sources = [...p.sources, ...k.sources];
    pairs = [{ polymarket: p.market, kalshi: k.market, similarity: +M.similarity(`${p.market.title} ${p.market.outcome}`, `${k.market.event} ${k.market.title} ${k.market.outcome}`).toFixed(3), gap: p.market.yesProbability !== null && k.market.yesProbability !== null ? +(p.market.yesProbability - k.market.yesProbability).toFixed(4) : null }];
  } else if (a.query) {
    const r = await both(a.query, "both", 20); sources = r.sources; errors = r.errors;
    pairs = M.matchMarkets(r.poly, r.kal, a.minSimilarity ?? 0.3).slice(0, a.limit ?? 10);
  } else throw new Error("Provide `query`, or both `polymarketSlug` and `kalshiTicker`.");
  let md = `## Polymarket vs Kalshi${a.query ? `: "${a.query}"` : ""}\n\n`;
  if (!pairs.length) md += "No matching market pairs found on both venues. Try a broader query, lower `minSimilarity`, or pass explicit IDs.\n";
  else {
    md += `| Polymarket market | Poly yes | Kalshi market | Kalshi yes | Gap (P − K) | Match |\n|---|---:|---|---:|---:|---:|\n`;
    for (const p of pairs) md += `| [${M.esc(p.polymarket.title)}${p.polymarket.outcome !== "Yes" ? ` – ${M.esc(p.polymarket.outcome)}` : ""}](${p.polymarket.url}) | **${M.pct(p.polymarket.yesProbability)}** | [${M.esc(p.kalshi.title)}${p.kalshi.outcome !== "Yes" ? ` – ${M.esc(p.kalshi.outcome)}` : ""}](${p.kalshi.url}) | **${M.pct(p.kalshi.yesProbability)}** | ${p.gap === null ? "n/a" : (p.gap * 100).toFixed(1) + " pp"} | ${(p.similarity * 100).toFixed(0)}% |\n`;
    md += `\n> Matches are automatic (title similarity). Resolution rules, deadlines and fees differ between venues: check both rules before treating a gap as arbitrage.\n`;
  }
  if (errors.length) md += `\n> Partial results: ${errors.join("; ")}\n`;
  md += "\n" + M.sourcesMd(sources);
  return { pairs, errors, sources, markdown: md };
}

export async function briefing(a: { topic?: string; limit?: number }) {
  const limit = a.limit ?? 8; const now = new Date().toISOString();
  let markets: M.Market[]; let sources: M.Sourced["sources"]; let pairs: M.Pair[] = []; let errors: string[] = [];
  if (a.topic) {
    const r = await both(a.topic, "both", 20); sources = r.sources; errors = r.errors;
    pairs = M.matchMarkets(r.poly, r.kal);
    markets = [...r.poly, ...r.kal].sort(rank(a.topic)).slice(0, limit * 2).sort((x, y) => (y.volume24h ?? 0) - (x.volume24h ?? 0)).slice(0, limit);
  } else { const r = await M.trending("both", limit); markets = r.markets; sources = r.sources; }
  const movers = [...markets].filter(m => m.change24h !== null && m.change24h !== 0).sort((x, y) => Math.abs(y.change24h!) - Math.abs(x.change24h!)).slice(0, 3);
  let md = `# Prediction market briefing${a.topic ? `: ${a.topic}` : " (most active)"}\n_${now.slice(0, 16).replace("T", " ")} UTC_\n\n## Headline odds\n`;
  md += markets.length ? markets.map(m => `- **${M.esc(m.title)}${m.outcome !== "Yes" && !m.title.includes(m.outcome) ? ` (${M.esc(m.outcome)})` : ""}**: ${M.pct(m.yesProbability)} on ${m.venue === "polymarket" ? "Polymarket" : "Kalshi"} ${m.change24h ? `(${M.chg(m.change24h)} 24h)` : ""}`).join("\n") : "- No open markets found.";
  if (movers.length) md += `\n\n## Biggest 24h moves\n` + movers.map(m => `- ${M.esc(m.title)}: ${M.chg(m.change24h)} → ${M.pct(m.yesProbability)} (${m.venue})`).join("\n");
  if (pairs.length) md += `\n\n## Cross-venue check\n` + pairs.slice(0, 3).map(p => `- ${M.esc(p.polymarket.title)}: Polymarket ${M.pct(p.polymarket.yesProbability)} vs Kalshi ${M.pct(p.kalshi.yesProbability)}${p.gap !== null ? ` (gap ${(p.gap * 100).toFixed(1)} pp)` : ""}`).join("\n");
  if (errors.length) md += `\n\n> Partial results: ${errors.join("; ")}`;
  md += "\n\n" + M.sourcesMd(sources, now);
  return { markets, movers, pairs: pairs.slice(0, 3), errors, sources, markdown: md };
}

export async function trendingMarkets(a: { venue?: "both" | M.Venue; limit?: number }) {
  const r = await M.trending(a.venue ?? "both", a.limit ?? 10);
  return { ...r, markdown: `## Most active markets (24h volume)\n\n${M.marketTable(r.markets)}\n${M.sourcesMd(r.sources)}` };
}

export function createServer() {
  const server = new McpServer({ name: "prediction-odds-mcp", version: "1.0.0" });
  const ro = { readOnlyHint: true, openWorldHint: true };
  server.registerTool("search_markets", { title: "Search prediction markets", annotations: ro,
    description: "Search open markets on Polymarket and Kalshi by topic (e.g. 'Fed rate', 'Bitcoin 150k', 'World Cup'). Returns implied YES probability, bid/ask, 24h change, volume, close date, ID and link.",
    inputSchema: { query: z.string().min(2).max(120), venue, limit: z.number().int().min(1).max(25).optional() } }, run(searchMarkets));
  server.registerTool("get_market_odds", { title: "Live odds for one market", annotations: ro,
    description: "Live odds and top-of-book for one market. Polymarket: market slug (uses Gamma + CLOB midpoint/book). Kalshi: market ticker.",
    inputSchema: { venue: z.enum(["polymarket", "kalshi"]), id: z.string().min(1).max(200).describe("Polymarket slug or Kalshi ticker (from search_markets)") } }, run(marketOdds));
  server.registerTool("compare_markets", { title: "Polymarket vs Kalshi side-by-side", annotations: ro,
    description: "Side-by-side odds for the same question on Polymarket and Kalshi, with the probability gap. Auto-matching requires the same strikes/numbers, dates and comparator (above/below/exact/range) plus title similarity; or pass polymarketSlug + kalshiTicker.",
    inputSchema: { query: z.string().min(2).max(120).optional(), polymarketSlug: z.string().optional(), kalshiTicker: z.string().optional(), minSimilarity: z.number().min(0).max(1).optional(), limit: z.number().int().min(1).max(20).optional() } }, run(compare));
  server.registerTool("market_briefing", { title: "Prediction market briefing", annotations: ro,
    description: "A short markdown briefing: headline odds, biggest 24h moves and a cross-venue check, for a topic or for the most active markets overall.",
    inputSchema: { topic: z.string().min(2).max(120).optional(), limit: z.number().int().min(1).max(20).optional() } }, run(briefing));
  server.registerTool("trending_markets", { title: "Most active markets", annotations: ro,
    description: "Top open markets by 24h volume on Polymarket, Kalshi or both.",
    inputSchema: { venue, limit: z.number().int().min(1).max(25).optional() } }, run(trendingMarkets));
  return server;
}
