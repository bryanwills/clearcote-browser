/**
 * Headless window geometry. Port of the Python SDK's `_geometry.py`; the profile table, the seed
 * hashing and the skip rules are identical, so a seed selects the same persona in every SDK.
 *
 * Headed launches take their geometry from the real display and the SDK keeps the page on it
 * (`viewport: null`), so screen/avail/inner/outer agree by construction. Headless has no display,
 * and what it reports depends on whether the engine's persona machinery is running. Both regimes
 * were measured on 149.0.7827.114/linux-x64.
 *
 * REGIME 1 — a persona is active (`--fingerprint=<seed>` on the command line). The engine spoofs
 * screen AND avail from the seed, including a taskbar (seed A -> 1920x1080 / avail 1920x1040, seed B
 * -> 2560x1440 / 1400, seed C -> 1600x900 / 860), and its values BEAT a CDP screen override — so the
 * SDK must not try to set screen here, it would silently lose. Leaving Playwright's emulated viewport
 * on is just as wrong: inner 1280x720 inside an outer of 1920x1040 leaves 640px of window
 * unaccounted for by any frame a real browser has. So `viewport: null` plus one window resize into
 * the persona's own work area, which lands a maximized window:
 *
 *     screen 1920x1080   avail 1920x1040   inner 1920x952   outer 1920x1040   frame (0, 88)
 *
 * REGIME 2 — no persona (the default seedless launch, and `lightStealth`, which drops
 * `--fingerprint` deliberately). Nothing spoofs screen, so Chromium reports screen == the emulated
 * viewport and then synthesizes a frame on top of it:
 *
 *     screen 1280x720   avail 1280x720   inner 1280x720   outer 1288x851   <- outer > screen
 *
 * A window larger than its own screen is an impossible state, readable in two property lookups, and
 * it was present on every headless shape reachable through the SDK. The lever here is CDP
 * `Emulation.setDeviceMetricsOverride` via Playwright's context `screen` option — the only thing that
 * moves screen.* in headless (the engine's own `--fingerprint-screen-*` switches are inert without a
 * persona: verified through the SDK options and passed raw, headless and headed). So pick a screen
 * size real machines have and size the viewport so the frame lands exactly on the screen edge.
 *
 * CDP LIMIT: the override sets availWidth/availHeight equal to screen.*, so regime 2 always reports
 * no taskbar. Not invented — 78 of 432 real desktop captures (23 of 79 networks) report avail ==
 * screen too. It is a minority shape and the only one available here; regime 1 is the more faithful
 * of the two, so prefer a seeded launch when it is an option.
 *
 * PROVENANCE of the regime-2 table: the `audit_profiles` corpus (real captures from the public
 * fingerprint audit), desktop rows whose geometry is self-consistent and which are not themselves
 * emulated-viewport captures, counted by distinct /24 so one busy machine cannot skew it. macOS rows
 * are dropped (color_depth 30, which this engine cannot spoof), non-1.0 DPR rows are dropped
 * (scaling changes what the rasterizer produces), and ultrawide 3440x1440 is capped to weight 2
 * (12 distinct /24s in the corpus — developers over-represent ultrawides).
 */
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { BrowserContext, Page } from "playwright-core";

/**
 * Regime-2 engine window-frame delta: outer = inner + (WIDTH, HEIGHT).
 *
 * Measured with no persona on 149.0.7827.114/linux-x64, re-confirmed on the 150 build a default
 * launch resolves (same 8/131), and constant across every viewport probed
 * (1280x720 -> 1288x851, 1920x947 -> 1928x1078, 2552x1269 -> 2560x1400). The regime-2 viewport is
 * sized against these, so an engine that changed them would put headless windows back outside their
 * screen — test/geometry.test.ts measures the running engine and fails on drift.
 */
export const ENGINE_FRAME_WIDTH = 8;
export const ENGINE_FRAME_HEIGHT = 131;

/** `[screenWidth, screenHeight, weight, osHint]` — weight is distinct /24s in the corpus. */
export const HEADLESS_SCREEN_PROFILES: ReadonlyArray<readonly [number, number, number, string]> = [
  [1920, 1080, 24, "windows"],
  [2560, 1440, 13, "windows"],
  [1920, 1200, 6, "linux"],
  [1366, 768, 3, "windows"],
  [1600, 900, 3, "linux"],
  [3440, 1440, 2, "windows"],   // capped from 12 (see the module comment)
  [3840, 2160, 2, "windows"],
  [1680, 1050, 2, "windows"],
];

/** Window flags that mean the caller sized the window themselves. */
const CALLER_WINDOW_FLAGS = ["--window-size", "--window-position", "--start-maximized"];

export interface Size { width: number; height: number }
export interface HeadlessGeometry { screen: Size; viewport: Size }

/**
 * Whether `--fingerprint=<seed>` is on the command line, i.e. the engine spoofs screen/avail itself
 * (regime 1). `lightStealth` drops that switch on purpose, so this is false for it even though a
 * seed was passed to the SDK.
 */
export function personaActive(args?: readonly string[] | null): boolean {
  return (args ?? []).some((a) => String(a).startsWith("--fingerprint="));
}

