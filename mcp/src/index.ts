import { counters, getStats } from "./stats";
import { loadProfile, isObject } from "./profile";
import { SERVER_VERSION, SUPPORTED_VERSIONS, handleMcpPost, serverInfo } from "./mcp";
import { TOOLS } from "./tools";

export { Counters } from "./counters";

const FALLBACK_ALLOW_HEADERS =
  "Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

function allowedOrigins(env: Env): string[] | null {
  const raw = (env.ALLOWED_ORIGINS ?? "*").trim();
  if (raw === "" || raw === "*") return null; // any origin
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function withCors(response: Response, request: Request, env: Env): Response {
  const out = new Response(response.body, response);
  const allow = allowedOrigins(env);
  const origin = request.headers.get("origin");
  if (allow === null) out.headers.set("access-control-allow-origin", "*");
  else if (origin && allow.includes(origin)) out.headers.set("access-control-allow-origin", origin);
  if (allow !== null) out.headers.append("vary", "Origin");
  out.headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  out.headers.set("access-control-allow-headers", request.headers.get("access-control-request-headers") ?? FALLBACK_ALLOW_HEADERS);
  out.headers.set("access-control-max-age", "86400");
  out.headers.set("x-content-type-options", "nosniff");
  return out;
}

async function describe(request: Request): Promise<Response> {
  const { profile } = await loadProfile();
  const origin = new URL(request.url).origin;
  const links = isObject(profile.links) ? profile.links : {};
  return json(
    200,
    {
      name: serverInfo(profile).name,
      version: SERVER_VERSION,
      description: `Public, read-only MCP server for the GitHub profile of ${profile.name}. No authentication, no sessions, tools only.`,
      transport: "streamable-http",
      protocolVersions: SUPPORTED_VERSIONS,
      endpoint: `${origin}/mcp`,
      usage: `POST JSON-RPC 2.0 to ${origin}/mcp (for example: claude mcp add --transport http ricardocunha ${origin}/mcp)`,
      stats: `${origin}/stats`,
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
      profile: links.github ?? "https://github.com/ricardocunha",
      source: "https://github.com/ricardocunha/ricardocunha/tree/main/mcp",
    },
    { "cache-control": "public, max-age=300" },
  );
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  const { method } = request;

  if (method === "OPTIONS") return new Response(null, { status: 204 });
  const isRead = method === "GET" || method === "HEAD";

  if (path === "/") {
    return isRead ? describe(request) : json(405, { error: "method_not_allowed", hint: "POST JSON-RPC to /mcp" }, { allow: "GET, HEAD, OPTIONS" });
  }

  if (path === "/stats") {
    if (!isRead) return json(405, { error: "method_not_allowed" }, { allow: "GET, HEAD, OPTIONS" });
    try {
      return json(200, await getStats(env), { "cache-control": "public, max-age=60" });
    } catch {
      return json(503, { error: "stats_unavailable" }, { "cache-control": "no-store", "retry-after": "60" });
    }
  }

  if (path === "/mcp") {
    if (isRead) {
      // A client asking for an SSE stream (pre-2026 Streamable HTTP) must get 405, or it
      // would try to read this document as an event stream. Everyone else gets the document.
      if ((request.headers.get("accept") ?? "").includes("text/event-stream")) {
        return json(405, { error: "method_not_allowed", hint: "This server offers no SSE stream; POST JSON-RPC here." }, { allow: "POST, OPTIONS" });
      }
      return describe(request);
    }
    if (method !== "POST") return json(405, { error: "method_not_allowed" }, { allow: "GET, POST, OPTIONS" });

    const allow = allowedOrigins(env);
    const origin = request.headers.get("origin");
    if (allow !== null && origin !== null && !allow.includes(origin)) {
      return json(403, { jsonrpc: "2.0", error: { code: -32600, message: "Origin not allowed" } });
    }

    // Per-address limit. The address is only a key in Cloudflare's limiter; it is never stored or logged here.
    if (env.RATE_LIMITER) {
      try {
        const key = request.headers.get("cf-connecting-ip") ?? "unknown";
        const { success } = await env.RATE_LIMITER.limit({ key });
        if (!success) return json(429, { error: "rate_limited", hint: "Too many requests; retry in a minute." }, { "retry-after": "60" });
      } catch {
        // Fail open: the limiter must never take the server down.
      }
    }

    const { response, event } = await handleMcpPost(request, { loadProfile, getStats: () => getStats(env) });
    if (event) {
      // Counting never delays or fails the response.
      ctx.waitUntil(
        Promise.resolve()
          .then(() => counters(env).record(event))
          .catch(() => {}),
      );
    }
    return response;
  }

  return json(404, { error: "not_found", endpoints: ["/", "/mcp", "/stats"] });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let response: Response;
    try {
      response = await route(request, env, ctx);
    } catch {
      response = json(500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } });
    }
    return withCors(response, request, env);
  },
} satisfies ExportedHandler<Env>;
