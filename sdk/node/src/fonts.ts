// Linux font wiring.
//
// The Linux release bundles metric-compatible font clones (Segoe UI->Selawik,
// Arial->Arimo, Times New Roman->Tinos, …) under `<binDir>/fonts/`, together with a
// self-contained `fonts.conf.template`. On a bare server/container the Windows families
// (and even the standard fontconfig metric-alias rules) are absent, so a page asking for
// "Segoe UI" collapses to a single default — a detectable render + an absent-font tell.
//
// At launch we materialize the template (substituting the real fonts dir + a writable
// cache dir) and point FONTCONFIG_FILE at it, so the clones resolve without depending on
// the host's /etc/fonts. No-op on non-Linux and on older binaries that ship no `fonts/`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

/** Returns `{ FONTCONFIG_FILE }` on Linux when the font bundle is present, else `{}`. */
export function linuxFontEnv(exePath: string): Record<string, string> {
  if (process.platform !== "linux") return {};
  const fontsDir = join(dirname(exePath), "fonts");
  const template = join(fontsDir, "fonts.conf.template");
  if (!existsSync(template)) return {};
  try {
    const cacheDir = join(tmpdir(), "cc-fc-cache");
    mkdirSync(cacheDir, { recursive: true });
    const conf = readFileSync(template, "utf8")
      .split("@FONTS_DIR@").join(fontsDir)
      .split("@CACHE_DIR@").join(cacheDir);
    const confPath = join(fontsDir, "fonts.generated.conf");
    writeFileSync(confPath, conf);
    return { FONTCONFIG_FILE: confPath };
  } catch {
    return {}; // never block a launch on font wiring
  }
}

type EnvMap = { [key: string]: string | undefined };

/**
 * `{ LANGUAGE: <ui locale> }` on Linux when `args` pin a UI locale with `--lang`, else `{}`.
 *
 * Chrome on Linux takes its UI locale (browser strings such as a form's validationMessage, and
 * before r29 also Intl) from the environment -- LANGUAGE, LC_ALL, LC_MESSAGES, LANG, in GLib's
 * order -- and engines before 153 r29 ignore `--lang` there, so a German persona on a Linux host
 * still spoke English. LANGUAGE is read first and only steers message catalogues, so it fixes that
 * without touching the C library locale (LANG/LC_* would also change number parsing and
 * fontconfig's default language). `de` -> `de`, `en-GB` -> `en_GB`.
 */
export function linuxLocaleEnv(args: readonly string[] | undefined, platform: string = process.platform): Record<string, string> {
  if (platform !== "linux") return {};
  let lang: string | undefined;
  for (const arg of args ?? []) {
    if (typeof arg === "string" && arg.startsWith("--lang=")) lang = arg.slice("--lang=".length).trim(); // last wins, as in Chromium
  }
  return lang ? { LANGUAGE: lang.replace(/-/g, "_") } : {};
}

/**
 * Build the `env` to pass to Playwright's launch so the bundled fonts resolve (and, from `args`,
 * the Linux UI-locale LANGUAGE -- see linuxLocaleEnv).
 * Merges process.env (Playwright replaces the env when `env` is set, so we must include it),
 * the bundled-font FONTCONFIG_FILE + locale, then any caller-supplied `env` (caller wins).
 * Returns `undefined` when there is nothing to add (preserve Playwright's default env).
 */
export function fontLaunchEnv(exePath: string, userEnv?: EnvMap, args?: readonly string[]): EnvMap | undefined {
  const fontEnv = { ...linuxFontEnv(exePath), ...linuxLocaleEnv(args) };
  if (Object.keys(fontEnv).length === 0 && !userEnv) return undefined;
  return { ...process.env, ...fontEnv, ...(userEnv ?? {}) };
}
