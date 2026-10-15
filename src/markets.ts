import { cachedFetch, type Fetched } from "./cache.js";

export const GAMMA = "https://gamma-api.polymarket.com";
export const CLOB = "https://clob.polymarket.com";
export const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";
const LIVE_TTL = 30_000;          // odds: 30 s
const SEARCH_TTL = 2 * 60_000;    // search results: 2 min
const INDEX_TTL = 15 * 60_000;    // Kalshi open-event index: 15 min
const MAX_INDEX_PAGES = Number(process.env.KALSHI_INDEX_PAGES ?? 60);

export type Venue = "polymarket" | "kalshi";
export interface Market {
  venue: Venue; id: string; title: string; outcome: string; event: string;
  yesProbability: number | null; yesBid: number | null; yesAsk: number | null; lastPrice: number | null;
  change24h: number | null; volume: number | null; volume24h: number | null; liquidity: number | null;
  closeTime: string | null; url: string; status: string;
}
export interface Sourced { sources: { name: string; url: string; fetchedAt: string; stale: boolean }[] }

const num = (v: unknown) => { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const jsonArr = (v: unknown): any[] => { if (Array.isArray(v)) return v; try { return JSON.parse(String(v)); } catch { return []; } };

/** Implied YES probability: bid/ask midpoint when the book is two-sided and not absurdly wide; else last trade; else indicative price. */
export function impliedProbability(bid: number | null, ask: number | null, last: number | null, indicative: number | null = null) {
  if (bid !== null && ask !== null && bid > 0 && ask > 0 && ask >= bid && ask - bid <= 0.1) return +((bid + ask) / 2).toFixed(4);
  if (last !== null && last > 0) return last;
  if (indicative !== null) return indicative;
  if (bid !== null && ask !== null && ask >= bid && ask > 0) return +((bid + ask) / 2).toFixed(4);
  return null;
}

export function mapPolymarket(m: any, eventTitle?: string, eventSlug?: string): Market {
  const outcomes = jsonArr(m.outcomes), prices = jsonArr(m.outcomePrices).map(Number);
  const yesIdx = Math.max(0, outcomes.findIndex((o: string) => /^yes$/i.test(o)));
  const bid = num(m.bestBid), ask = num(m.bestAsk), last = num(m.lastTradePrice);
  const binaryYesNo = outcomes.length === 2 && outcomes.some((o: string) => /^yes$/i.test(o));
  return {
    venue: "polymarket", id: m.slug, title: m.question, outcome: m.groupItemTitle || (binaryYesNo ? "Yes" : String(outcomes[yesIdx] ?? "Yes")),
    event: eventTitle ?? m.events?.[0]?.title ?? m.question,
    yesProbability: impliedProbability(bid, ask, last, prices[yesIdx] ?? null), yesBid: bid, yesAsk: ask, lastPrice: last,
    change24h: num(m.oneDayPriceChange), volume: num(m.volumeNum ?? m.volume), volume24h: num(m.volume24hr), liquidity: num(m.liquidityNum ?? m.liquidity),
    closeTime: m.endDate ?? null, url: `https://polymarket.com/event/${eventSlug ?? m.events?.[0]?.slug ?? m.slug}`, status: m.closed ? "closed" : m.active ? "open" : "inactive",
  };
}

export function mapKalshi(m: any, ev?: any): Market {
  const bid = num(m.yes_bid_dollars ?? (m.yes_bid != null ? m.yes_bid / 100 : null));
  const ask = num(m.yes_ask_dollars ?? (m.yes_ask != null ? m.yes_ask / 100 : null));
  const last = num(m.last_price_dollars ?? (m.last_price != null ? m.last_price / 100 : null));
  const prev = num(m.previous_price_dollars ?? (m.previous_price != null ? m.previous_price / 100 : null));
  const p = impliedProbability(bid, ask, last);
  return {
    venue: "kalshi", id: m.ticker, title: m.title, outcome: m.yes_sub_title || "Yes", event: ev?.title ?? m.title,
    yesProbability: p, yesBid: bid, yesAsk: ask, lastPrice: last,
    change24h: p !== null && prev !== null && prev > 0 ? +(p - prev).toFixed(4) : null,
    volume: num(m.volume_fp ?? m.volume), volume24h: num(m.volume_24h_fp ?? m.volume_24h), liquidity: num(m.open_interest_fp ?? m.open_interest),
    closeTime: m.close_time ?? null, url: `https://kalshi.com/markets/${(ev?.series_ticker ?? m.event_ticker ?? "").toLowerCase()}`, status: m.status ?? "unknown",
  };
}

const STOP = new Set("the a an of in on at to for by will be is are what who which with before after than and or yes no market price end".split(" "));
const SYN: Record<string, string> = { january: "jan", february: "feb", march: "mar", april: "apr", june: "jun", july: "jul", august: "aug", september: "sep", sept: "sep", october: "oct", november: "nov", december: "dec",
  decrease: "cut", cuts: "cut", lower: "cut", increase: "hike", raise: "hike", hikes: "hike", maintains: "hold", maintain: "hold", unchanged: "hold", federal: "fed", reserve: "fed", btc: "bitcoin", eth: "ethereum", rates: "rate" };
/** Phrase-level normalisation so venues' wording lines up ("no change" = "hike by 0bps" = hold). */
export function normalise(s: string) {
  return s.toLowerCase().replace(/(hike|raise|cut)s?\s+rates?\s+by\s+0\s*bps/g, "hold").replace(/no change/g, "hold").replace(/(\d)\s*bps/g, "$1 bps");
}
export function tokens(s: string) { return new Set(normalise(s).replace(/[^a-z0-9%$. ]/g, " ").split(/\s+/).map(w => SYN[w] ?? w).filter(w => w.length > 1 && !STOP.has(w))); }
export function similarity(a: string, b: string) {
  const A = tokens(a), B = tokens(b); if (!A.size || !B.size) return 0;
  let i = 0; for (const w of A) if (B.has(w)) i++;
  return i / (A.size + B.size - i);
}
function src(f: Fetched<unknown>, name: string) { return { name, url: f.source.split("?")[0], fetchedAt: f.fetchedAt, stale: f.stale }; }

export async function searchPolymarket(query: string, limit = 10) {
  const f = await cachedFetch<any>(`${GAMMA}/public-search?${new URLSearchParams({ q: query, limit_per_type: String(Math.min(limit, 20)), events_status: "active" })}`, SEARCH_TTL);
  const markets: Market[] = [];
  for (const e of f.data.events ?? []) for (const m of e.markets ?? []) if (!m.closed && m.active !== false) markets.push(mapPolymarket(m, e.title, e.slug));
  return { markets, source: src(f, "Polymarket Gamma API") };
}

type KIndex = { at: number; events: any[]; fetchedAt: string; stale: boolean; cursor: string; complete: boolean };
let kalshiIndex: KIndex | null = null;
let indexing: Promise<KIndex> | null = null;
const INDEX_BUDGET_MS = Number(process.env.KALSHI_INDEX_BUDGET_MS ?? 8000);
/**
 * Index of open Kalshi events (titles only), paged politely (~5 req/s) and cached 15 min.
 * Each call spends at most INDEX_BUDGET_MS extending the index, so serverless requests stay fast;
 * a partial index is used (and flagged) until later calls complete it. Multivariate parlay events are skipped.
 */
export async function kalshiEventIndex(): Promise<KIndex> {
  if (kalshiIndex && Date.now() - kalshiIndex.at > INDEX_TTL) kalshiIndex = null;
  if (kalshiIndex?.complete) return kalshiIndex;
  if (!indexing) indexing = (async () => {
    const idx: KIndex = kalshiIndex ?? { at: Date.now(), events: [], fetchedAt: new Date().toISOString(), stale: false, cursor: "", complete: false };
    const deadline = Date.now() + INDEX_BUDGET_MS; let pages = Math.floor(idx.events.length / 150);
    while (Date.now() < deadline && pages < MAX_INDEX_PAGES) {
      let f: Fetched<any>;
      try { f = await cachedFetch<any>(`${KALSHI}/events?${new URLSearchParams({ limit: "200", status: "open", ...(idx.cursor ? { cursor: idx.cursor } : {}) })}`, INDEX_TTL, { noRetry: idx.events.length > 0 }); }
      catch (e) { if (idx.events.length) { idx.stale = true; break; } throw e; }
      if (!idx.events.length) idx.fetchedAt = f.fetchedAt;
      for (const e of f.data.events ?? []) if (!/^KXMVE/i.test(e.event_ticker)) idx.events.push(e);
      pages++; idx.cursor = f.data.cursor ?? "";
      if (!idx.cursor) { idx.complete = true; break; }
      await new Promise(r => setTimeout(r, 200));
    }
    if (pages >= MAX_INDEX_PAGES) idx.complete = true;
    kalshiIndex = idx; return idx;
  })().finally(() => { indexing = null; });
  return indexing;
}
export function _resetKalshiIndex() { kalshiIndex = null; }

export async function searchKalshi(query: string, limit = 10) {
  const idx = await kalshiEventIndex();
  // Rank by similarity; ties go to the nearest-dated event (smallest year in the title); max 3 events per series for variety.
  const yr = (t: string) => Math.min(...(t.match(/20\d\d/g) ?? ["9999"]).map(Number));
  const ranked = idx.events.map(e => ({ e, s: similarity(query, `${e.title} ${e.sub_title ?? ""} ${e.category ?? ""}`) })).filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || yr(`${a.e.title} ${a.e.sub_title ?? ""}`) - yr(`${b.e.title} ${b.e.sub_title ?? ""}`));
  const perSeries = new Map<string, number>(); const scored: typeof ranked = [];
  for (const x of ranked) { const k = x.e.series_ticker ?? x.e.event_ticker; const n = perSeries.get(k) ?? 0; if (n >= 3) continue; perSeries.set(k, n + 1); scored.push(x); if (scored.length >= Math.min(limit, 12)) break; }
  const markets: Market[] = []; let fetchedAt = idx.fetchedAt;
  for (const { e } of scored) {
    let f: Fetched<any>;
    try { f = await cachedFetch<any>(`${KALSHI}/markets?${new URLSearchParams({ event_ticker: e.event_ticker, status: "open", limit: "50" })}`, LIVE_TTL); }
    catch (err) { if (markets.length) break; throw err; } // return what we have rather than fail
    if (!f.cached) await new Promise(r => setTimeout(r, 150));
    fetchedAt = f.fetchedAt;
    for (const m of f.data.markets ?? []) markets.push(mapKalshi(m, e));
  }
  return { markets, source: { name: "Kalshi Trade API v2", url: `${KALSHI}/events`, fetchedAt, stale: idx.stale }, eventsIndexed: idx.events.length, indexComplete: idx.complete };
}