/** True when the caller passed their own window geometry flag. */
export function callerSizedTheWindow(args?: readonly string[] | null): boolean {
  return (args ?? []).some((a) => CALLER_WINDOW_FLAGS.includes(String(a).split("=")[0]));
}

/**
 * Weighted, deterministic choice from {@link HEADLESS_SCREEN_PROFILES}. Same construction as
 * `lightStealthValues`: the full sha256 digest as a big integer, so Python, Node and .NET select the
 * identical row for a seed. An unset seed maps to a fixed key rather than randomness, so a seedless
 * launch stays reproducible.
 */
function pick(seed?: string | number | null): readonly [number, number, number, string] {
  const key = seed === undefined || seed === null || seed === "" ? "clearcote-headless-geometry" : String(seed);
  const digest = createHash("sha256").update(key, "utf8").digest("hex");
  const total = HEADLESS_SCREEN_PROFILES.reduce((n, row) => n + row[2], 0);
  let point = Number(BigInt("0x" + digest) % BigInt(total));
  for (const row of HEADLESS_SCREEN_PROFILES) {
    point -= row[2];
    if (point < 0) return row;
  }
  return HEADLESS_SCREEN_PROFILES[HEADLESS_SCREEN_PROFILES.length - 1];
}

/** Context geometry for a given screen: viewport = screen minus the engine's frame. */
function geometryFor(width: number, height: number): HeadlessGeometry {
  return {
    screen: { width, height },
    viewport: { width: width - ENGINE_FRAME_WIDTH, height: height - ENGINE_FRAME_HEIGHT },
  };
}

const PROFILE_FLAG = "--fingerprint-profile=";

/**
 * The imported profile's own screen, or null.
 *
 * Measured: `--fingerprint-profile` supplies screen/avail only when a persona (`--fingerprint=`) is
 * ALSO running. Without a seed the profile's display is inert, so the SDK's override is all the page
 * sees — and taking it from the profile keeps the imported identity instead of giving every seedless
 * profile launch the same corpus screen.
 *
 * Reads the value off the switch (gzip+base64 of the capture JSON), which is the one form every SDK
 * has in hand here whatever the caller passed. Best-effort: a profile the engine can still use must
 * never fail a launch because this could not read a screen out of it, so failures return null. A
 * screen too small to hold the engine's frame is rejected for the same reason the corpus table has no
 * tiny rows — the leftover viewport would not lay out a desktop site. (That guard is what keeps an
 * `profile="auto"` capture made on a headless host, whose screen can be the 800x600 surface, from
 * becoming the persona's display.)
 */
