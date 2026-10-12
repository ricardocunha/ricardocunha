import type { Json, JsonObject, ProfileData } from "./profile";
import { isObject } from "./profile";
import type { StatsDoc } from "./stats";

const READ_ONLY = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

const NO_INPUT = { type: "object", properties: {}, additionalProperties: false } as const;

export const TOOLS = [
  {
    name: "get_resume",
    title: "Resume",
    description:
      "Ricardo Cunha's resume as JSON: name, role, base, years of experience, bio, highlights, work experience, skills, certifications, education and contact links.",
    inputSchema: NO_INPUT,
    annotations: { title: "Resume", ...READ_ONLY },
  },
  {
    name: "get_projects",
    title: "Projects",
    description:
      "Ricardo Cunha's current projects and earlier open-source work as JSON. Each current project has a `status` field stating what is and is not done yet: quote it as written. Pass `name` to get a single project.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name or title, for example \"keelgw\". Case-insensitive." },
      },
      additionalProperties: false,
    },
    annotations: { title: "Projects", ...READ_ONLY },
  },
  {
    name: "check_availability",
    title: "Availability",
    description:
      "Whether Ricardo Cunha has published an availability status, and how to contact him. This tool does not send any message.",
    inputSchema: NO_INPUT,
    annotations: { title: "Availability", ...READ_ONLY },
  },
  {
    name: "get_stats",
    title: "Stats",
    description: "GitHub figures for the profile, plus usage counters of this MCP server (events, calls per tool, clients).",
    inputSchema: NO_INPUT,
    annotations: { title: "Stats", ...READ_ONLY },
  },
] as const;

export const TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError: boolean;
}

const ok = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  isError: false,
});
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

const list = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);
const obj = (v: Json | undefined): JsonObject => (isObject(v) ? v : {});
const str = (v: Json | undefined): string => (typeof v === "string" ? v : "");

export function yearsOfExperience(profile: JsonObject, now = new Date()): number | null {
  const start = profile.careerStart;
  return typeof start === "number" && Number.isFinite(start) ? Math.max(0, now.getUTCFullYear() - start) : null;
}

export interface ToolDeps {
  data: ProfileData;
  getStats: () => Promise<StatsDoc>;
}

/** Returns undefined for an unknown tool name (a protocol error, not a tool error). */
export async function callTool(name: string, args: JsonObject, deps: ToolDeps): Promise<ToolResult | undefined> {
  const p = deps.data.profile;
  switch (name) {
    case "get_resume":
      return ok({
        name: p.name,
        role: p.role,
        tagline: p.tagline,
        base: p.base,
        yearsOfExperience: yearsOfExperience(p),
        careerStart: p.careerStart,
        bio: p.bio,
        highlights: list(p.highlights),
        experience: list(p.experience),
        skills: obj(p.skills),
        certifications: list(p.certifications),
        education: list(p.education),
        links: obj(p.links),
      });

    case "get_projects": {
      const projects = list(p.projects);
      const earlier = list(p.earlier);
      if (args.name === undefined || args.name === null) return ok({ projects, earlier });
      if (typeof args.name !== "string" || args.name.trim() === "") return fail("`name` must be a non-empty string.");
      const wanted = args.name.trim().toLowerCase();
      const all = [...projects, ...earlier].filter(isObject);
      const hit = all.find((x) => str(x.name).toLowerCase() === wanted || str(x.title).toLowerCase() === wanted);
      if (hit) return ok(hit);
      const names = all.map((x) => str(x.name)).filter(Boolean);
      return fail(`No project named "${args.name.slice(0, 80)}". Available: ${names.join(", ")}.`);
    }

    case "check_availability": {
      const availability = str(p.availability).trim();
      const contact = obj(p.links);
      if (availability) return ok({ availability, contact });
      return ok({
        availability: null,
        message: `No availability status is published for ${str(p.name) || "this profile"}. To ask, use the contact links below.`,
        contact,
      });
    }

    case "get_stats": {
      const github =
        deps.data.github ??
        ({ note: "GitHub figures are not published yet.", profile: obj(p.links).github ?? null } as JsonObject);
      try {
        return ok({ github, mcp: await deps.getStats() });
      } catch {
        return ok({ github, mcp: null, note: "Usage counters are temporarily unavailable." });
      }
    }

    default:
      return undefined;
  }
}
