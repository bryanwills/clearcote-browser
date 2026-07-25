// Generic profile importer: turn a DIRECTORY of clearcote-profile JSON into a selectable index.
//
// WE ARE AN IMPORTER, NOT A HOST. Clearcote ships no third-party fingerprints and redistributes
// none. A source is just a folder of clearcote-profile JSON on the user's own machine, however
// it got there:
//
//   * the open chrome-fingerprints dataset (Vinyzu), converted locally with
//     tools/fingerprint-collect/convert_dataset.py — the dataset is fetched by the USER from the
//     original repository, so nothing is re-published here and its terms are unaffected;
//   * your own captures from tools/fingerprint-collect (collect.html / snippet.js);
//   * the licensed clearcote profile service (see profilesource.ts);
//   * any other producer that emits the same schema.
//
// Keeping the format as the ONLY contract is what makes this generic. There is no adapter per
// vendor, no vendored data, and no decompressor for someone else's archive format baked into
// three SDKs — a directory of JSON is something every source can produce and every SDK can read.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { gpuVendorClass, type ProfileIndexEntry } from "./profilelib.js";

/** Parse a clearcote-profile blob into an index entry. Returns null when the file is not one. */
export function indexEntryFromProfile(
  id: string,
  profile: Record<string, unknown>,
): ProfileIndexEntry | null {
  const nav = (profile.navigator ?? {}) as Record<string, unknown>;
  const screen = (profile.screen ?? {}) as Record<string, number>;
  const webgl = (profile.webgl ?? {}) as Record<string, unknown>;
  const gl1 = (webgl.webgl1 ?? {}) as Record<string, unknown>;
  const debug = (gl1.debug ?? {}) as Record<string, string>;
  const meta = (profile.meta ?? {}) as Record<string, unknown>;

  const ua = String(nav.user_agent ?? "");
  const platform = String(nav.platform ?? "");

  // OS family from navigator.platform first (stable across UA reduction), UA as a fallback.
  let os: string;
  if (/win/i.test(platform) || /Windows/i.test(ua)) os = "windows";
  else if (/mac/i.test(platform) || /Mac OS X/i.test(ua)) os = "macos";
  else if (/linux|x11/i.test(platform) || /Linux/i.test(ua)) os = "linux";
  else if (/android/i.test(ua)) os = "android";
  else return null; // unclassifiable: better to skip than to mislabel and mis-serve it

  // Version is OPTIONAL by design. Hardware-only imports (e.g. converted chrome-fingerprints
  // records) carry no browser version and inherit the engine's — see profilelib's browser_major.
  const m = ua.match(/Chrome\/(\d+)/);
  const browserMajor = m ? Number(m[1]) : null;

  const renderer = debug.UNMASKED_RENDERER_WEBGL ?? null;

  // The launch cost, measured the same way fingerprint.ts encodes it — so an entry that would
  // blow the argv limit is excluded at selection time rather than failing at spawn.
  const encodedSize = gzipSync(Buffer.from(JSON.stringify(profile)), { level: 9 }).toString("base64").length;

  return {
    id,
    os_family: os,
    browser_major: browserMajor,
    gpu_vendor: gpuVendorClass(renderer),
    renderer: renderer ?? undefined,
    screen_width: screen.width,
    screen_height: screen.height,
    device_pixel_ratio: screen.device_pixel_ratio,
    hardware_concurrency: profile.hardware_concurrency as number | undefined,
    device_memory: profile.device_memory as number | undefined,
    encoded_size: encodedSize,
    captured_at: typeof meta.captured_at === "string" ? meta.captured_at : undefined,
  };
}

export interface ImportResult {
  index: ProfileIndexEntry[];
  /** Files that were not usable, with the reason — surfaced rather than silently dropped, so a
   *  half-converted directory is visible instead of quietly producing a thin pool. */
  skipped: { file: string; reason: string }[];
}

/**
 * Index every `*.json` in a directory.
 *
 * Reads each file once. For 10k profiles this is a few seconds and a lot of I/O, so callers
 * should cache the result (`writeIndex`) rather than re-scanning per launch.
 */
export function importDirectory(dir: string): ImportResult {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`profile source is not a directory: ${dir}`);
  }
  const index: ProfileIndexEntry[] = [];
  const skipped: { file: string; reason: string }[] = [];

  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const path = join(dir, f);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch (e) {
      skipped.push({ file: f, reason: `unreadable JSON: ${String(e).slice(0, 80)}` });
      continue;
    }
    // A clearcote-profile always has navigator; without it this is some other kind of file.
    if (!parsed || typeof parsed !== "object" || !parsed.navigator) {
      skipped.push({ file: f, reason: "not a clearcote-profile (no navigator)" });
      continue;
    }
    const entry = indexEntryFromProfile(f.replace(/\.json$/, ""), parsed);
    if (!entry) {
      skipped.push({ file: f, reason: "could not classify os_family" });
      continue;
    }
    index.push(entry);
  }
  return { index, skipped };
}

/** Load one profile from an imported directory, by the id `importDirectory` assigned it. */
export function loadImportedProfile(dir: string, id: string): Record<string, unknown> {
  // The id is a filename stem this module produced, but it can reach here from a cached index,
  // so treat it as untrusted: reject anything that could escape the source directory.
  if (id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error(`invalid profile id '${id}'`);
  }
  const path = join(dir, `${id}.json`);
  if (!existsSync(path)) throw new Error(`profile '${id}' not found in ${dir}`);
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}