export function profileScreenFromArgs(args?: readonly string[] | null): [number, number] | null {
  for (const raw of args ?? []) {
    const arg = String(raw);
    if (!arg.startsWith(PROFILE_FLAG)) continue;
    try {
      const json = gunzipSync(Buffer.from(arg.slice(PROFILE_FLAG.length), "base64")).toString("utf8");
      const screen = (JSON.parse(json) || {}).screen || {};
      const width = Number(screen.width);
      const height = Number(screen.height);
      if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
      if (width - ENGINE_FRAME_WIDTH < 1024 || height - ENGINE_FRAME_HEIGHT < 600) return null;
      return [width, height];
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Regime-2 context geometry. The viewport is the screen minus the engine's frame, so the synthesized
 * outerWidth/Height lands exactly on the screen edge (a maximized window) instead of past it.
 */
export function headlessGeometry(seed?: string | number | null): HeadlessGeometry {
  const [sw, sh] = pick(seed);
  return geometryFor(sw, sh);
}

export type AppliedGeometry =
  | { mode: "persona" }
  | ({ mode: "profile" } & HeadlessGeometry);

/**
 * Default a headless launch's context geometry in place; returns what was applied, or null.
 *
 * `{mode: "persona"}` means regime 1: `viewport: null` was set and the window still needs fitting to
 * the persona's work area (see {@link fitWindowToPersona}). `{mode: "profile", ...}` means regime 2:
 * screen + viewport were set and nothing else is needed.
 *
 * Skipped when headed (the real window is already coherent) and when the caller expressed ANY
 * geometry intent — `viewport` (including an explicit null) or `screen`. `headless` unset means
 * headless, matching Playwright.
 */
export function applyHeadlessGeometry(
  opts: Record<string, unknown>,
  seed?: string | number | null,
  args?: readonly string[] | null,
): AppliedGeometry | null {
  if (opts.headless === false) return null;
  if ("viewport" in opts || "screen" in opts) return null;
  if (personaActive(args)) {
    opts.viewport = null;
    return { mode: "persona" };
  }
  // An imported profile carries its own display; prefer it over a corpus pick.
  const fromProfile = profileScreenFromArgs(args);
  const geom = fromProfile ? geometryFor(fromProfile[0], fromProfile[1]) : headlessGeometry(seed);
  opts.screen = geom.screen;
  opts.viewport = geom.viewport;
  return { mode: "profile", ...geom };
}

// A plain expression, NOT "() => [...]": Playwright evaluates an arrow-function string to a
// function object rather than calling it (which silently broke this fit once).
const WORKAREA_JS = "[screen.availWidth, screen.availHeight]";
const OUTER_JS = "[outerWidth, outerHeight]";

/** A work area only a non-engaged persona would report (the headless default) is not worth fitting to. */
function plausible(area: number[] | null | undefined): boolean {
  return !!area && area.length === 2 && area[0] >= 1024 && area[1] >= 600;
}

function bounds(width: number, height: number) {
  return { left: 0, top: 0, width: Math.round(width), height: Math.round(height) };
}

/**
 * The bounds correction, given what the window reported after the first attempt.
 *
 * Requested bounds and reported outerHeight are not the same quantity: on 149 the window reports
 * 33px less than the bounds height it was given, so fitting bounds to the work area lands 33px short
 * of maximized (real maximized captures have outer == avail). Rather than hardcode 33, measure the
 * shortfall and add it back — that self-tunes if the engine changes. Never asks for more than the
 * shortfall, so the window cannot be pushed past the work area.
 */
export function fitPlan(avail: number[], outer: number[]): [number, number] | null {
  const dw = avail[0] - outer[0];
  const dh = avail[1] - outer[1];
  if (dw <= 0 && dh <= 0) return null;
  return [avail[0] + Math.max(dw, 0), avail[1] + Math.max(dh, 0)];
}

/**
 * Regime 1: size the headless window to the persona's own work area, so the page reports a maximized
 * window (outer == avail) instead of the 800x600 headless default sitting inside a spoofed
 * 1920x1080 screen.
 *
 * `--start-maximized` and CDP `windowState: "maximized"` are both no-ops in headless (measured — the
 * window stays at its default size), which is why this sets explicit bounds.
 *
 * Never throws: a geometry improvement must not be able to fail a launch.
 */
export async function fitWindowToPersona(
  page: Page,
  args?: readonly string[] | null,
): Promise<[number, number] | null> {
  if (callerSizedTheWindow(args)) return null;
  try {
    const avail = (await page.evaluate(WORKAREA_JS)) as number[];
    if (!plausible(avail)) return null;
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: bounds(avail[0], avail[1]) });
    let outer = (await page.evaluate(OUTER_JS)) as number[];
    const plan = fitPlan(avail, outer);
    if (plan) {
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: bounds(plan[0], plan[1]) });
      outer = (await page.evaluate(OUTER_JS)) as number[];
      // Overshooting would trade one impossible geometry for another (outer > avail).
      if (outer[0] > avail[0] || outer[1] > avail[1]) {
        await cdp.send("Browser.setWindowBounds", { windowId, bounds: bounds(avail[0], avail[1]) });
        outer = (await page.evaluate(OUTER_JS)) as number[];
      }
    }
    return [outer[0], outer[1]];
  } catch {
    return null;   // deliberately silent: never fail a launch over geometry
  }
}

/**
 * Regime 2: move the real window to (0, 0).
 *
 * Regime 2 leaves the real window at the headless default position — measured (10, 10) — while the
 * emulated viewport makes outerWidth/Height span the whole spoofed screen. `screenX + outerWidth`
 * then exceeds `screen.width`: the window hangs 10px past the screen edge on both axes. Only 6% of
 * real single-display captures do that, so it is a weak but free tell. The move costs one CDP call
 * and leaves the emulated viewport untouched (verified: inner/outer unchanged, screenX/Y become 0).
 *
 * Never throws.
 */
export async function moveWindowToOrigin(
  page: Page,
  args?: readonly string[] | null,
): Promise<[number, number] | null> {
  if (callerSizedTheWindow(args)) return null;
  try {
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };
    // left/top only — sending width/height here would fight the emulated viewport.
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { left: 0, top: 0 } });
    return [0, 0];
  } catch {
    return null;
  }
}

/**
 * Apply the headless window fixup once, on the first page: fit to the persona's work area (persona
 * regime) or move to the origin (profile regime). A persistent context already owns a page, so act
 * immediately; a browser-level context does not, so defer to its first `newPage`.
 */
export async function installWindowFixup(
  context: BrowserContext,
  args?: readonly string[] | null,
  persona = true,
): Promise<void> {
  let done = false;
  const fix = async (page: Page) => {
    if (done) return page;
    done = true;
    if (persona) await fitWindowToPersona(page, args);
    else await moveWindowToOrigin(page, args);
    return page;
  };
  const existing = context.pages();
  if (existing.length) {
    await fix(existing[0]);
    return;
  }
  const origNewPage = context.newPage.bind(context);
  (context as unknown as { newPage: () => Promise<Page> }).newPage = async () => fix(await origNewPage());
}

/** `inner <= outer <= avail <= screen` on both axes — the chain a real window satisfies. */
export function geometryIsCoherent(
  screen: number[], avail: number[], inner: number[], outer: number[],
): boolean {
  return inner[0] <= outer[0] && inner[1] <= outer[1]
    && outer[0] <= avail[0] && outer[1] <= avail[1]
    && avail[0] <= screen[0] && avail[1] <= screen[1];
}
