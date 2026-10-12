import type { UsageEvent } from "./counters";
import type { JsonObject, ProfileData } from "./profile";
import { isObject } from "./profile";
import type { StatsDoc } from "./stats";
import { TOOLS, TOOL_NAMES, callTool } from "./tools";

export const SERVER_VERSION = "1.0.0";
export const DEFAULT_SERVER_NAME = "ricardocunha-profile";

/** Stateless revision: per-request metadata, no handshake. */
export const MODERN_VERSIONS = ["2026-07-28"];
/** Handshake-based revisions that used Streamable HTTP. Newest first. */
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

export const MAX_BODY_BYTES = 16 * 1024;
const MAX_CLIENT_NAME = 40;
const LIST_TTL_MS = 300_000;

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_CLIENT_CAPS = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

const E_PARSE = -32700;
const E_INVALID_REQUEST = -32600;
const E_METHOD_NOT_FOUND = -32601;
const E_INVALID_PARAMS = -32602;
const E_HEADER_MISMATCH = -32020;
const E_UNSUPPORTED_VERSION = -32022;

const COUNTED_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "notifications/cancelled",
  "ping",
  "server/discover",
  "tools/list",
  "tools/call",
]);

export interface McpDeps {
  loadProfile: () => Promise<ProfileData>;
  getStats: () => Promise<StatsDoc>;
}

export interface McpOutcome {
  response: Response;
  /** Set when the body was a well-formed JSON-RPC message worth counting. */
  event?: UsageEvent;
}

type Id = string | number | null;

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
const rpcError = (status: number, id: Id, code: number, message: string, data?: unknown) =>
  json(status, { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } });
const rpcResult = (id: Id, result: unknown) => json(200, { jsonrpc: "2.0", id, result });

export function instructions(profile: JsonObject): string {
  const name = typeof profile.name === "string" ? profile.name : "the profile owner";
  return (
    `Read-only public profile of ${name}. Use get_resume for background and skills, get_projects for current work ` +
    "(repeat each project's `status` caveat as written), check_availability before stating whether he is open to work, " +
    "and get_stats for GitHub and server usage figures. Nothing here sends messages or writes data."
  );
}

export function serverInfo(profile: JsonObject) {
  const mcp = profile.mcp;
  const name = isObject(mcp) && typeof mcp.serverName === "string" && mcp.serverName ? mcp.serverName : DEFAULT_SERVER_NAME;
  return { name, title: `${typeof profile.name === "string" ? profile.name : name} profile`, version: SERVER_VERSION };
}

/** Coarse client family from the User-Agent, used when the request carries no clientInfo. */
export function userAgentFamily(ua: string | null): string {
  const s = (ua ?? "").toLowerCase();
  if (!s) return "unknown";
  if (s.includes("claude")) return "claude";
  if (s.includes("openai") || s.includes("chatgpt")) return "openai";
  if (s.includes("cursor")) return "cursor";
  if (s.includes("vscode") || s.includes("visual studio code")) return "vscode";
  if (s.includes("inspector")) return "mcp-inspector";
  if (s.includes("python") || s.includes("httpx") || s.includes("aiohttp")) return "python";
  if (s.includes("node") || s.includes("undici") || s.includes("bun/") || s.includes("deno")) return "node";
  if (s.includes("go-http-client")) return "go";
  if (s.includes("curl") || s.includes("wget") || s.includes("httpie")) return "curl";
  if (s.includes("mozilla")) return "browser";
  return "other";
}

export function clientName(info: unknown, ua: string | null): string {
  if (isObject(info) && typeof info.name === "string") {
    const clean = info.name
      .replace(/[^A-Za-z0-9 ._@/+-]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_CLIENT_NAME)
      .trim();
    if (clean) return clean;
  }
  return userAgentFamily(ua);
}

