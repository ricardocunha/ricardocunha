// Renders README.md and the SVG assets from data/profile.json and data/stats.json.
//
//   node scripts/build.mjs            -> README.md + assets/
//   node scripts/build.mjs --preview  -> preview/README.with-mcp.md + preview/assets/
//
// data/profile.json is the single source of truth for content. Nothing here adds facts.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Mustache from 'mustache';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEP = ' · ';

// Tool names exposed by the server in mcp/. Keep in sync with mcp/README.md.
export const MCP_TOOLS = ['get_resume', 'get_projects', 'check_availability', 'get_stats'];

const PREVIEW_MCP_URL = 'https://mcp.ricardocunha.dev/mcp';
const PREVIEW_MCP_STATS = {
  mcp_events_total: 1284,
  mcp_events_7d: 96,
  tool_calls: { get_resume: 540, get_projects: 410, check_availability: 190, get_stats: 144 },
  clients: {},
};

// ---------------------------------------------------------------- helpers

const isCount = (n) => Number.isInteger(n) && n >= 0;
const fmt = (n) => n.toLocaleString('en-US');
const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;
const xml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function sentenceList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (fallback !== undefined && err.code === 'ENOENT') return fallback;
    throw err;
  }
}

// ---------------------------------------------------------------- SVG assets

const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif";

const THEMES = {
  light: { bg: '#f6f8fa', border: '#d0d7de', fg: '#1f2328', muted: '#59636e', accent: '#0969da', dot: '#c8d1da' },
  dark: { bg: '#0d1117', border: '#30363d', fg: '#e6edf3', muted: '#8b949e', accent: '#58a6ff', dot: '#262d36' },
};

// Monospace advance is 0.6em in every font of the stack; textLength pins it so
// layout does not depend on which font the viewer has.
const monoWidth = (text, size) => Math.round([...text].length * size * 0.6 * 10) / 10;

export function bannerSvg(profile, themeName) {
  const t = THEMES[themeName];
  const W = 880;
  const H = 220;
  const role = profile.role.toUpperCase();
  const roleSize = 14;
  const roleWidth = monoWidth(role, roleSize) + ([...role].length - 1) * 2;
  const tagSize = 16;
  const tagX = 48;
  const tagWidth = monoWidth(profile.tagline, tagSize);
  const baseWidth = monoWidth(profile.base, 12);

  // Decorative dot grid on the right with a small highlighted graph.
  const gx = 652;
  const gy = 38;
  const step = 24;
  const cols = 9;
  const rows = 7;
  const dots = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      dots.push(`<circle cx="${gx + c * step}" cy="${gy + r * step}" r="1.6"/>`);
    }
  }
  const nodes = [[1, 3], [3, 1], [3, 5], [5, 3], [7, 2], [7, 5]];
  const edges = [[0, 1], [0, 2], [1, 3], [2, 3], [3, 4], [3, 5]];
  const pt = ([c, r]) => [gx + c * step, gy + r * step];
  const edgeSvg = edges
    .map(([a, b]) => {
      const [x1, y1] = pt(nodes[a]);
      const [x2, y2] = pt(nodes[b]);
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    })
    .join('');
  const nodeSvg = nodes
    .map((n, i) => {
      const [cx, cy] = pt(n);
      return `<circle class="node n${i % 3}" cx="${cx}" cy="${cy}" r="4"/>`;
    })
    .join('');

  const title = xml([profile.name, profile.role, profile.tagline].join(SEP));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}">
  <title>${title}</title>
  <style>
    .name { font: 700 44px ${SANS}; fill: ${t.fg}; letter-spacing: -0.5px; }
    .role { font: 600 ${roleSize}px ${MONO}; fill: ${t.accent}; }
    .tag { font: 400 ${tagSize}px ${MONO}; fill: ${t.fg}; }
    .base { font: 400 12px ${MONO}; fill: ${t.muted}; }
    .cursor { fill: ${t.accent}; animation: blink 1.2s steps(1) infinite; }
    .node { fill: ${t.accent}; animation: pulse 4s ease-in-out infinite; }
    .n1 { animation-delay: 1.3s; }
    .n2 { animation-delay: 2.6s; }
    @keyframes blink { 50% { opacity: 0; } }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
    @media (prefers-reduced-motion: reduce) { .cursor, .node { animation: none; } }
  </style>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="${t.bg}" stroke="${t.border}"/>
  <g fill="${t.dot}">${dots.join('')}</g>
  <g stroke="${t.accent}" stroke-width="1.5" stroke-opacity="0.45">${edgeSvg}</g>
  <g>${nodeSvg}</g>
  <rect x="48" y="44" width="36" height="4" rx="2" fill="${t.accent}"/>
  <text class="name" x="46" y="102">${xml(profile.name)}</text>
  <text class="role" x="48" y="132" textLength="${roleWidth}" lengthAdjust="spacing">${xml(role)}</text>
  <text class="tag" x="${tagX}" y="166" textLength="${tagWidth}" lengthAdjust="spacingAndGlyphs">${xml(profile.tagline)}</text>
  <rect class="cursor" x="${tagX + tagWidth + 5}" y="152" width="9" height="18" rx="1"/>
  <text class="base" x="48" y="194" textLength="${baseWidth}" lengthAdjust="spacingAndGlyphs">${xml(profile.base)}</text>
