// Optional first-run bootstrap for the local profile directory.
//
// WE DOWNLOAD, WE DO NOT REDISTRIBUTE — and here that distinction is legal, not stylistic.
// The chrome-fingerprints dataset is **GPL-3.0**. Clearcote's SDK is BSD-3-Clause, so shipping
// those records inside the package would mean distributing GPL data from a permissively licensed
// artifact. Fetching it onto the user's own machine, from the upstream repository, at the user's
// request, is an entirely different act: no redistribution occurs and the dataset's terms are
// between the user and upstream.
//
// This mirrors what geoip.ts already does for the geoip-all-in-one MaxMind database, which is
// GPL-3.0 for exactly the same reason and is likewise downloaded on first use and never bundled.
//
// WHY IT SHELLS OUT TO PYTHON. The dataset is `fingerprints.json.xz` (LZMA — Node has no built-in
// decompressor) with strings INTERNED as integer indices into a 137 KB `vars.py`. Converting it
// means resolving that interning and remapping ~157 WebGL keys and ~108 audio keys onto the
// clearcote-profile schema. tools/fingerprint-collect/convert_dataset.py already does all of
// that, is tested, and is the file that gets updated when either schema moves. Reimplementing it
// in TypeScript (and again in C#) would be three copies of one mapping table drifting apart, plus
// an LZMA dependency in each. Python is a soft requirement for one optional bootstrap step.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAW_BASE = "https://raw.githubusercontent.com/Vinyzu/chrome-fingerprints/main/chrome_fingerprints";
/** The two files convert_dataset.py's find_dataset() looks for. */
const DATASET_FILES = ["fingerprints.json.xz", "vars.py"] as const;

export interface BootstrapOptions {
  /** How many profiles to convert. The full set is 10,000; a few hundred is ample for rotation. */
  count?: number;
  /** Path to convert_dataset.py. Defaults to the copy in this checkout, if present. */
  converter?: string;
  /** Python executable. */
  python?: string;
  quiet?: boolean;
}

function note(quiet: boolean | undefined, msg: string): void {
  if (!quiet) process.stderr.write(`[clearcote] [profile] ${msg}\n`);
}

/** True when the directory already holds at least one profile — the cheap check that makes this
 *  a no-op on every run after the first. */
export function hasLocalProfiles(dir: string): boolean {
  try {
    return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".json"));
  } catch {
    return false;
  }
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

function run(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr?.on("data", (d) => { stderr += String(d); });
    p.on("error", () => resolve({ code: -1, stderr: `could not run ${cmd}` }));
    p.on("close", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

/**
 * Populate `dir` with converted profiles, if it is empty.
 *
 * Returns true when profiles are present afterwards. Never throws for an ordinary missing
 * prerequisite (no Python, no converter, no network) — the caller is a FALLBACK path, and a
 * bootstrap failure there must degrade to "no local backup", not take down the launch.
 */
export async function ensureLocalProfiles(
  dir: string,
  cacheDir: string,
  opts: BootstrapOptions = {},
): Promise<boolean> {
  if (hasLocalProfiles(dir)) return true;

  const converter = opts.converter ?? defaultConverterPath();
  if (!converter || !existsSync(converter)) {
    note(opts.quiet, "no local profiles and no convert_dataset.py found — skipping bootstrap");
    return false;
  }

  const python = opts.python ?? (process.platform === "win32" ? "python" : "python3");
  const count = opts.count ?? 500;

  try {
    const dataset = join(cacheDir, "chrome-fingerprints");
    mkdirSync(dataset, { recursive: true });
    // Fetch the dataset itself rather than requiring `pip install chrome-fingerprints`: these are
    // the only two files the converter needs, and this keeps the prerequisite to "Python exists".
    const missing = DATASET_FILES.filter((f) => !existsSync(join(dataset, f)));
    if (missing.length) {
      note(opts.quiet,
        `downloading the chrome-fingerprints dataset (GPL-3.0, ~1.3 MB) from its upstream repo — ` +
        `not redistributed by clearcote`);
      for (const f of missing) await download(`${RAW_BASE}/${f}`, join(dataset, f));
    }

    mkdirSync(dir, { recursive: true });
    note(opts.quiet, `converting ${count} profiles into ${dir} (first run only)`);
    const r = await run(python, [converter, "--dataset", dataset, "--out", dir, "--count", String(count)]);
    if (r.code !== 0) {
      note(opts.quiet, `bootstrap failed (${python} exited ${r.code}): ${r.stderr.trim().slice(0, 200)}`);
      return hasLocalProfiles(dir);
    }
    const ok = hasLocalProfiles(dir);
    note(opts.quiet, ok ? `local profile library ready: ${dir}` : "converter produced no profiles");
    return ok;
  } catch (e) {
    note(opts.quiet, `bootstrap skipped: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`);
    return false;
  }
}

/**
 * convert_dataset.py inside this checkout, when the SDK is used from the repo.
 *
 * Returns null rather than throwing for ANY reason. This is called from a fallback path, and the
 * published package has no `tools/` directory at all — an installed-from-npm user simply has no
 * converter, which is a normal state and not an error.
 */
function defaultConverterPath(): string | null {
  try {
    const env = process.env.CLEARCOTE_PROFILE_CONVERTER;
    if (env) return env;
    // `__dirname` does not exist here: this package is `"type": "module"`, so the CJS globals are
    // absent and referencing one throws a ReferenceError at runtime that typechecking cannot see.
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/ (or src/) -> ../../../tools/fingerprint-collect/convert_dataset.py
    const guess = join(here, "..", "..", "..", "tools", "fingerprint-collect", "convert_dataset.py");
    return existsSync(guess) ? guess : null;
  } catch {
    return null;
  }
}
