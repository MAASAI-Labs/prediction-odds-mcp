import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as M from "../src/markets";
import { clearCache } from "../src/cache";
import { compare, searchMarkets, marketOdds } from "../src/server";

const polyMarket = { slug: "fed-hike-2026", question: "Another Fed rate hike in 2026?", outcomes: '["Yes","No"]', outcomePrices: '["0.815","0.185"]', bestBid: 0.81, bestAsk: 0.82, lastTradePrice: 0.82, oneDayPriceChange: 0.02, volumeNum: 780537, volume24hr: 123000, endDate: "2026-12-10T04:59:00Z", active: true, closed: false, clobTokenIds: '["111","222"]' };
const kalshiEvent = { event_ticker: "KXFEDHIKE-26", series_ticker: "KXFEDHIKE", title: "Another Fed rate hike in 2026?", sub_title: "", category: "Economics" };
const kalshiMarket = { ticker: "KXFEDHIKE-26-Y", event_ticker: "KXFEDHIKE-26", title: "Another Fed rate hike in 2026?", yes_sub_title: "", yes_bid_dollars: "0.7600", yes_ask_dollars: "0.7800", last_price_dollars: "0.7700", previous_price_dollars: "0.7500", volume_fp: "50000", volume_24h_fp: "1200", close_time: "2026-12-31T00:00:00Z", status: "active" };

function router(url: string) {
  const u = new URL(url);
  if (u.host === "gamma-api.polymarket.com" && u.pathname === "/public-search") return { events: [{ title: "Another Fed rate hike in 2026?", slug: "fed-hike-2026", markets: [polyMarket] }] };
  if (u.host === "gamma-api.polymarket.com" && u.pathname === "/markets") return u.searchParams.get("slug") === "nope" ? [] : [polyMarket];
  if (u.pathname === "/midpoint") return { mid: "0.815" };
  if (u.pathname === "/book") return { bids: [{ price: "0.80", size: "10" }, { price: "0.81", size: "5" }], asks: [{ price: "0.83", size: "7" }, { price: "0.82", size: "3" }] };
  if (u.pathname.endsWith("/events") && u.host.includes("kalshi")) return { events: [kalshiEvent, { event_ticker: "KXMVECROSS-1", title: "Fed parlay" }], cursor: "" };
  if (u.pathname.endsWith("/markets") && u.host.includes("kalshi")) return { markets: [kalshiMarket] };
  if (u.pathname.endsWith("/orderbook")) return { orderbook_fp: { yes_dollars: [["0.7600", "100"]], no_dollars: [["0.2200", "50"]] } };
  if (/\/markets\/KXFEDHIKE-26-Y$/.test(u.pathname)) return { market: kalshiMarket };
  if (/\/events\/KXFEDHIKE-26$/.test(u.pathname)) return { event: kalshiEvent };
  return null;
}
let spy: any;
beforeEach(() => { clearCache(); M._resetKalshiIndex(); spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => { const b = router(String(input)); return b === null ? new Response("not found", { status: 404 }) : new Response(JSON.stringify(b), { status: 200 }); }); });
afterEach(() => spy.mockRestore());

describe("pricing", () => {
  it("implied probability = midpoint for tight books, last trade for wide ones", () => {
    expect(M.impliedProbability(0.81, 0.82, 0.82)).toBe(0.815);
    expect(M.impliedProbability(0.3, 0.59, 0.6)).toBe(0.6);
    expect(M.impliedProbability(null, null, null, 0.4)).toBe(0.4);
    expect(M.impliedProbability(null, null, null)).toBeNull();
  });
  it("maps Polymarket and Kalshi records", () => {
    const p = M.mapPolymarket(polyMarket);
    expect(p).toMatchObject({ venue: "polymarket", yesProbability: 0.815, change24h: 0.02, volume: 780537 });
    const k = M.mapKalshi(kalshiMarket, kalshiEvent);
    expect(k).toMatchObject({ venue: "kalshi", yesProbability: 0.77, yesBid: 0.76, yesAsk: 0.78, change24h: 0.02, url: "https://kalshi.com/markets/kxfedhike" });
  });
  it("supports legacy Kalshi cent fields", () => {
    expect(M.mapKalshi({ ticker: "X", title: "t", yes_bid: 40, yes_ask: 44, last_price: 42 }).yesProbability).toBe(0.42);
  });
});

describe("matching", () => {
  it("rejects different strikes, dates, comparators and ranges", () => {
    expect(M.compatible("Fed funds rate be 2.25% at end of 2026", "Fed funds rate above 2.25% after Dec 2027 meeting")).toBe(false);
    expect(M.compatible("Bitcoin above $72,000 on October 15", "Bitcoin price Oct 15 $72,000 to 72,249.99")).toBe(false);
    expect(M.compatible("Bitcoin above $72,000 on October 15", "Bitcoin above $74,000 on October 15")).toBe(false);
    expect(M.compatible("Bitcoin above $72,000 on October 15", "Will Bitcoin be above 72k on Oct 15?")).toBe(true);
  });
  it("pairs the same question one-to-one and computes the gap", () => {
    const pairs = M.matchMarkets([M.mapPolymarket(polyMarket)], [M.mapKalshi(kalshiMarket, kalshiEvent)]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].gap).toBeCloseTo(0.045, 6);
  });
});

