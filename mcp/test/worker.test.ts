import { createExecutionContext, reset, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bundled from "../../data/profile.json";
import worker from "../src/index";
import { resetProfileCache } from "../src/profile";
import { resetStatsCache } from "../src/stats";

const ORIGIN = "https://mcp.test";
// Default test env: stats cache off, and no rate limiter (its window would leak between tests).
const NO_CACHE = { ...env, STATS_CACHE_SECONDS: "0", RATE_LIMITER: undefined } as Env;
const PHONE_LIKE = /(\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{4,5}[\s.-]?\d{4}\b/;

type Rpc = { jsonrpc: string; id: unknown; result?: any; error?: { code: number; message: string; data?: any } };

async function send(request: Request, e: Env = NO_CACHE): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function post(body: unknown, headers: Record<string, string> = {}, e?: Env): Promise<Response> {
  return send(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    e,
  );
}

const get = (path: string, headers: Record<string, string> = {}, e?: Env) =>
  send(new Request(ORIGIN + path, { headers }), e);

const rpc = (method: string, params?: unknown, id: unknown = 1) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const res = await post(rpc("tools/call", { name, arguments: args }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as Rpc;
  expect(body.error).toBeUndefined();
  expect(body.result.content).toHaveLength(1);
  expect(body.result.content[0].type).toBe("text");
  return { text: body.result.content[0].text, isError: body.result.isError };
}

const stats = async (e?: Env) => (await (await get("/stats", {}, e)).json()) as any;

/** Stubs the two raw.githubusercontent.com fetches. */
function mockGitHub(files: { profile?: () => Response | Promise<Response>; stats?: () => Response | Promise<Response> }) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/data/profile.json") && files.profile) return files.profile();
    if (url.endsWith("/data/stats.json") && files.stats) return files.stats();
    return new Response("404: Not Found", { status: 404 });
  });
}
const jsonRes = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "text/plain" } });

let fetchSpy: ReturnType<typeof mockGitHub>;

beforeEach(async () => {
  await reset();
  resetProfileCache();
  resetStatsCache();
  fetchSpy = mockGitHub({}); // GitHub has neither file: bundled fallback
});
afterEach(() => vi.restoreAllMocks());

describe("handshake (2025 revisions)", () => {
  it("initialize echoes a supported version and describes the server", async () => {
    const res = await post(
      rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "1" } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("mcp-session-id")).toBeNull();
    const body = (await res.json()) as Rpc;
    expect(body.id).toBe(1);
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.capabilities).toEqual({ tools: {} });
    expect(body.result.serverInfo.name).toBe(bundled.mcp.serverName);
    expect(body.result.serverInfo.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.result.instructions).toEqual(expect.any(String));
    expect(body.result.instructions.length).toBeGreaterThan(20);
  });

  it("initialize answers an unknown version with the newest handshake version", async () => {
    const body = (await (await post(rpc("initialize", { protocolVersion: "2099-01-01", capabilities: {} }))).json()) as Rpc;
    expect(body.result.protocolVersion).toBe("2025-11-25");
  });

  it("notifications/initialized returns 202 with no body", async () => {
    const res = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("ping returns an empty result", async () => {
    const body = (await (await post(rpc("ping", undefined, "abc"))).json()) as Rpc;
    expect(body).toEqual({ jsonrpc: "2.0", id: "abc", result: {} });
  });

  it("accepts the MCP-Protocol-Version header of a negotiated version", async () => {
    const res = await post(rpc("tools/list"), { "mcp-protocol-version": "2025-11-25" });
    expect(res.status).toBe(200);
  });
});

describe("tools/list", () => {
  it("lists the four read-only tools", async () => {
    const body = (await (await post(rpc("tools/list"))).json()) as Rpc;
    const tools = body.result.tools as any[];
    expect(tools.map((t) => t.name)).toEqual(["get_resume", "get_projects", "check_availability", "get_stats"]);
    for (const t of tools) {
      expect(t.description).toEqual(expect.any(String));
      expect(t.inputSchema.type).toBe("object");
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(t.annotations.idempotentHint).toBe(true);
      expect(t.annotations.destructiveHint).toBe(false);
    }
    expect(tools[1].inputSchema.properties.name.type).toBe("string");
    // Nothing that sends or writes on the caller's behalf.
    for (const t of tools) expect(t.name).not.toMatch(/send|mail|write|create|update|delete|contact/i);
  });
});