export async function getMarket(venue: Venue, id: string) {
  if (venue === "polymarket") {
    const f = await cachedFetch<any[]>(`${GAMMA}/markets?slug=${encodeURIComponent(id)}`, LIVE_TTL);
    const m = f.data?.[0]; if (!m) throw new Error(`Polymarket market "${id}" not found. Use the market slug from search_markets.`);
    const market = mapPolymarket(m);
    const sources = [src(f, "Polymarket Gamma API")];
    const token = jsonArr(m.clobTokenIds)[0];
    let book: { bids: [number, number][]; asks: [number, number][] } | null = null;
    if (token && m.enableOrderBook !== false) {
      try {
        const mid = await cachedFetch<any>(`${CLOB}/midpoint?token_id=${token}`, LIVE_TTL);
        const b = await cachedFetch<any>(`${CLOB}/book?token_id=${token}`, LIVE_TTL);
        sources.push(src(mid, "Polymarket CLOB API"));
        const bids = (b.data.bids ?? []).map((x: any) => [Number(x.price), Number(x.size)] as [number, number]).sort((a: any, c: any) => c[0] - a[0]).slice(0, 5);
        const asks = (b.data.asks ?? []).map((x: any) => [Number(x.price), Number(x.size)] as [number, number]).sort((a: any, c: any) => a[0] - c[0]).slice(0, 5);
        book = { bids, asks };
        const midN = num(mid.data.mid);
        if (bids.length && asks.length) { market.yesBid = bids[0][0]; market.yesAsk = asks[0][0]; }
        if (midN !== null && market.yesBid !== null && market.yesAsk !== null && market.yesAsk - market.yesBid <= 0.1) market.yesProbability = midN;
      } catch { /* Gamma prices still valid */ }
    }
    return { market, book, sources };
  }
  const f = await cachedFetch<any>(`${KALSHI}/markets/${encodeURIComponent(id)}`, LIVE_TTL).catch(e => { throw new Error(/404/.test(e.message) ? `Kalshi market "${id}" not found. Use the market ticker from search_markets.` : e.message); });
  const m = f.data.market; let ev: any;
  try { ev = (await cachedFetch<any>(`${KALSHI}/events/${m.event_ticker}`, SEARCH_TTL)).data.event; } catch { /* optional */ }
  const market = mapKalshi(m, ev);
  let book = null; const sources = [src(f, "Kalshi Trade API v2")];
  try {
    const b = await cachedFetch<any>(`${KALSHI}/markets/${encodeURIComponent(id)}/orderbook?depth=5`, LIVE_TTL);
    const ob = b.data.orderbook_fp ?? b.data.orderbook ?? {};
    const conv = (arr: any[] | null | undefined, dollars: boolean) => (arr ?? []).map((x: any) => [dollars ? Number(x[0]) : Number(x[0]) / 100, Number(x[1])] as [number, number]);
    const yes = conv(ob.yes_dollars ?? ob.yes, !!ob.yes_dollars), no = conv(ob.no_dollars ?? ob.no, !!ob.no_dollars);
    // Kalshi books list YES bids and NO bids; a NO bid at p is a YES ask at 1-p.
    book = { bids: yes.sort((a, c) => c[0] - a[0]).slice(0, 5), asks: no.map(([p, s]) => [+(1 - p).toFixed(4), s] as [number, number]).sort((a, c) => a[0] - c[0]).slice(0, 5) };
  } catch { /* optional */ }
  return { market, book, sources };
}