</svg>
`;
}

// One pill design that reads on both GitHub themes: dark fill with a visible border.
export function badgeSvg(label, { accent = false } = {}) {
  const size = 12;
  const h = 28;
  const textX = 26;
  const textW = monoWidth(label, size);
  const w = Math.ceil(textX + textW + 14);
  const fill = accent ? '#1f6feb' : '#21262d';
  const stroke = accent ? '#388bfd' : '#484f58';
  const dot = accent ? '#ffffff' : '#58a6ff';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${xml(label)}">
  <title>${xml(label)}</title>
  <rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="${(h - 1) / 2}" fill="${fill}" stroke="${stroke}"/>
  <circle cx="15" cy="${h / 2}" r="3.5" fill="${dot}"/>
  <text x="${textX}" y="18" textLength="${textW}" lengthAdjust="spacingAndGlyphs" fill="#f0f6fc" font-family="${MONO.replace(/'/g, '&apos;')}" font-size="${size}" font-weight="600">${xml(label)}</text>
</svg>
`;
}

// ---------------------------------------------------------------- view model

export function buildView(profile, stats, { assetsHref = 'assets/', rootHref = '', note = '', now = new Date() } = {}) {
  const mcpUrl = (profile.mcp?.url ?? '').trim();
  const hasMcp = mcpUrl !== '';
  const links = profile.links;

  const badges = [
    { file: 'badge-github.svg', label: 'GitHub', href: links.github },
    { file: 'badge-linkedin.svg', label: 'LinkedIn', href: links.linkedin },
    { file: 'badge-stackoverflow.svg', label: 'Stack Overflow', href: links.stackoverflow },
  ];
  if (hasMcp) {
    badges.push({
      file: 'badge-mcp.svg',
      label: `MCP${SEP}connect your agent`,
      href: `${rootHref}mcp/README.md`,
      accent: true,
    });
  }

  const gh = stats?.github ?? {};
  const figures = [];
  if (isCount(profile.careerStart)) {
    figures.push(`${plural(now.getUTCFullYear() - profile.careerStart, 'year', 'years')} building software`);
  }
  if (isCount(gh.publicRepos)) figures.push(plural(gh.publicRepos, 'public repo', 'public repos'));
  if (isCount(gh.followers)) figures.push(plural(gh.followers, 'follower', 'followers'));
  if (isCount(gh.stars)) figures.push(plural(gh.stars, 'star', 'stars'));
  if (isCount(gh.contributionsLastYear)) {
    figures.push(`${plural(gh.contributionsLastYear, 'contribution', 'contributions')} in the last year`);
  }

  let mcpStatsLine = '';
  const m = stats?.mcp;
  if (hasMcp && m && isCount(m.mcp_events_total)) {
    const parts = [`MCP usage: ${plural(m.mcp_events_total, 'event', 'events')} in total`];
    if (isCount(m.mcp_events_7d)) parts.push(`${fmt(m.mcp_events_7d)} in the last 7 days`);
    const top = Object.entries(m.tool_calls ?? {})
      .filter(([, n]) => isCount(n) && n > 0)
      .sort((a, b) => b[1] - a[1])[0];
    if (top) parts.push(`most-called tool \`${top[0]}\``);
    mcpStatsLine = parts.join(SEP);
  }

  const contact = [
    `[LinkedIn](${links.linkedin})`,
    `[Stack Overflow](${links.stackoverflow})`,
  ].join(SEP);
  const availability = (profile.availability ?? '').trim();
  const contactLine =
    (availability ? `${availability.replace(/([^.!?])$/, '$1.')} ` : '') +
    contact +
    (hasMcp ? ', or let your agent call `get_resume`.' : '');

  return {
    note,
    assetsHref,
    rootHref,
    links,
    bannerAlt: [profile.name, profile.role, profile.tagline].join(SEP).replace(/"/g, '&quot;'),
    badges,
    bio: profile.bio,
    mcp: hasMcp ? { url: mcpUrl, toolsText: sentenceList(MCP_TOOLS.map((t) => `\`${t}\``)) } : null,
    highlights: profile.highlights,
    projects: profile.projects.map((p) => ({
      name: p.name,
      url: p.url,
      pitch: p.pitch,
      details: p.details,
      factsLine: (p.facts ?? []).slice(0, 3).join(SEP),
      status: p.status,
    })),
    earlierLine: (profile.earlier ?? []).map((e) => `[${e.name}](${e.url}) (${e.pitch})`).join(SEP),
    statsLine: figures.join(SEP),
    mcpStatsLine,
    experience: profile.experience.map(({ period, role, org }) => ({ period, role, org })),
    certificationsLine: (profile.certifications ?? []).join(SEP),
    contactLine,
  };
}

export function renderReadme(template, view) {
  // The output is Markdown, not HTML: no entity escaping.
  const out = Mustache.render(template, view, {}, { escape: (s) => String(s) });
  return `${out.replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

// ---------------------------------------------------------------- build

async function writeIfChanged(file, content) {
  const current = await readFile(file, 'utf8').catch(() => null);
  if (current === content) return false;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return true;
}

export async function build({ profile, stats, template, outFile, assetsDir, viewOptions }) {
  const view = buildView(profile, stats, viewOptions);
  const files = {
    [outFile]: renderReadme(template, view),
    [path.join(assetsDir, 'banner-light.svg')]: bannerSvg(profile, 'light'),
    [path.join(assetsDir, 'banner-dark.svg')]: bannerSvg(profile, 'dark'),
  };
  for (const b of view.badges) {
    files[path.join(assetsDir, b.file)] = badgeSvg(b.label, { accent: b.accent });
  }
  if (!view.mcp) await rm(path.join(assetsDir, 'badge-mcp.svg'), { force: true });

  for (const [file, content] of Object.entries(files)) {
    const changed = await writeIfChanged(file, content);
    console.log(`${changed ? 'wrote    ' : 'unchanged'} ${path.relative(ROOT, file)}`);
  }
}

async function main() {
  const preview = process.argv.includes('--preview');
  const profile = await readJson(path.join(ROOT, 'data/profile.json'));
  const stats = await readJson(path.join(ROOT, 'data/stats.json'), {});
  const template = await readFile(path.join(ROOT, 'templates/README.mustache'), 'utf8');

  if (!preview) {
    await build({
      profile,
      stats,
      template,
      outFile: path.join(ROOT, 'README.md'),
      assetsDir: path.join(ROOT, 'assets'),
    });
    return;
  }

  await build({
    profile: { ...profile, mcp: { ...profile.mcp, url: PREVIEW_MCP_URL } },
    stats: { ...stats, mcp: PREVIEW_MCP_STATS },
    template,
    outFile: path.join(ROOT, 'preview/README.with-mcp.md'),
    assetsDir: path.join(ROOT, 'preview/assets'),
    viewOptions: {
      rootHref: '../',
      note: `Preview only: rendered with the sample MCP URL \`${PREVIEW_MCP_URL}\` and made-up MCP usage numbers. Regenerate with \`npm run preview\`.`,
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