describe("tools/call", () => {
  it("get_resume returns the resume with computed years of experience", async () => {
    const { text, isError } = await call("get_resume");
    expect(isError).toBe(false);
    const r = JSON.parse(text);
    expect(r.name).toBe("Ricardo Cunha");
    expect(r.role).toBe(bundled.role);
    expect(r.base).toBe(bundled.base);
    expect(r.yearsOfExperience).toBe(new Date().getUTCFullYear() - bundled.careerStart);
    expect(r.bio).toBe(bundled.bio);
    expect(r.highlights).toEqual(bundled.highlights);
    expect(r.experience).toEqual(bundled.experience);
    expect(r.skills).toEqual(bundled.skills);
    expect(r.certifications).toEqual(bundled.certifications);
    expect(r.education).toEqual(bundled.education);
    expect(r.links).toEqual(bundled.links);
  });

  it("get_projects returns projects and earlier work with status verbatim", async () => {
    const r = JSON.parse((await call("get_projects")).text);
    expect(r.projects).toEqual(bundled.projects);
    expect(r.earlier).toEqual(bundled.earlier);
    for (const [i, p] of bundled.projects.entries()) expect(r.projects[i].status).toBe(p.status);
  });

  it("get_projects with name returns one project, matched case-insensitively by name or title", async () => {
    expect(JSON.parse((await call("get_projects", { name: "KeelGW" })).text)).toEqual(bundled.projects[0]);
    expect(JSON.parse((await call("get_projects", { name: "sportsvision" })).text).status).toBe(bundled.projects[1]!.status);
    expect(JSON.parse((await call("get_projects", { name: "stack-cli" })).text)).toEqual(bundled.earlier[2]);
  });

  it("get_projects reports an unknown or invalid name as a tool error", async () => {
    const missing = await call("get_projects", { name: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("keelgw");
    expect((await call("get_projects", { name: 42 })).isError).toBe(true);
  });

  it("check_availability makes no availability claim while the field is empty", async () => {
    expect(bundled.availability).toBe("");
    const { text, isError } = await call("check_availability");
    expect(isError).toBe(false);
    const r = JSON.parse(text);
    expect(r.availability).toBeNull();
    expect(r.contact).toEqual(bundled.links);
    expect(r.message).toContain("contact links");
    expect(r.message).not.toMatch(/\b(is|currently|not)\s+(available|unavailable|open|looking)|open to|hire|busy/i);
  });

  it("check_availability returns the profile's availability when it is set", async () => {
    fetchSpy.mockRestore();
    mockGitHub({ profile: () => jsonRes({ ...bundled, availability: "Open to principal roles from January." }) });
    const r = JSON.parse((await call("check_availability")).text);
    expect(r.availability).toBe("Open to principal roles from January.");
    expect(r.message).toBeUndefined();
  });

  it("get_stats returns GitHub figures and the same usage data as /stats", async () => {
    fetchSpy.mockRestore();
    mockGitHub({ stats: () => jsonRes({ stars: 12, anything: { nested: true } }) });
    await call("get_resume");
    const r = JSON.parse((await call("get_stats")).text);
    expect(r.github).toEqual({ stars: 12, anything: { nested: true } });
    expect(Object.keys(r.mcp).sort()).toEqual(["clients", "generatedAt", "mcp_events_7d", "mcp_events_total", "tool_calls"]);
    expect(r.mcp.tool_calls.get_resume).toBe(1);
  });

  it("get_stats tolerates a missing stats.json", async () => {
    const r = JSON.parse((await call("get_stats")).text);
    expect(r.github.note).toMatch(/not published/);
    expect(r.mcp.mcp_events_total).toEqual(expect.any(Number));
  });

  it("rejects an unknown tool and bad params with -32602", async () => {
    const a = (await (await post(rpc("tools/call", { name: "send_email", arguments: {} }))).json()) as Rpc;
    expect(a.error?.code).toBe(-32602);
    const b = (await (await post(rpc("tools/call", { arguments: {} }))).json()) as Rpc;
    expect(b.error?.code).toBe(-32602);
    const c = (await (await post(rpc("tools/call", { name: "get_resume", arguments: [1] }))).json()) as Rpc;
    expect(c.error?.code).toBe(-32602);
  });
});

describe("no phone number in any output", () => {
  const outputs = async () => {
    const out: string[] = [];
    for (const name of ["get_resume", "get_projects", "check_availability", "get_stats"]) out.push((await call(name)).text);
    for (const p of bundled.projects) out.push((await call("get_projects", { name: p.name })).text);
    out.push(await (await post(rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} }))).text());
    out.push(await (await post(rpc("tools/list"))).text());
    for (const path of ["/", "/mcp", "/stats"]) out.push(await (await get(path)).text());
    return out;
  };

  it("holds for the bundled profile", async () => {
    for (const text of await outputs()) {
      expect(text).not.toMatch(/phone|whatsapp|telefone|celular|"tel"/i);
      expect(text).not.toMatch(PHONE_LIKE);
    }
  });

  it("holds even if the live profile gains phone fields", async () => {
    fetchSpy.mockRestore();
    mockGitHub({
      profile: () =>
        jsonRes({
          ...bundled,
          phone: "+55 61 99999-0000",
          links: { ...bundled.links, phone: "+55 61 99999-0000", whatsapp: "https://wa.me/5561999990000", call: "tel:+5561999990000" },
          experience: [{ ...bundled.experience[0], phoneNumber: "61 99999-0000" }],
        }),
      stats: () => jsonRes({ stars: 1, mobile: "+55 61 99999-0000" }),
    });
    const all = await outputs();
    expect(JSON.parse(all[0]!).links.github).toBe(bundled.links.github); // live copy really was used
    expect(JSON.parse(all[0]!).experience).toHaveLength(1);
    for (const text of all) {
      expect(text).not.toContain("99999");
      expect(text).not.toMatch(/phone|whatsapp|wa\.me|tel:/i);
    }
  });
});

