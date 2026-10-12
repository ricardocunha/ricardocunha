import type { Counters } from "./counters";

declare global {
  namespace Cloudflare {
    interface Env {
      COUNTERS: DurableObjectNamespace<Counters>;
      RATE_LIMITER?: RateLimit;
      ALLOWED_ORIGINS?: string;
      STATS_CACHE_SECONDS?: string;
    }
  }
  type Env = Cloudflare.Env;
}
