import { DurableObject } from "cloudflare:workers";

/** One usage event. Names only: no IP address, no request body. */
export interface UsageEvent {
  method: string;
  tool?: string;
  client: string;
}

export interface UsageSnapshot {
  total: number;
  last7d: number;
  tools: Record<string, number>;
  clients: Record<string, number>;
  methods: Record<string, number>;
}

/** Distinct client names kept before everything new is folded into "other". */
export const MAX_CLIENT_KEYS = 50;
const KEEP_DAYS = 35;

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Single-instance counter store. A Durable Object runs one event at a time and
 * its SQLite writes are synchronous, so increments are atomic (no lost updates).
 */
export class Counters extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS totals (kind TEXT NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (kind, key)) WITHOUT ROWID;
       CREATE TABLE IF NOT EXISTS daily (day TEXT PRIMARY KEY, n INTEGER NOT NULL) WITHOUT ROWID;`,
    );
  }

  private bump(kind: string, key: string): void {
    this.sql.exec(
      "INSERT INTO totals (kind, key, n) VALUES (?, ?, 1) ON CONFLICT (kind, key) DO UPDATE SET n = n + 1",
      kind,
      key,
    );
  }

  record(ev: UsageEvent): void {
    const now = Date.now();
    const day = dayOf(now);
    const newDay = this.sql.exec("SELECT 1 FROM daily WHERE day = ?", day).toArray().length === 0;
    this.sql.exec("INSERT INTO daily (day, n) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET n = n + 1", day);
    if (newDay) this.sql.exec("DELETE FROM daily WHERE day < ?", dayOf(now - KEEP_DAYS * 86_400_000));

    this.bump("event", "all");
    this.bump("method", ev.method);
    if (ev.tool) this.bump("tool", ev.tool);

    let client = ev.client;
    const known = this.sql.exec("SELECT 1 FROM totals WHERE kind = 'client' AND key = ?", client).toArray().length > 0;
    if (!known) {
      const distinct = this.sql.exec("SELECT COUNT(*) AS c FROM totals WHERE kind = 'client'").one().c as number;
      if (distinct >= MAX_CLIENT_KEYS) client = "other";
    }
    this.bump("client", client);
  }

  snapshot(): UsageSnapshot {
    const out: UsageSnapshot = { total: 0, last7d: 0, tools: {}, clients: {}, methods: {} };
    for (const row of this.sql.exec("SELECT kind, key, n FROM totals ORDER BY kind, n DESC, key")) {
      const key = row.key as string;
      const n = row.n as number;
      if (row.kind === "event") out.total = n;
      else if (row.kind === "tool") out.tools[key] = n;
      else if (row.kind === "client") out.clients[key] = n;
      else if (row.kind === "method") out.methods[key] = n;
    }
    // Today plus the six previous UTC days.
    const since = dayOf(Date.now() - 6 * 86_400_000);
    out.last7d = (this.sql.exec("SELECT COALESCE(SUM(n), 0) AS s FROM daily WHERE day >= ?", since).one().s as number) ?? 0;
    return out;
  }
}
