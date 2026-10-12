import type { UsageSnapshot } from "./counters";

/** Public contract of GET /stats. The profile README's scheduled job reads this. */
export interface StatsDoc {
  generatedAt: string;
  mcp_events_total: number;
  mcp_events_7d: number;
  tool_calls: Record<string, number>;
  clients: Record<string, number>;
}

let cached: { doc: StatsDoc; at: number } | undefined;

export function resetStatsCache(): void {
  cached = undefined;
}

export function counters(env: Env) {
  return env.COUNTERS.get(env.COUNTERS.idFromName("global"));
}

/** Usage figures, cached per isolate. Serves the last good copy if the store is unreachable. */
export async function getStats(env: Env): Promise<StatsDoc> {
  const ttl = Number(env.STATS_CACHE_SECONDS ?? 60);
  const ttlMs = (Number.isFinite(ttl) && ttl >= 0 ? ttl : 60) * 1000;
  if (cached && Date.now() - cached.at < ttlMs) return cached.doc;
  try {
    const snap: UsageSnapshot = await counters(env).snapshot();
    const doc: StatsDoc = {
      generatedAt: new Date().toISOString(),
      mcp_events_total: snap.total,
      mcp_events_7d: snap.last7d,
      tool_calls: snap.tools,
      clients: snap.clients,
    };
    cached = { doc, at: Date.now() };
    return doc;
  } catch (err) {
    if (cached) return cached.doc;
    throw err;
  }
}