describe("tools (mocked network)", () => {
  it("search merges both venues, skips parlay events, cites sources", async () => {
    const r = await searchMarkets({ query: "Fed rate hike" });
    expect(r.markets.map(m => m.venue).sort()).toEqual(["kalshi", "polymarket"]);
    expect(r.markdown).toMatch(/Sources: Polymarket Gamma API .* fetched .*Kalshi Trade API v2/);
    expect(spy.mock.calls.some((c: any) => String(c[0]).includes("KXMVE"))).toBe(false);
  });
  it("Polymarket odds use CLOB midpoint and sorted book", async () => {
    const r = await marketOdds({ venue: "polymarket", id: "fed-hike-2026" });
    expect(r.market.yesProbability).toBe(0.815);
    expect(r.book!.bids[0][0]).toBe(0.81); expect(r.book!.asks[0][0]).toBe(0.82);
  });
  it("Kalshi book converts NO bids into YES asks", async () => {
    const r = await marketOdds({ venue: "kalshi", id: "KXFEDHIKE-26-Y" });
    expect(r.book!.asks[0][0]).toBe(0.78);
    expect(r.markdown).toContain("Kalshi");
  });
  it("compare by query produces a side-by-side table with a caveat", async () => {
    const r = await compare({ query: "Fed rate hike 2026" });
    expect(r.pairs).toHaveLength(1);
    expect(r.markdown).toContain("4.5 pp");
    expect(r.markdown).toMatch(/Resolution rules/);
  });
  it("unknown market gives a helpful error", async () => {
    await expect(M.getMarket("polymarket", "nope")).rejects.toThrow(/not found/);
  });
  it("caches: repeated search hits upstream once", async () => {
    await searchMarkets({ query: "Fed rate hike", venue: "polymarket" });
    await searchMarkets({ query: "Fed rate hike", venue: "polymarket" });
    expect(spy.mock.calls.filter((c: any) => String(c[0]).includes("public-search")).length).toBe(1);
  });
});

describe("matching: rate decisions", () => {
  it("treats 'no change' and 'hike by 0bps' as the same hold, and rejects cut vs hold", () => {
    const polyHold = "Will there be no change in Fed interest rates after the October 2026 meeting? No change";
    const kalHold = "Will the Federal Reserve Hike rates by 0bps at their October 2026 meeting? Fed maintains rate";
    expect(M.compatible(polyHold, kalHold)).toBe(true);
    expect(M.compatible("Fed rate cut by June 2027 meeting? June 2027 Meeting", "Will the Federal Reserve Hike rates by 0bps at their June 2027 meeting? Fed maintains rate")).toBe(false);
    expect(M.compatible("Fed decrease rates by 25 bps after the October 2026 meeting", "Federal Reserve Cut rates by 25bps at their October 2027 meeting")).toBe(false);
  });
});

describe("matching: open-ended buckets", () => {
  it("'25 bps' is not '>25bps' or '50+ bps'", () => {
    expect(M.compatible("Fed decrease rates by 25 bps after the October 2026 meeting", "Federal Reserve Cut rates by >25bps at their October 2026 meeting")).toBe(false);
    expect(M.compatible("Fed decrease rates by 25 bps after the October 2026 meeting", "Federal Reserve Cut rates by 25bps at their October 2026 meeting")).toBe(true);
    expect(M.keyFacts("50+ bps").nums.has("50+")).toBe(true);
  });
});

describe("matching: resolution qualifiers must agree", () => {
  it("never pairs an emergency/inter-meeting cut with any cut", () => {
    expect(M.compatible("Fed emergency rate cut before 2027?", "Will the Federal Reserve cut rates before 2027? Cuts")).toBe(false);
    expect(M.compatible("Inter-meeting Fed cut in 2026?", "Fed cut in 2026?")).toBe(false);
    expect(M.compatible("Fed emergency rate cut before 2027?", "Emergency Fed rate cut before 2027")).toBe(true);
  });
  it("deadline (before/by) vs period (in/during) vs single meeting differ", () => {
    expect(M.compatible("Fed rate cut before 2027?", "Fed rate cut in 2027?")).toBe(false);
    expect(M.compatible("Fed rate hike by December 2026?", "Fed rate hike at the December 2026 meeting?")).toBe(false);
    expect(M.compatible("Fed rate cut in 2026?", "Fed rate cut during 2026?")).toBe(true);
    expect(M.compatible("Fed rate cut by December 2026?", "Fed cut rates before December 2026?")).toBe(true);
  });
  it("a month-specific deadline is not a year boundary", () => {
    expect(M.compatible("Fed rate cut by January 2027 meeting? January 2027 Meeting", "Will the Federal Reserve cut rates before 2027? Cuts")).toBe(false);
  });
  it("negated questions never pair with positive ones", () => {
    expect(M.compatible("Will no Fed rate cuts happen in 2026?", "Fed rate cut in 2026?")).toBe(false);
    expect(M.compatible("Will no Fed rate cuts happen in 2026?", "Zero Fed rate cuts in 2026?")).toBe(true);
  });
  it("'by 25 bps' magnitude is not a deadline", () => {
    expect(M.keyFacts("Fed decrease rates by 25 bps after the October 2026 meeting").timeframe).toBe("point");
  });
});