export async function trending(venue: Venue | "both", limit = 10) {
  const out: Market[] = []; const sources: Sourced["sources"] = [];
  if (venue !== "kalshi") {
    const f = await cachedFetch<any[]>(`${GAMMA}/markets?${new URLSearchParams({ active: "true", closed: "false", order: "volume24hr", ascending: "false", limit: String(limit) })}`, SEARCH_TTL);
    out.push(...f.data.map(m => mapPolymarket(m))); sources.push(src(f, "Polymarket Gamma API"));
  }
  if (venue !== "polymarket") {
    const f = await cachedFetch<any>(`${KALSHI}/markets?${new URLSearchParams({ status: "open", limit: "1000", mve_filter: "exclude" })}`, SEARCH_TTL);
    const ms = (f.data.markets ?? []).filter((m: any) => !/^KXMVE/i.test(m.ticker)).map((m: any) => mapKalshi(m)).sort((a: Market, b: Market) => (b.volume24h ?? 0) - (a.volume24h ?? 0)).slice(0, limit);
    out.push(...ms); sources.push(src(f, "Kalshi Trade API v2"));
  }
  return { markets: out, sources };
}

const MONTHS: Record<string, string> = { january: "jan", february: "feb", march: "mar", april: "apr", june: "jun", july: "jul", august: "aug", september: "sep", sept: "sep", october: "oct", november: "nov", december: "dec" };
/** Key facts that must agree for two markets to be "the same question": numbers (strikes, dates, years), months, comparator. */
export function keyFacts(text: string) {
  const t = normalise(text).replace(/(\d),(?=\d{3})/g, "$1");
  const nums = new Set<string>();
  const t2 = t.replace(/>\s*=?\s*\$?(\d+(?:\.\d+)?)/g, "$1+");
  for (const m of t2.matchAll(/(\d+(?:\.\d+)?)(\+)?\s*(k|m|bn|b)?\b/g)) {
    let n = Number(m[1]); const suf = m[3];
    if (suf === "k") n *= 1e3; else if (suf === "m") n *= 1e6; else if (suf === "b" || suf === "bn") n *= 1e9;
    nums.add(String(+n.toFixed(4)) + (m[2] ?? ""));
  }
  const months = new Set<string>();
  for (const w of t.split(/[^a-z]+/)) { const k = MONTHS[w] ?? (["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].includes(w) ? w : null); if (k) months.add(k); }
  const comparator = /\b(between|range|to \$?\d)/.test(t) ? "range" : /\b(above|over|greater|more than|at least|or more|higher|exceed)/.test(t) ? "above" : /\b(below|under|less than|or less|lower)/.test(t) ? "below" : /\b(exactly|be \$?\d)/.test(t) ? "exact" : "none";
  const toks = tokens(text);
  const action = toks.has("hold") ? "hold" : toks.has("cut") && !toks.has("hike") ? "cut" : toks.has("hike") && !toks.has("cut") ? "hike" : "none";
  return { nums, months, comparator, action };
}
const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every(x => b.has(x));
export function compatible(a: string, b: string) {
  const A = keyFacts(a), B = keyFacts(b);
  if (!sameSet(A.nums, B.nums)) return false;
  if (A.months.size && B.months.size && !sameSet(A.months, B.months)) return false;
  if (A.comparator !== "none" && B.comparator !== "none" && A.comparator !== B.comparator) return false;
  if (A.action !== "none" && B.action !== "none" && A.action !== B.action) return false;
  return true;
}

export interface Pair { polymarket: Market; kalshi: Market; similarity: number; gap: number | null; }
/** Greedy one-to-one matching on title + outcome similarity. */
export function matchMarkets(poly: Market[], kal: Market[], minSim = 0.3): Pair[] {
  const cands: Pair[] = [];
  for (const p of poly) for (const k of kal) {
    const pa = `${p.title} ${p.outcome === "Yes" ? "" : p.outcome}`, ka = `${k.title} ${k.outcome === "Yes" ? "" : k.outcome}`;
    if (!compatible(pa, ka)) continue;
    const s = similarity(`${p.event} ${pa}`, `${k.event} ${ka}`);
    if (s >= minSim) cands.push({ polymarket: p, kalshi: k, similarity: +s.toFixed(3), gap: p.yesProbability !== null && k.yesProbability !== null ? +(p.yesProbability - k.yesProbability).toFixed(4) : null });
  }
  cands.sort((a, b) => b.similarity - a.similarity);
  const usedP = new Set<string>(), usedK = new Set<string>(); const out: Pair[] = [];
  for (const c of cands) if (!usedP.has(c.polymarket.id) && !usedK.has(c.kalshi.id)) { usedP.add(c.polymarket.id); usedK.add(c.kalshi.id); out.push(c); }
  return out;
}

export const pct = (p: number | null) => p === null ? "n/a" : (p * 100).toFixed(1) + "%";
export const chg = (p: number | null) => p === null ? "" : `${p >= 0 ? "+" : ""}${(p * 100).toFixed(1)} pp`;
export const usd = (n: number | null) => n === null ? "-" : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${n.toFixed(0)}`;
export const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
export function sourcesMd(s: Sourced["sources"], computedAt = new Date().toISOString()) {
  return "_Sources: " + s.map(x => `${x.name} (${x.url}) fetched ${x.fetchedAt}${x.stale ? " STALE" : ""}`).join("; ") + `. Generated ${computedAt}. Prices are implied probabilities, not advice._`;
}
export function marketTable(ms: Market[]) {
  let md = `| Venue | Market | Outcome | Yes prob. | Bid / Ask | 24h | Volume | Closes | ID |\n|---|---|---|---:|---|---:|---:|---|---|\n`;
  for (const m of ms) md += `| ${m.venue === "polymarket" ? "Polymarket" : "Kalshi"} | [${esc(m.title)}](${m.url}) | ${esc(m.outcome)} | **${pct(m.yesProbability)}** | ${m.yesBid !== null ? m.yesBid.toFixed(3) : "-"} / ${m.yesAsk !== null ? m.yesAsk.toFixed(3) : "-"} | ${chg(m.change24h)} | ${m.venue === "kalshi" ? (m.volume === null ? "-" : Math.round(m.volume).toLocaleString("en-US") + " contracts") : usd(m.volume)} | ${m.closeTime?.slice(0, 10) ?? "-"} | \`${m.id}\` |\n`;
  return md;
}
