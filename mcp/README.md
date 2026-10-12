# ricardocunha-profile MCP server

A small public, read-only [MCP](https://modelcontextprotocol.io) server for Ricardo Cunha's GitHub profile, running as a Cloudflare Worker. An AI assistant can connect to it and ask about his resume, projects and availability.

It is a hand-written, stateless JSON-RPC handler over Streamable HTTP: plain `application/json` responses, no SSE, no sessions, no authentication, tools only, open CORS. It has no runtime dependencies.

The server is served from `https://mcp.ricardocunha.dev` (a custom domain route in `wrangler.jsonc`; the zone `ricardocunha.dev` must be active in the same Cloudflare account).

## Tools

All tools are read-only and idempotent. Nothing sends email or writes on the caller's behalf, and no phone number is ever returned.

| Tool | Input | Returns |
| --- | --- | --- |
| `get_resume` | none | Name, role, base, years of experience, bio, highlights, experience, skills, certifications, education, links |
| `get_projects` | optional `name` | Current projects and earlier work, or one project. Each project's `status` caveat is returned as written |
| `check_availability` | none | The published availability, or a neutral pointer to the contact links when none is published |
| `get_stats` | none | GitHub figures (`data/stats.json`, when it exists) and this server's usage counters |

## Routes

| Route | Purpose |
| --- | --- |
| `POST /mcp` | JSON-RPC 2.0 endpoint |
| `GET /`, `GET /mcp` | Self-describing JSON document |
| `GET /stats` | Public usage metrics, cached for 60 seconds |
| `OPTIONS *` | CORS preflight |

`GET /stats` returns exactly:

```json
{
  "generatedAt": "2026-10-12T18:33:30.285Z",
  "mcp_events_total": 34,
  "mcp_events_7d": 34,
  "tool_calls": { "get_resume": 3 },
  "clients": { "claude-ai": 5 }
}
```

The profile README's scheduled job reads this shape. An event is one valid JSON-RPC message sent to `/mcp`. The 7-day figure covers today and the six previous UTC days.

## Connect

- Claude Code: `claude mcp add --transport http ricardocunha https://mcp.ricardocunha.dev/mcp`
- Claude (web or desktop): Settings, Connectors, Add custom connector, then paste `https://mcp.ricardocunha.dev/mcp`. Leave the OAuth fields empty.
- Cursor: add this to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

  ```json
  { "mcpServers": { "ricardocunha": { "url": "https://mcp.ricardocunha.dev/mcp" } } }
  ```

- ChatGPT: Settings, Apps & Connectors, Advanced settings, turn on Developer mode. Then create a connector with the MCP server URL `https://mcp.ricardocunha.dev/mcp` and authentication set to "No authentication".
- Anything else:

  ```sh
  curl -s https://mcp.ricardocunha.dev/mcp \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_projects","arguments":{"name":"keelgw"}}}'
  ```

## Protocol

The server speaks both generations of MCP on the same endpoint:

- `2026-07-28` (stateless): every request carries its version in `_meta` and in the `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers. Supports `server/discover`, `tools/list`, `tools/call`. Headers that disagree with the body are refused with `-32020`, an unknown method is `404` with `-32601`.
- `2025-11-25`, `2025-06-18`, `2025-03-26` (handshake): `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`. No session ID is issued, so no state is needed between requests.

Other behaviour:

- Notifications get `202` with no body.
- JSON-RPC batch arrays are refused with `-32600` (batching was removed from MCP in 2025-06-18).
- Malformed JSON is `-32700`, an invalid request is `-32600`, an unknown tool is `-32602`.
- An unsupported `MCP-Protocol-Version` header is `400` with `-32022` and the list of supported versions.
- `GET /mcp` with `Accept: text/event-stream` gets `405`, because older clients probe for an SSE stream that way. Any other `GET` gets the JSON document.
- `Origin` is accepted from anywhere by default: the data is public and no credentials are involved. Set `ALLOWED_ORIGINS` in `wrangler.jsonc` to a comma-separated list to refuse other browser origins with `403`.

## Data

`../data/profile.json` is bundled into the Worker at build time. At runtime the Worker prefers the live copy at `https://raw.githubusercontent.com/ricardocunha/ricardocunha/main/data/profile.json`, cached in memory for five minutes, and falls back to the bundled copy on any error, timeout or invalid JSON. `data/stats.json` from the same place is passed through untouched under `github` in `get_stats`; if it is missing, the tool says so.

So a push to `main` updates the server within five minutes, with no redeploy. Redeploy only to refresh the fallback copy or change code.

## Usage metrics and privacy

Counters live in a single SQLite-backed Durable Object (`Counters`), which makes increments atomic. It stores totals per method, per tool and per client name, plus one row per day for the 7-day figure (kept for 35 days).

- The client name is `clientInfo.name` when the request carries one, otherwise a coarse User-Agent family such as `claude`, `node` or `curl`. Clients on the handshake protocol send `clientInfo` only in `initialize`, so their later requests are counted under the User-Agent family.
- Client names are stripped to plain characters and cut to 40 characters. After 50 distinct names, new ones are counted as `other`.
- No IP addresses and no request bodies are stored.
- Counting runs after the response (`ctx.waitUntil`) and its errors are ignored.

## Abuse guard

- Request bodies over 16 KB are refused with `413`.
- `POST /mcp` is limited to 60 requests per minute per client address through the Workers Rate Limiting binding declared in `wrangler.jsonc`. The address is only used as the limiter key inside Cloudflare; this code does not store or log it. The limit is enforced per Cloudflare location and is approximate. If the limiter fails, requests are let through.
- `GET` routes are not rate limited; they are cheap and cacheable.

## Run locally

```sh
npm install
npx wrangler dev        # http://localhost:8787, no Cloudflare login needed
```

```sh
curl -s localhost:8787/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
npx @modelcontextprotocol/inspector --cli http://localhost:8787/mcp --transport http --method tools/list
```

## Test

```sh
npm run typecheck
npm test
```

Tests run inside the Workers runtime with `@cloudflare/vitest-plugin` (the new name of `@cloudflare/vitest-pool-workers`), using the real Durable Object and rate limit binding. Calls to GitHub are stubbed. Vitest is pinned to 4.x: with 5.0.4 the plugin failed to load the test file.

## Deploy checklist

1. `cd mcp && npm install`
2. `npx wrangler login`
3. Bindings: nothing to create and no IDs to fill in. The Durable Object is created by the migration in `wrangler.jsonc` on first deploy, and the rate limit `namespace_id` (`1001`) is just a number you pick; change it only if another Worker in your account already uses it.
4. `npm test`
5. `npx wrangler deploy` and note the URL it prints (the Worker origin).
6. Check it: `curl https://mcp.ricardocunha.dev/` and `curl https://mcp.ricardocunha.dev/stats`.
7. In `data/profile.json`, set `mcp.url` to `https://mcp.ricardocunha.dev/mcp`, then commit and push to `main`.
8. Optional: add a custom domain to the Worker in the Cloudflare dashboard, and use that origin in step 7 instead.