describe("JSON-RPC errors", () => {
  it("unknown method is -32601", async () => {
    const res = await post(rpc("resources/list", undefined, 7));
    const body = (await res.json()) as Rpc;
    expect(body.id).toBe(7);
    expect(body.error?.code).toBe(-32601);
  });

  it("malformed JSON is -32700", async () => {
    const res = await post("{not json");
    expect(res.status).toBe(400);
    const body = (await res.json()) as Rpc;
    expect(body.error?.code).toBe(-32700);
    expect(body.id).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("invalid requests are -32600", async () => {
    for (const bad of [{ foo: 1 }, { jsonrpc: "1.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 1 }, rpc("ping", undefined, null), "42", { jsonrpc: "2.0", id: 1, method: "ping", params: [1] }]) {
      const res = await post(bad);
      expect(res.status).toBe(400);
      expect(((await res.json()) as Rpc).error?.code).toBe(-32600);
    }
  });

  it("batch arrays are rejected explicitly", async () => {
    const res = await post([rpc("ping"), rpc("tools/list", undefined, 2)]);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Rpc;
    expect(body.error?.code).toBe(-32600);
    expect(body.error?.message).toMatch(/batch/i);
  });

  it("oversized bodies are refused with 413", async () => {
    const res = await post(rpc("ping", { pad: "x".repeat(20_000) }));
    expect(res.status).toBe(413);
    expect((await stats()).mcp_events_total).toBe(0);
  });

  it("an unsupported MCP-Protocol-Version header is refused with the supported list", async () => {
    const res = await post(rpc("tools/list"), { "mcp-protocol-version": "1900-01-01" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Rpc;
    expect(body.error?.code).toBe(-32022);
    expect(body.error?.data.supported).toContain("2026-07-28");
    expect(body.error?.data.requested).toBe("1900-01-01");
  });
});

describe("stateless requests (2026-07-28)", () => {
  const V = "2026-07-28";
  const meta = (extra: object = {}) => ({
    _meta: {
      "io.modelcontextprotocol/protocolVersion": V,
      "io.modelcontextprotocol/clientInfo": { name: "modern-client", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
      ...extra,
    },
  });
  const h = (method: string, name?: string) => ({ "mcp-protocol-version": V, "mcp-method": method, ...(name ? { "mcp-name": name } : {}) });

  it("server/discover advertises versions, capabilities and identity", async () => {
    const res = await post(rpc("server/discover", meta()), h("server/discover"));
    expect(res.status).toBe(200);
    const { result } = (await res.json()) as Rpc;
    expect(result.resultType).toBe("complete");
    expect(result.supportedVersions).toEqual(["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"]);
    expect(result.capabilities).toEqual({ tools: {} });
    expect(result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("ricardocunha-profile");
    expect(result.ttlMs).toEqual(expect.any(Number));
    expect(result.cacheScope).toBe("public");
  });

  it("tools/list and tools/call work without a handshake", async () => {
    const list = (await (await post(rpc("tools/list", meta()), h("tools/list"))).json()) as Rpc;
    expect(list.result.resultType).toBe("complete");
    expect(list.result.tools).toHaveLength(4);
    expect(list.result.cacheScope).toBe("public");

    const res = await post(rpc("tools/call", { name: "get_projects", arguments: { name: "keelgw" }, ...meta() }), h("tools/call", "get_projects"));
    const { result } = (await res.json()) as Rpc;
    expect(result.resultType).toBe("complete");
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text).status).toBe(bundled.projects[0]!.status);
    expect((await stats()).clients["modern-client"]).toBe(2);
  });

  it("accepts a base64-encoded Mcp-Name", async () => {
    const res = await post(rpc("tools/call", { name: "get_resume", ...meta() }), h("tools/call", `=?base64?${btoa("get_resume")}?=`));
    expect(res.status).toBe(200);
  });

  it("rejects header and body disagreement with -32020", async () => {
    const cases: [unknown, Record<string, string>][] = [
      [rpc("tools/list", meta()), { "mcp-protocol-version": V }], // no Mcp-Method
      [rpc("tools/list", meta()), h("tools/call")],
      [rpc("tools/call", { name: "get_resume", ...meta() }), h("tools/call")], // no Mcp-Name
      [rpc("tools/call", { name: "get_resume", ...meta() }), h("tools/call", "get_stats")],
      [rpc("tools/list", meta()), { "mcp-method": "tools/list" }], // no version header
      [rpc("tools/list", meta()), { ...h("tools/list"), "mcp-protocol-version": "2025-11-25" }],
    ];
    for (const [body, headers] of cases) {
      const res = await post(body, headers);
      expect(res.status).toBe(400);
      expect(((await res.json()) as Rpc).error?.code).toBe(-32020);
    }
  });

  it("requires the _meta protocol fields", async () => {
    const noVersion = await post(rpc("tools/list", { _meta: {} }), h("tools/list"));
    expect(noVersion.status).toBe(400);
    expect(((await noVersion.json()) as Rpc).error?.code).toBe(-32602);
    const noCaps = await post(rpc("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": V } }), h("tools/list"));
    expect(noCaps.status).toBe(400);
    expect(((await noCaps.json()) as Rpc).error?.code).toBe(-32602);
  });

  it("unknown methods, including initialize and ping, are 404 with -32601", async () => {
    for (const m of ["initialize", "ping", "resources/list"]) {
      const res = await post(rpc(m, meta()), h(m));
      expect(res.status).toBe(404);
      expect(((await res.json()) as Rpc).error?.code).toBe(-32601);
    }
  });
});

describe("HTTP surface", () => {
  it("answers OPTIONS preflight with open CORS", async () => {
    for (const path of ["/mcp", "/stats", "/"]) {
      const res = await send(
        new Request(ORIGIN + path, {
          method: "OPTIONS",
          headers: { origin: "https://claude.ai", "access-control-request-method": "POST", "access-control-request-headers": "content-type, mcp-protocol-version" },
        }),
      );
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-methods")).toContain("POST");
      expect(res.headers.get("access-control-allow-headers")).toContain("mcp-protocol-version");
    }
  });

  it("sends CORS headers on every kind of response", async () => {
    const responses = [await post(rpc("ping")), await get("/"), await get("/stats"), await get("/nope"), await post({ jsonrpc: "2.0", method: "notifications/initialized" })];
    for (const res of responses) expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(responses[3]!.status).toBe(404);
  });

  it("GET / and GET /mcp return a self-describing document", async () => {
    for (const path of ["/", "/mcp"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      const doc = (await res.json()) as any;
      expect(doc.name).toBe("ricardocunha-profile");
      expect(doc.description).toContain("Ricardo Cunha");
      expect(doc.endpoint).toBe(`${ORIGIN}/mcp`);
      expect(doc.stats).toBe(`${ORIGIN}/stats`);
      expect(doc.tools.map((t: any) => t.name)).toContain("check_availability");
      expect(doc.profile).toBe("https://github.com/ricardocunha");
    }
  });

  it("GET /mcp asking for an SSE stream gets 405, as do PUT and DELETE", async () => {
    const sse = await get("/mcp", { accept: "text/event-stream" });
    expect(sse.status).toBe(405);
    expect(sse.headers.get("allow")).toContain("POST");
    for (const method of ["DELETE", "PUT"]) {
      expect((await send(new Request(`${ORIGIN}/mcp`, { method }))).status).toBe(405);
    }
  });

  it("restricts browser origins only when ALLOWED_ORIGINS is set", async () => {
    expect((await post(rpc("ping"), { origin: "https://anything.example" })).status).toBe(200);
    const locked = { ...NO_CACHE, ALLOWED_ORIGINS: "https://claude.ai, https://chatgpt.com" } as Env;
    const bad = await post(rpc("ping"), { origin: "https://evil.example" }, locked);
    expect(bad.status).toBe(403);
    const good = await post(rpc("ping"), { origin: "https://claude.ai" }, locked);
    expect(good.status).toBe(200);
    expect(good.headers.get("access-control-allow-origin")).toBe("https://claude.ai");
    expect((await post(rpc("ping"), {}, locked)).status).toBe(200); // no Origin: not a browser
  });

  it("the configured rate limit binding allows 60 requests a minute per address", async () => {
    const real = { ...NO_CACHE, RATE_LIMITER: env.RATE_LIMITER } as Env;
    const statuses: number[] = [];
    for (let i = 0; i < 65; i++) statuses.push((await post(rpc("ping"), { "cf-connecting-ip": "203.0.113.9" }, real)).status);
    expect(statuses.filter((x) => x === 200)).toHaveLength(60);
    expect(statuses.slice(60)).toEqual([429, 429, 429, 429, 429]);
    expect((await post(rpc("ping"), { "cf-connecting-ip": "203.0.113.10" }, real)).status).toBe(200); // another address
  });

  it("applies the rate limiter and fails open when it breaks", async () => {
    const limited = { ...NO_CACHE, RATE_LIMITER: { limit: async () => ({ success: false }) } } as unknown as Env;
    const res = await post(rpc("ping"), {}, limited);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    const broken = { ...NO_CACHE, RATE_LIMITER: { limit: async () => { throw new Error("down"); } } } as unknown as Env;
    expect((await post(rpc("ping"), {}, broken)).status).toBe(200);
    expect((await stats()).mcp_events_total).toBe(1); // the limited request was not counted
  });
});

describe("usage metrics", () => {
  it("/stats has exactly the contract shape", async () => {
    const res = await get("/stats");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const s = (await res.json()) as any;
    expect(Object.keys(s)).toEqual(["generatedAt", "mcp_events_total", "mcp_events_7d", "tool_calls", "clients"]);
    expect(new Date(s.generatedAt).toISOString()).toBe(s.generatedAt);
    expect(s).toMatchObject({ mcp_events_total: 0, mcp_events_7d: 0, tool_calls: {}, clients: {} });
  });

  it("counts events, tool calls and clients", async () => {
    const ua = { "user-agent": "curl/8.7.1" };
    await post(rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "0.1" } }), ua);
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, ua);
    await post(rpc("tools/list"), ua);
    await post(rpc("tools/call", { name: "get_resume" }), ua);
    await post(rpc("tools/call", { name: "get_resume" }), ua);
    await post(rpc("tools/call", { name: "get_projects", arguments: { name: "keelgw" } }), ua);
    await post(rpc("tools/call", { name: "no_such_tool" }), ua);
    await post("{broken", ua); // not counted
    await get("/"); // not counted

    const s = await stats();
    expect(s.mcp_events_total).toBe(7);
    expect(s.mcp_events_7d).toBe(7);
    expect(s.tool_calls).toEqual({ get_resume: 2, get_projects: 1 });
    expect(s.clients).toEqual({ curl: 6, "claude-ai": 1 });
  });

  it("increments are not lost under concurrency", async () => {
    await Promise.all(Array.from({ length: 40 }, () => post(rpc("tools/call", { name: "check_availability" }))));
    const s = await stats();
    expect(s.mcp_events_total).toBe(40);
    expect(s.tool_calls.check_availability).toBe(40);
  });

  it("caps client name length, strips odd characters and bounds distinct clients", async () => {
    const init = (name: unknown) => post(rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name } }), { "user-agent": "Mozilla/5.0" });
    await init("x".repeat(500));
    await init('<script>alert("1")</script>\n evil');
    await init(12345); // not a string: falls back to the User-Agent family
    let s = await stats();
    expect(s.clients["x".repeat(40)]).toBe(1);
    expect(s.clients['scriptalert1/script evil']).toBe(1);
    expect(s.clients.browser).toBe(1);

    for (let i = 0; i < 60; i++) await init(`scanner-${i}`);
    s = await stats();
    const keys = Object.keys(s.clients);
    expect(keys.length).toBe(51); // 50 distinct names plus "other"
    expect(s.clients.other).toBe(13);
    expect(s.mcp_events_total).toBe(63);
    for (const k of keys) expect(k.length).toBeLessThanOrEqual(40);
  });

  it("serves /stats from a 60 second cache", async () => {
    const cachedEnv = { ...NO_CACHE, STATS_CACHE_SECONDS: "60" } as Env;
    const first = (await (await get("/stats", {}, cachedEnv)).json()) as any;
    await post(rpc("ping"), {}, cachedEnv);
    const second = (await (await get("/stats", {}, cachedEnv)).json()) as any;
    expect(second).toEqual(first);
    expect((await stats()).mcp_events_total).toBe(1); // uncached read sees the new event
  });

  it("a failing counter store never fails the request", async () => {
    const broken = {
      ...NO_CACHE,
      COUNTERS: { idFromName: () => ({}), get: () => ({ record: () => Promise.reject(new Error("down")), snapshot: () => Promise.reject(new Error("down")) }) },
    } as unknown as Env;
    const res = await post(rpc("tools/call", { name: "get_stats" }), {}, broken);
    expect(res.status).toBe(200);
    const text = ((await res.json()) as Rpc).result.content[0].text;
    expect(JSON.parse(text).mcp).toBeNull();
    expect((await get("/stats", {}, broken)).status).toBe(503);
  });
});

