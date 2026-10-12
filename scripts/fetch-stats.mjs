// Refreshes data/stats.json.
//
// GitHub figures need a token in GH_TOKEN or GITHUB_TOKEN. MCP usage is read from
// <origin of mcp.url>/stats when mcp.url is set in data/profile.json.
//
// A failed fetch never blanks anything: each figure keeps its previous value unless
// a valid new one arrived, and the script always exits 0. The file is only rewritten
// (and generatedAt only moves) when a figure actually changed, so a scheduled run
// with nothing new produces no commit.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATS_FILE = path.join(ROOT, 'data/stats.json');
const TIMEOUT_MS = 15_000;

const isCount = (n) => Number.isInteger(n) && n >= 0;

const QUERY = `
query ($login: String!, $after: String) {
  user(login: $login) {
    followers { totalCount }
    publicRepos: repositories(privacy: PUBLIC, ownerAffiliations: OWNER) { totalCount }
    contributionsCollection { contributionCalendar { totalContributions } }
    owned: repositories(privacy: PUBLIC, ownerAffiliations: OWNER, isFork: false, first: 100, after: $after) {
      nodes { stargazerCount }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

async function graphql(token, variables, fetchImpl) {
  const res = await fetchImpl('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'ricardocunha-profile-stats',
    },
    body: JSON.stringify({ query: QUERY, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub GraphQL responded ${res.status}`);
  const body = await res.json();
  // Partial data is fine (e.g. a token that cannot read one field); report and carry on.
  for (const e of body.errors ?? []) console.warn(`stats: GitHub GraphQL error: ${e.message}`);
  if (!body.data?.user) throw new Error('GitHub GraphQL returned no user');
  return body.data.user;
}

// Returns only the figures that were fetched and are valid.
export async function fetchGithub(login, token, fetchImpl = fetch) {
  const first = await graphql(token, { login, after: null }, fetchImpl);
  const out = {
    publicRepos: first.publicRepos?.totalCount,
    followers: first.followers?.totalCount,
    contributionsLastYear: first.contributionsCollection?.contributionCalendar?.totalContributions,
  };

  let stars = 0;
  let page = first.owned;
  while (page) {
    for (const repo of page.nodes ?? []) stars += repo?.stargazerCount ?? 0;
    if (!page.pageInfo?.hasNextPage) break;
    page = (await graphql(token, { login, after: page.pageInfo.endCursor }, fetchImpl)).owned;
  }
  if (first.owned) out.stars = stars;

  return Object.fromEntries(Object.entries(out).filter(([, v]) => isCount(v)));
}

export async function fetchMcp(mcpUrl, fetchImpl = fetch) {
  const res = await fetchImpl(new URL('/stats', new URL(mcpUrl).origin), {
    headers: { accept: 'application/json', 'user-agent': 'ricardocunha-profile-stats' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`MCP /stats responded ${res.status}`);
  const body = await res.json();
  if (!isCount(body?.mcp_events_total) || !isCount(body?.mcp_events_7d)) {
    throw new Error('MCP /stats payload does not match the expected contract');
  }
  const counts = (obj) =>
    Object.fromEntries(Object.entries(obj && typeof obj === 'object' ? obj : {}).filter(([, v]) => isCount(v)));
  return {
    mcp_events_total: body.mcp_events_total,
    mcp_events_7d: body.mcp_events_7d,
    tool_calls: counts(body.tool_calls),
    clients: counts(body.clients),
  };
}

// Merges fresh figures over the previous file. Sources that failed pass `null`.
export function mergeStats(previous, { login, github, mcp }, now = new Date()) {
  const next = {
    generatedAt: previous?.generatedAt ?? null,
    github: { user: login, ...(previous?.github ?? {}), ...(github ?? {}) },
    mcp: mcp ?? previous?.mcp ?? null,
  };
  const changed =
    !previous?.generatedAt ||
    !isDeepStrictEqual(next.github, previous.github) ||
    !isDeepStrictEqual(next.mcp, previous.mcp ?? null);
  if (changed) next.generatedAt = now.toISOString();
  return { next, changed };
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function main() {
  const profile = await readJson(path.join(ROOT, 'data/profile.json'), null);
  if (!profile) throw new Error('data/profile.json is missing or invalid');
  const previous = await readJson(STATS_FILE, null);
  const login = profile.handle;

  let github = null;
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn('stats: no GH_TOKEN/GITHUB_TOKEN set, keeping previous GitHub figures');
  } else {
    try {
      github = await fetchGithub(login, token);
      console.log(`stats: GitHub ${JSON.stringify(github)}`);
    } catch (err) {
      console.warn(`stats: GitHub fetch failed, keeping previous figures (${err.message})`);
    }
  }

  let mcp = null;
  const mcpUrl = (profile.mcp?.url ?? '').trim();
  if (mcpUrl) {
    try {
      mcp = await fetchMcp(mcpUrl);
      console.log(`stats: MCP ${JSON.stringify(mcp)}`);
    } catch (err) {
      console.warn(`stats: MCP fetch failed, keeping previous figures (${err.message})`);
    }
  }

  const { next, changed } = mergeStats(previous, { login, github, mcp });
  if (!changed) {
    console.log('stats: no change');
    return;
  }
  await mkdir(path.dirname(STATS_FILE), { recursive: true });
  await writeFile(STATS_FILE, `${JSON.stringify(next, null, 2)}\n`);
  console.log('stats: wrote data/stats.json');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (err) {
    // A stats outage must never fail the build.
    console.warn(`stats: skipped (${err.message})`);
  }
  process.exitCode = 0;
}
