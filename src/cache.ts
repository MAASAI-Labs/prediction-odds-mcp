/** Polite fetch: in-memory TTL cache, in-flight de-duplication, stale-on-error fallback. */
const UA = "prediction-odds-mcp/1.0 (+https://github.com/colepresley000-hub)";
type Entry = { at: number; data: unknown };
const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<Entry>>();

export interface Fetched<T> { data: T; fetchedAt: string; cached: boolean; stale: boolean; source: string; }

export async function cachedFetch<T>(url: string, ttlMs: number, opts: { text?: boolean; fetchImpl?: typeof fetch; noRetry?: boolean } = {}): Promise<Fetched<T>> {
  const hit = store.get(url);
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) return { data: hit.data as T, fetchedAt: new Date(hit.at).toISOString(), cached: true, stale: false, source: url };
  let p = inflight.get(url);
  if (!p) {
    p = (async () => {
      const doFetch = () => (opts.fetchImpl ?? fetch)(url, { headers: { "User-Agent": UA, Accept: opts.text ? "text/plain" : "application/json" }, signal: AbortSignal.timeout(15000) });
      let res = await doFetch();
      if (res.status === 429 && !opts.noRetry) { // one polite retry, honouring Retry-After (capped at 3 s)
        const wait = Math.min(3000, (Number(res.headers.get("retry-after")) || 1) * 1000);
        await new Promise(r => setTimeout(r, wait)); res = await doFetch();
      }
      if (res.status === 404 && opts.text) { const t = await res.text(); if (/No GP data/i.test(t)) { const e = { at: Date.now(), data: t }; store.set(url, e); return e; } }
      if (!res.ok) throw new Error(res.status === 429 ? `Rate limited by ${new URL(url).host} (HTTP 429). Try again later.` : `HTTP ${res.status} from ${new URL(url).host}`);
      const data = opts.text ? await res.text() : await res.json();
      const e = { at: Date.now(), data }; store.set(url, e); return e;
    })().finally(() => inflight.delete(url));
    inflight.set(url, p);
  }
  try {
    const e = await p;
    return { data: e.data as T, fetchedAt: new Date(e.at).toISOString(), cached: false, stale: false, source: url };
  } catch (err) {
    if (hit) return { data: hit.data as T, fetchedAt: new Date(hit.at).toISOString(), cached: true, stale: true, source: url };
    throw err;
  }
}
export function clearCache() { store.clear(); }
export function sourceLine(f: { source: string; fetchedAt: string; cached: boolean; stale: boolean }, label: string) {
  return `_Source: ${label} (${f.source.split("?")[0]}), data fetched ${f.fetchedAt}${f.stale ? " (STALE: upstream unavailable, showing cached copy)" : f.cached ? " (cached)" : ""}._`;
}
