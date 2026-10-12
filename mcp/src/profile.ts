import bundledJson from "../../data/profile.json";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface ProfileData {
  profile: JsonObject;
  /** data/stats.json passed through as-is, or null when it does not exist. */
  github: JsonObject | null;
  source: "live" | "bundled";
}

const RAW_BASE = "https://raw.githubusercontent.com/ricardocunha/ricardocunha/main/data/";
const FRESH_MS = 5 * 60_000;
const RETRY_MS = 60_000; // after a failed fetch, do not hammer GitHub
const FETCH_TIMEOUT_MS = 2500;
const MAX_BYTES = 256 * 1024;

const PHONE_KEY = /phone|whats?app|telefone|celular|^(tel|cell|mobile)(_?number)?$/i;
const PHONE_VALUE = /^tel:|wa\.me\/|api\.whatsapp\.com/i;

/** Drops anything that looks like a phone field, wherever it sits in the document. */
export function scrub(value: Json): Json {
  if (Array.isArray(value)) {
    return value.filter((v) => !(typeof v === "string" && PHONE_VALUE.test(v))).map(scrub);
  }
  if (value && typeof value === "object") {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) {
      if (PHONE_KEY.test(k)) continue;
      if (typeof v === "string" && PHONE_VALUE.test(v)) continue;
      out[k] = scrub(v);
    }
    return out;
  }
  return value;
}

export const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

function isProfile(v: unknown): v is JsonObject {
  return isObject(v) && typeof v.name === "string" && v.name.length > 0 && Array.isArray(v.projects);
}

export const bundledProfile = scrub(bundledJson as Json) as JsonObject;

async function fetchJson(file: string): Promise<unknown> {
  const res = await fetch(RAW_BASE + file, {
    headers: { accept: "application/json", "user-agent": "ricardocunha-profile-mcp" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error(`${file}: too large`);
  return JSON.parse(text);
}

let cached: { data: ProfileData; until: number } | undefined;
let inflight: Promise<ProfileData> | undefined;

export function resetProfileCache(): void {
  cached = undefined;
  inflight = undefined;
}

async function refresh(): Promise<ProfileData> {
  const [p, s] = await Promise.allSettled([fetchJson("profile.json"), fetchJson("stats.json")]);
  const live = p.status === "fulfilled" && isProfile(p.value);
  const data: ProfileData = {
    profile: live ? (scrub(p.value as Json) as JsonObject) : bundledProfile,
    github: s.status === "fulfilled" && isObject(s.value) ? (scrub(s.value) as JsonObject) : null,
    source: live ? "live" : "bundled",
  };
  cached = { data, until: Date.now() + (live ? FRESH_MS : RETRY_MS) };
  return data;
}

/** Live profile from GitHub when it is reachable and valid, else the copy bundled at build time. */
export async function loadProfile(): Promise<ProfileData> {
  if (cached && Date.now() < cached.until) return cached.data;
  inflight ??= refresh()
    .catch((): ProfileData => ({ profile: bundledProfile, github: null, source: "bundled" }))
    .finally(() => {
      inflight = undefined;
    });
  return inflight;
}