/** Reads at most `limit` bytes; returns null when the body is larger. */
async function readBody(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Mcp-Name may arrive as `=?base64?...?=` when the value is not plain ASCII. */
function decodeHeaderValue(value: string): string {
  const m = /^=\?base64\?(.*)\?=$/.exec(value);
  if (!m) return value;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(m[1] ?? ""), (c) => c.charCodeAt(0)));
  } catch {
    return value;
  }
}

export async function handleMcpPost(request: Request, deps: McpDeps): Promise<McpOutcome> {
  const raw = await readBody(request, MAX_BODY_BYTES);
  if (raw === null) {
    return { response: rpcError(413, null, E_INVALID_REQUEST, `Request body exceeds ${MAX_BODY_BYTES} bytes`) };
  }

  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { response: rpcError(400, null, E_PARSE, "Parse error: body is not valid JSON") };
  }
  if (Array.isArray(msg)) {
    // Batching existed only in 2025-03-26 and was removed in 2025-06-18.
    return {
      response: rpcError(400, null, E_INVALID_REQUEST, "Invalid Request: JSON-RPC batches are not supported; send one message per POST"),
    };
  }
  if (!isObject(msg) || msg.jsonrpc !== "2.0") {
    return { response: rpcError(400, null, E_INVALID_REQUEST, "Invalid Request: expected a JSON-RPC 2.0 object") };
  }
  if (msg.method === undefined && ("result" in msg || "error" in msg)) {
    // A client response to a server request. This server never sends requests; accept and ignore.
    return { response: new Response(null, { status: 202 }) };
  }
  if (typeof msg.method !== "string" || msg.method === "") {
    return { response: rpcError(400, null, E_INVALID_REQUEST, "Invalid Request: `method` must be a string") };
  }
  const method = msg.method;
  const hasId = "id" in msg;
  if (hasId && typeof msg.id !== "string" && !(typeof msg.id === "number" && Number.isInteger(msg.id))) {
    return { response: rpcError(400, null, E_INVALID_REQUEST, "Invalid Request: `id` must be a string or an integer") };
  }
  const id = hasId ? (msg.id as string | number) : null;
  if (msg.params !== undefined && !isObject(msg.params)) {
    return { response: rpcError(400, id, E_INVALID_REQUEST, "Invalid Request: `params` must be an object") };
  }
  const params: JsonObject = isObject(msg.params) ? msg.params : {};
  const meta: JsonObject = isObject(params._meta) ? params._meta : {};
  const ua = request.headers.get("user-agent");
  const event: UsageEvent = {
    method: COUNTED_METHODS.has(method) ? method : "other",
    client: clientName(meta[META_CLIENT_INFO] ?? params.clientInfo, ua),
  };

  // Notifications get 202 and no body, whatever the method.
  if (!hasId) return { response: new Response(null, { status: 202 }), event };

  const headerVersion = request.headers.get("mcp-protocol-version");
  const bodyVersion = meta[META_VERSION];
  const unsupported = (requested: unknown) =>
    rpcError(400, id, E_UNSUPPORTED_VERSION, "Unsupported protocol version", { supported: SUPPORTED_VERSIONS, requested });

  if (headerVersion !== null && !SUPPORTED_VERSIONS.includes(headerVersion)) return { response: unsupported(headerVersion) };

  const data = await deps.loadProfile();
  const info = serverInfo(data.profile);
  const toolDeps = { data, getStats: deps.getStats };

  const modern = bodyVersion !== undefined || (headerVersion !== null && MODERN_VERSIONS.includes(headerVersion));
  if (modern) {
    // 2026-07-28: every request is self-contained and its headers must mirror the body.
    const mismatch = (message: string) => ({ response: rpcError(400, id, E_HEADER_MISMATCH, `Header mismatch: ${message}`) });
    if (typeof bodyVersion !== "string") {
      return { response: rpcError(400, id, E_INVALID_PARAMS, `Invalid params: _meta["${META_VERSION}"] is required`) };
    }
    if (headerVersion === null) return mismatch("MCP-Protocol-Version header is required");
    if (headerVersion !== bodyVersion) {
      return mismatch(`MCP-Protocol-Version header '${headerVersion}' does not match body value '${bodyVersion.slice(0, 32)}'`);
    }
    if (!MODERN_VERSIONS.includes(bodyVersion)) return { response: unsupported(bodyVersion) };
    if (!isObject(meta[META_CLIENT_CAPS])) {
      return { response: rpcError(400, id, E_INVALID_PARAMS, `Invalid params: _meta["${META_CLIENT_CAPS}"] is required`) };
    }
    const headerMethod = request.headers.get("mcp-method");
    if (headerMethod === null) return mismatch("Mcp-Method header is required");
    if (headerMethod !== method) return mismatch("Mcp-Method header does not match body method");
    if (method === "tools/call") {
      const headerName = request.headers.get("mcp-name");
      if (headerName === null) return mismatch("Mcp-Name header is required for tools/call");
      if (decodeHeaderValue(headerName) !== params.name) return mismatch("Mcp-Name header does not match params.name");
    }

    const complete = (result: object) => ({ resultType: "complete", ...result, _meta: { [META_SERVER_INFO]: info } });
    const cacheable = { ttlMs: LIST_TTL_MS, cacheScope: "public" };
    switch (method) {
      case "server/discover":
        return {
          event,
          response: rpcResult(
            id,
            complete({
              supportedVersions: SUPPORTED_VERSIONS,
              capabilities: { tools: {} },
              instructions: instructions(data.profile),
              ...cacheable,
            }),
          ),
        };
      case "tools/list":
        return { event, response: rpcResult(id, complete({ tools: TOOLS, ...cacheable })) };
      case "tools/call": {
        const r = await runTool(id, params, toolDeps, event);
        return { event, response: "result" in r ? rpcResult(id, complete(r.result)) : r.error };
      }
      default:
        // `initialize` and `ping` do not exist in this revision.
        return { event, response: rpcError(404, id, E_METHOD_NOT_FOUND, `Method not found: ${method.slice(0, 64)}`) };
    }
  }

  // 2025-03-26 to 2025-11-25: initialize handshake, then plain requests. No session is minted.
  switch (method) {
    case "initialize": {
      const requested = params.protocolVersion;
      const protocolVersion =
        typeof requested === "string" && LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0];
      return {
        event,
        response: rpcResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: info,
          instructions: instructions(data.profile),
        }),
      };
    }
    case "ping":
      return { event, response: rpcResult(id, {}) };
    case "tools/list":
      return { event, response: rpcResult(id, { tools: TOOLS }) };
    case "tools/call": {
      const r = await runTool(id, params, toolDeps, event);
      return { event, response: "result" in r ? rpcResult(id, r.result) : r.error };
    }
    default:
      return { event, response: rpcError(200, id, E_METHOD_NOT_FOUND, `Method not found: ${method.slice(0, 64)}`) };
  }
}

async function runTool(
  id: Id,
  params: JsonObject,
  deps: Parameters<typeof callTool>[2],
  event: UsageEvent,
): Promise<{ result: object } | { error: Response }> {
  if (typeof params.name !== "string") {
    return { error: rpcError(200, id, E_INVALID_PARAMS, "Invalid params: `name` must be a string") };
  }
  if (params.arguments !== undefined && params.arguments !== null && !isObject(params.arguments)) {
    return { error: rpcError(200, id, E_INVALID_PARAMS, "Invalid params: `arguments` must be an object") };
  }
  if (!TOOL_NAMES.includes(params.name)) {
    return { error: rpcError(200, id, E_INVALID_PARAMS, `Unknown tool: ${params.name.slice(0, 64)}`) };
  }
  event.tool = params.name;
  const result = await callTool(params.name, isObject(params.arguments) ? params.arguments : {}, deps);
  return result ? { result } : { error: rpcError(200, id, E_INVALID_PARAMS, `Unknown tool: ${params.name}`) };
}
