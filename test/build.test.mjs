import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { badgeSvg, bannerSvg, buildView, renderReadme } from '../scripts/build.mjs';
import { fetchGithub, fetchMcp, mergeStats } from '../scripts/fetch-stats.mjs';

const profile = JSON.parse(await readFile(new URL('../data/profile.json', import.meta.url), 'utf8'));
const template = await readFile(new URL('../templates/README.mustache', import.meta.url), 'utf8');
const NOW = new Date('2026-10-12T00:00:00Z');
const github = { publicRepos: 10, followers: 20, stars: 1, contributionsLastYear: 1234 };
const mcpStats = { mcp_events_total: 50, mcp_events_7d: 5, tool_calls: { get_resume: 30, get_stats: 2 }, clients: {} };
const withMcp = { ...profile, mcp: { ...profile.mcp, url: 'https://example.test/mcp' } };
const withoutMcp = { ...profile, mcp: { ...profile.mcp, url: '' } };

const render = (p, stats, opts) => renderReadme(template, buildView(p, stats, { now: NOW, ...opts }));

test('empty mcp.url leaves no trace of MCP, even when MCP stats exist', () => {
  const out = render(withoutMcp, { github, mcp: mcpStats });
  // Project copy may legitimately mention MCP (keelgw filters remote MCP servers);
  // what must be absent is everything about this profile's own server.
  const ownCopy = profile.projects.reduce((text, p) => text.replace(p.details, ''), out);
  assert.doesNotMatch(ownCopy, /mcp/i);
  assert.doesNotMatch(out, /speaks MCP|badge-mcp|mcp\/README|MCP usage|workers\.dev/);
  assert.doesNotMatch(out, /get_resume|get_projects|check_availability|get_stats/);
});

test('mcp.url set renders callout, badge, usage and contact hint', () => {
  const out = render(withMcp, { github, mcp: mcpStats });
  assert.match(out, /\*\*This profile speaks MCP\.\*\* Point your agent at `https:\/\/example\.test\/mcp`/);
  assert.match(out, /`get_resume`, `get_projects`, `check_availability` and `get_stats`/);
  assert.match(out, /assets\/badge-mcp\.svg/);
  assert.match(out, /MCP usage: 50 events in total · 5 in the last 7 days · most-called tool `get_resume`/);
  assert.match(out, /or let your agent call `get_resume`\./);
});

test('no stray template tags, entities or phone numbers', () => {
  for (const out of [render(withoutMcp, { github }), render(withMcp, { github, mcp: mcpStats })]) {
    assert.doesNotMatch(out, /\{\{|\}\}/);
    assert.doesNotMatch(out, /&#x|undefined|null|NaN/);
    assert.doesNotMatch(out, /\+?\d[\d\s().-]{8,}\d/);
    assert.doesNotMatch(out, /\n{3,}/);
  }
});

test('numbers line computes years and formats and pluralises figures', () => {
  const out = render(withoutMcp, { github });
  assert.match(out, /21 years building software · 10 public repos · 20 followers · 1 star · 1,234 contributions in the last year/);
});

test('missing stats degrade to the computed figure only', () => {
  const out = render(withoutMcp, {});
  assert.match(out, /## By the numbers\n\n21 years building software\n/);
});

test('availability sentence appears only when set', () => {
  assert.match(render(withoutMcp, {}), /## Contact\n\n\[/);
  assert.match(render({ ...withoutMcp, availability: 'Open to talk' }, {}), /## Contact\n\nOpen to talk\. \[/);
});

test('preview paths are rebased', () => {
  const out = render(withMcp, {}, { rootHref: '../' });
  assert.match(out, /\]\(\.\.\/mcp\/README\.md\)/);
});

test('SVGs are self-contained', () => {
  const svgs = [bannerSvg(profile, 'light'), bannerSvg(profile, 'dark'), badgeSvg('Stack Overflow'), badgeSvg('MCP · x', { accent: true })];
  for (const svg of svgs) {
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.doesNotMatch(svg, /href=|url\(|@import|<script|<foreignObject/);
  }
});

test('mergeStats keeps previous values when a source fails', () => {
  const previous = { generatedAt: '2026-01-01T00:00:00.000Z', github: { user: 'x', ...github }, mcp: mcpStats };
  const failed = mergeStats(previous, { login: 'x', github: null, mcp: null }, NOW);
  assert.equal(failed.changed, false);
  assert.deepEqual(failed.next, previous);

  const partial = mergeStats(previous, { login: 'x', github: { followers: 21 }, mcp: null }, NOW);
  assert.equal(partial.changed, true);
  assert.equal(partial.next.github.followers, 21);
  assert.equal(partial.next.github.contributionsLastYear, 1234);
  assert.deepEqual(partial.next.mcp, mcpStats);
  assert.equal(partial.next.generatedAt, NOW.toISOString());
});

const json = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });

test('fetchGithub drops fields the token could not read', async () => {
  const user = {
    followers: { totalCount: 7 },
    publicRepos: { totalCount: 3 },
    contributionsCollection: null,
    owned: { nodes: [{ stargazerCount: 2 }, { stargazerCount: 5 }], pageInfo: { hasNextPage: false } },
  };
  const out = await fetchGithub('x', 't', json({ data: { user }, errors: [{ message: 'forbidden' }] }));
  assert.deepEqual(out, { publicRepos: 3, followers: 7, stars: 7 });
  await assert.rejects(fetchGithub('x', 't', json({}, 502)));
});

test('fetchMcp validates the contract and hits the origin /stats', async () => {
  let called;
  const impl = async (url) => {
    called = String(url);
    return new Response(JSON.stringify({ generatedAt: 'x', ...mcpStats, tool_calls: { a: 1, b: 'bad' } }));
  };
  const out = await fetchMcp('https://example.test/mcp', impl);
  assert.equal(called, 'https://example.test/stats');
  assert.deepEqual(out.tool_calls, { a: 1 });
  await assert.rejects(fetchMcp('https://example.test/mcp', json({ mcp_events_total: 'many' })));
});
