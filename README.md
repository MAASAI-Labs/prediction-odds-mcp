# Prediction Market Odds (MCP server)

**Live MCP URL (Streamable HTTP, no auth):** `https://prediction-odds-mcp.vercel.app/mcp`  
Health check: `https://prediction-odds-mcp.vercel.app/health`

An MCP server that gives Grok Bot (or any MCP client) live, read-only odds from **Polymarket** and **Kalshi**:

- Search markets
- Live implied probabilities with order books
- **Side-by-side comparison** of the same question on both venues
- Short markdown **briefings**

It uses only public read endpoints, needs no API keys and has no trading functions. Every output cites its sources and fetch timestamps.

## Tools

| Tool | Purpose | Key inputs |
|---|---|---|
| `search_markets` | Open markets on either or both venues: implied YES %, bid/ask, 24h change, volume, close date, ID, link | `query`, `venue` (`both`/`polymarket`/`kalshi`), `limit` |
| `get_market_odds` | Live odds and top-5 YES order book for one market | `venue`, `id` (Polymarket slug or Kalshi ticker) |
| `compare_markets` | Polymarket vs Kalshi for matching questions, with the probability gap | `query`, or `polymarketSlug` + `kalshiTicker` |
| `market_briefing` | Headline odds, biggest 24h moves, cross-venue check | `topic` (optional; default is most active) |
| `trending_markets` | Top open markets by 24h volume | `venue`, `limit` |

## Example prompts

- "What are the odds the Fed holds in October? Compare Polymarket and Kalshi."
- "Give me a prediction-market briefing on Bitcoin."
- "What's trending on Polymarket and Kalshi today?"
- "Show the live order book for the Kalshi market on an October Fed hold."
- "Search both venues for World Cup winner odds."

## How odds are calculated

- **Implied probability** = the midpoint of the best YES bid and ask when both exist and the spread is 10¢ or less. Otherwise it's the last trade, then Polymarket's indicative outcome price.
- **Polymarket**: Gamma API for search and metadata. CLOB `/midpoint` and `/book` for live prices on single-market lookups.
- **Kalshi**: Trade API v2. Prices are in dollars (legacy cent fields are also supported). Volume is in contracts. In the order book, a NO bid at p is shown as a YES ask at 1 − p.
- **24h change**: Polymarket `oneDayPriceChange`. For Kalshi, the current implied probability minus `previous_price`.
- **Matching** (`compare_markets`): two markets pair only if all of these agree:
  - the same numbers (strikes, thresholds and years; `25` ≠ `>25` ≠ `50+`)
  - the same months
  - the same comparator (above, below, exact or range)
  - the same action (cut, hike or hold; "no change" and "hike by 0bps" both count as hold)
  - title similarity of at least 0.3

  Pairs are one-to-one. The output always warns that resolution rules can differ between venues.

## Polite use of public APIs

- **Caching**: odds 30 s, searches 2 min, Kalshi event index 15 min.
- **Kalshi search**: Kalshi has no text-search endpoint, so the server pages through open events (titles only, ~5 requests/s, parlay events skipped). Each call spends at most 8 s (`KALSHI_INDEX_BUDGET_MS`) extending the index, so the first one or two calls after a cold start may say "still indexing". It completes in about 3 calls (~9k events).
- **Rate limits**: on HTTP 429, the server retries once (honouring `Retry-After`, capped at 3 s), then falls back to the cached copy, marked STALE, or a partial result with a clear note.
- **Identification**: requests send a descriptive User-Agent.

## Run locally

```bash
npm install
npm test             # unit tests (vitest; network mocked)
npm run build
npm start            # Streamable HTTP at http://localhost:3000/mcp
npm run start:stdio  # stdio
npm run smoke        # live: calls every tool against the local server
```

## Deploy to Vercel

1. Push to GitHub and import it at vercel.com/new (Framework preset: Other). No environment variables are required.
2. The MCP URL is `https://<project>.vercel.app/mcp` (served by `api/mcp.ts`, via the rewrite in `vercel.json`).
3. Check it with `node scripts/smoke.mjs https://<project>.vercel.app/mcp`.

Serverless instances each keep their own cache and Kalshi index. The 8 s indexing budget keeps every request well inside the 30 s function limit.

## Testing instructions for marketplace reviewers

No credentials needed.

1. List tools. You should see 5.
2. `trending_markets` with `{"limit": 3}`: a table from both venues, ending with a "Sources: … fetched <timestamp>" line.
3. `search_markets` with `{"query": "Fed rate"}`: markets from both venues. If it says Kalshi is "still indexing", repeat after a few seconds.
4. `compare_markets` with `{"query": "Fed decision October 2026"}` (or any current headline event): paired rows with Poly %, Kalshi % and the gap.
5. `get_market_odds` with a slug or ticker from step 3: odds and a top-5 order book.
6. `market_briefing` with `{"topic": "Bitcoin"}`: a short briefing.
7. Invalid input, such as a `query` of 1 character, returns a validation error.

## Disclaimer

Information only. This is not financial advice. Prediction markets may be restricted where you live. This server is not affiliated with Polymarket or Kalshi.

## License

MIT