describe("profile data source", () => {
  const resumeName = async () => JSON.parse((await call("get_resume")).text).name;

  it("prefers the live profile and caches it", async () => {
    fetchSpy.mockRestore();
    const spy = mockGitHub({ profile: () => jsonRes({ ...bundled, name: "Live Name", mcp: { url: "", serverName: "live-server" } }) });
    expect(await resumeName()).toBe("Live Name");
    const init = (await (await post(rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} }))).json()) as Rpc;
    expect(init.result.serverInfo.name).toBe("live-server");
    expect(spy).toHaveBeenCalledTimes(2); // profile.json and stats.json, once each
    expect(String(spy.mock.calls[0]![0])).toBe("https://raw.githubusercontent.com/ricardocunha/ricardocunha/main/data/profile.json");
  });

  it("falls back to the bundled profile on 404", async () => {
    expect(await resumeName()).toBe(bundled.name);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("falls back on invalid JSON", async () => {
    fetchSpy.mockRestore();
    mockGitHub({ profile: () => new Response("<html>oops"), stats: () => new Response("{{") });
    expect(await resumeName()).toBe(bundled.name);
    expect(JSON.parse((await call("get_stats")).text).github.note).toBeDefined();
  });

  it("falls back on JSON that is not a profile", async () => {
    fetchSpy.mockRestore();
    mockGitHub({ profile: () => jsonRes({ name: "Half A Profile" }), stats: () => jsonRes([1, 2]) });
    expect(await resumeName()).toBe(bundled.name);
  });

  it("falls back when the network fails", async () => {
    fetchSpy.mockRestore();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network down"));
    expect(await resumeName()).toBe(bundled.name);
    expect(JSON.parse((await call("get_projects")).text).projects).toEqual(bundled.projects);
  });
});
