/**
 * Headless window-geometry tests.
 *
 * A default headless launch used to report a window LARGER than the screen it claims to be on:
 *
 *     screen 1280x720   avail 1280x720   inner 1280x720   outer 1288x851
 *
 * `outer > screen` is not a subtle statistical tell but a state no real browser can be in, readable
 * with two property lookups. These lock down the frame arithmetic, the fact that the default is
 * actually applied at both launch entry points (and never over a caller's own choice), and the
 * regime split — with `--fingerprint` the engine's persona owns screen/avail and the SDK only fits
 * the window; without it the SDK overrides screen itself.
 *
 * PARITY: the vector below is duplicated verbatim in sdk/python/tests/test_geometry.py and
 * sdk/dotnet/tests/GeometryTests.cs. A seed must select the same persona in every SDK or a persona
 * stops being portable between them.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ENGINE_FRAME_HEIGHT,
  ENGINE_FRAME_WIDTH,
  HEADLESS_SCREEN_PROFILES,
  applyHeadlessGeometry,
  callerSizedTheWindow,
  fitPlan,
  fitWindowToPersona,
  geometryIsCoherent,
  headlessGeometry,
  moveWindowToOrigin,
  personaActive,
  profileScreenFromArgs,
} from "../src/geometry.js";
import { gzipSync } from "node:zlib";

describe("frame arithmetic", () => {
  it("leaves every profile row a window that fits its screen", () => {
    for (const [sw, sh] of HEADLESS_SCREEN_PROFILES) {
      const inner = [sw - ENGINE_FRAME_WIDTH, sh - ENGINE_FRAME_HEIGHT];
      const outer = [inner[0] + ENGINE_FRAME_WIDTH, inner[1] + ENGINE_FRAME_HEIGHT];
      // CDP forces avail == screen (measured), so that is what a page will read.
      expect(geometryIsCoherent([sw, sh], [sw, sh], inner, outer)).toBe(true);
    }
  });

  it("derives the viewport from whichever screen the seed selected", () => {
    const table = new Set(HEADLESS_SCREEN_PROFILES.map(([w, h]) => `${w}x${h}`));
    for (let i = 0; i < 200; i++) {
      const g = headlessGeometry(`formula-${i}`);
      expect(table.has(`${g.screen.width}x${g.screen.height}`)).toBe(true);
      expect(g.viewport).toEqual({
        width: g.screen.width - ENGINE_FRAME_WIDTH,
        height: g.screen.height - ENGINE_FRAME_HEIGHT,
      });
    }
  });

  it("rejects the pre-fix default geometry", () => {
    // If the invariant accepted this, it would not have caught anything.
    expect(geometryIsCoherent([1280, 720], [1280, 720], [1280, 720], [1288, 851])).toBe(false);
  });

  it("lands the window flush with the screen edge", () => {
    const g = headlessGeometry("flush");
    expect([g.viewport.width + ENGINE_FRAME_WIDTH, g.viewport.height + ENGINE_FRAME_HEIGHT])
      .toEqual([g.screen.width, g.screen.height]);
  });
});

describe("selection", () => {
  it("is deterministic, and a seedless launch is stable rather than random", () => {
    expect(headlessGeometry("abc")).toEqual(headlessGeometry("abc"));
    expect(headlessGeometry(undefined)).toEqual(headlessGeometry(""));
    expect(headlessGeometry(null)).toEqual(headlessGeometry(undefined));
  });

  it("reaches every row and follows the corpus weighting", () => {
    const seen = new Map<string, number>();
    for (let i = 0; i < 4000; i++) {
      const g = headlessGeometry(`s${i}`);
      const k = `${g.screen.width}x${g.screen.height}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    expect(seen.size).toBe(HEADLESS_SCREEN_PROFILES.length);
    const counts = [...seen.values()];
    expect(seen.get("1920x1080")).toBe(Math.max(...counts));
    // the capped ultrawide must stay rare
    expect((seen.get("3440x1440") ?? 0) / 4000).toBeLessThan(0.08);
  });

  const PARITY: Array<[string | null | undefined, number, number, number, number]> = [
    [null, 1920, 1080, 1912, 949],
    ["", 1920, 1080, 1912, 949],
    ["seed-1", 1920, 1200, 1912, 1069],
    ["acct-42", 1366, 768, 1358, 637],
    ["clearcote", 2560, 1440, 2552, 1309],
    ["x", 2560, 1440, 2552, 1309],
    ["y", 3440, 1440, 3432, 1309],
    ["z", 1920, 1080, 1912, 949],
    ["12345", 1920, 1080, 1912, 949],
  ];

  it.each(PARITY)("cross-SDK parity: seed %p", (seed, sw, sh, vw, vh) => {
    expect(headlessGeometry(seed)).toEqual({
      screen: { width: sw, height: sh },
      viewport: { width: vw, height: vh },
    });
  });
});

describe("regime detection", () => {
  it("reads the persona off the command line, not the caller's options", () => {
    // lightStealth passes a seed to the SDK but deliberately drops --fingerprint, so no persona runs.
    expect(personaActive(["--fingerprint=abc", "--no-sandbox"])).toBe(true);
    expect(personaActive(["--fingerprint-platform=windows", "--fingerprint-screen-width=1920"])).toBe(false);
    expect(personaActive([])).toBe(false);
    expect(personaActive(null)).toBe(false);
  });

  it("detects every caller window flag", () => {
    expect(callerSizedTheWindow(["--window-size=1920,1080"])).toBe(true);
    expect(callerSizedTheWindow(["--window-position=0,0"])).toBe(true);
    expect(callerSizedTheWindow(["--start-maximized"])).toBe(true);
    expect(callerSizedTheWindow(["--no-sandbox", "--fingerprint=x"])).toBe(false);
  });
});

describe("apply / skip rules", () => {
  it("applies screen + viewport with no persona, headless true or unset", () => {
    for (const base of [{ headless: true }, {}]) {
      const opts: Record<string, unknown> = { ...base };
      const applied = applyHeadlessGeometry(opts, "seed", ["--no-sandbox"]);
      expect(applied?.mode).toBe("profile");
      expect(opts.screen).toEqual(headlessGeometry("seed").screen);
      expect(opts.viewport).toEqual(headlessGeometry("seed").viewport);
    }
  });

  it("takes viewport: null and leaves screen to the persona", () => {
    // Setting screen here would be a silent no-op: the persona's value beats the CDP override.
    const opts: Record<string, unknown> = { headless: true };
    expect(applyHeadlessGeometry(opts, "seed", ["--fingerprint=seed"])).toEqual({ mode: "persona" });
    expect(opts.viewport).toBeNull();
    expect("screen" in opts).toBe(false);
  });

  it("is skipped when headed", () => {
    const opts: Record<string, unknown> = { headless: false };
    expect(applyHeadlessGeometry(opts, "seed", ["--fingerprint=seed"])).toBeNull();
    expect(opts).toEqual({ headless: false });
  });

  it.each([
    { viewport: { width: 800, height: 600 } },
    { viewport: null },
    { screen: { width: 1024, height: 768 } },
  ])("never overrides a caller who expressed geometry intent: %p", (explicit) => {
    for (const args of [["--no-sandbox"], ["--fingerprint=seed"]]) {
      const opts: Record<string, unknown> = { headless: true, ...explicit };
      expect(applyHeadlessGeometry(opts, "seed", args)).toBeNull();
      expect(opts).toEqual({ headless: true, ...explicit });
    }
  });
});

describe("the imported profile's screen", () => {
  /** Encode a capture the way fingerprintArgs does (gzip+base64 on --fingerprint-profile). */
  const profileArg = (profile: unknown) =>
    "--fingerprint-profile=" + gzipSync(Buffer.from(JSON.stringify(profile), "utf8")).toString("base64");

  it("reads the screen off the switch", () => {
    expect(profileScreenFromArgs([profileArg({ screen: { width: 3440, height: 1440 } }), "--no-sandbox"]))
      .toEqual([3440, 1440]);
  });

  it("uses the imported display instead of a corpus pick", () => {
    // Otherwise every seedless profile launch shares one screen and the imported identity is lost.
    const opts: Record<string, unknown> = { headless: true };
    const applied = applyHeadlessGeometry(opts, "some-seed", [profileArg({ screen: { width: 2560, height: 1440 } })]);
    expect(applied).toMatchObject({ mode: "profile" });
    expect(opts.screen).toEqual({ width: 2560, height: 1440 });
    expect(opts.viewport).toEqual({
      width: 2560 - ENGINE_FRAME_WIDTH,
      height: 1440 - ENGINE_FRAME_HEIGHT,
    });
  });

  it("falls back when the profile screen is too small to size a viewport against", () => {
    // profile="auto" resolved on a headless host can carry the 800x600 headless surface (measured).
    const arg = profileArg({ screen: { width: 800, height: 600 } });
    expect(profileScreenFromArgs([arg])).toBeNull();
    const opts: Record<string, unknown> = { headless: true };
    applyHeadlessGeometry(opts, "seed", [arg]);
    expect(opts.screen).toEqual(headlessGeometry("seed").screen);
  });

  it.each([
    "--fingerprint-profile=not-base64!!",
    "--fingerprint-profile=",
    "--fingerprint-profile=aGVsbG8=",
  ])("never breaks the launch on an unreadable profile: %s", (arg) => {
    expect(profileScreenFromArgs([arg])).toBeNull();
  });

  it("falls back when the profile has no screen block", () => {
    expect(profileScreenFromArgs([profileArg({ navigator: { platform: "Win32" } })])).toBeNull();
  });

  it("still takes the persona regime when a seed sits beside the profile", () => {
    // With --fingerprint present the ENGINE applies the profile's screen, so the SDK keeps out.
    const opts: Record<string, unknown> = { headless: true };
    const applied = applyHeadlessGeometry(opts, "seed",
      [profileArg({ screen: { width: 2560, height: 1440 } }), "--fingerprint=seed"]);
    expect(applied).toEqual({ mode: "persona" });
    expect(opts.viewport).toBeNull();
  });
});

describe("the persona window fit", () => {
  /** Models the engine: it reports outerHeight `heightBias` px below the bounds height it was given
   *  (33 on 149.0.7827.114). */
  function fakePage(avail: number[], opts: { heightBias?: number; biasFirstCallOnly?: boolean } = {}) {
    const heightBias = opts.heightBias ?? 33;
    let outer = [0, 0];
    let boundsCalls = 0;
    const calls: Array<[string, unknown]> = [];
    const cdp = {
      send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
        calls.push([method, params]);
        if (method === "Browser.getWindowForTarget") return { windowId: 7 };
        if (method === "Browser.setWindowBounds") {
          const b = params!.bounds as { width?: number; height?: number };
          // CDP accepts a partial bounds; a position-only move must not touch the size.
          if (b.width !== undefined && b.height !== undefined) {
            boundsCalls++;
            const biased = !opts.biasFirstCallOnly || boundsCalls === 1;
            outer = [b.width, b.height - (biased ? heightBias : 0)];
          }
        }
        return {};
      }),
    };
    const page = {
      evaluate: async (js: string) => (js.includes("availWidth") ? avail : outer),
      context: () => ({ newCDPSession: async () => cdp }),
    };
    return {
      page: page as never,
      bounds: () => calls.filter(([m]) => m === "Browser.setWindowBounds").map(([, p]) => (p as { bounds: unknown }).bounds),
    };
  }

  it("maximizes into the work area, correcting the reported shortfall", async () => {
    const f = fakePage([1920, 1040]);
    await expect(fitWindowToPersona(f.page, ["--fingerprint=x"])).resolves.toEqual([1920, 1040]);
    expect(f.bounds()).toEqual([
      { left: 0, top: 0, width: 1920, height: 1040 },   // first attempt lands 33 short
      { left: 0, top: 0, width: 1920, height: 1073 },   // + the measured shortfall
    ]);
  });

  it("needs no correction when the engine honours bounds exactly", async () => {
    const f = fakePage([1920, 1040], { heightBias: 0 });
    await expect(fitWindowToPersona(f.page)).resolves.toEqual([1920, 1040]);
    expect(f.bounds()).toHaveLength(1);
  });

  it("reverts rather than overshooting the work area", async () => {
    const f = fakePage([1920, 1040], { biasFirstCallOnly: true });
    await expect(fitWindowToPersona(f.page)).resolves.toEqual([1920, 1040]);
    const b = f.bounds();
    expect(b).toHaveLength(3);
    expect(b[2]).toEqual(b[0]);
  });

  it("defers to a caller-supplied window size", async () => {
    const f = fakePage([1920, 1040]);
    await expect(fitWindowToPersona(f.page, ["--window-size=1024,768"])).resolves.toBeNull();
    expect(f.bounds()).toEqual([]);
  });

  it("declines an implausible work area", async () => {
    // No persona engaged -> the headless default. Maximizing to 800x600 is worse than leaving it.
    const f = fakePage([800, 600]);
    await expect(fitWindowToPersona(f.page)).resolves.toBeNull();
    expect(f.bounds()).toEqual([]);
  });

  it("never throws — a geometry improvement must not fail a launch", async () => {
    const boom = { evaluate: async () => { throw new Error("target closed"); } } as never;
    await expect(fitWindowToPersona(boom)).resolves.toBeNull();
  });

  it("moves the window to the origin with a position-only bounds", async () => {
    // Sending width/height here would fight the emulated viewport, so regime 2 sends left/top only.
    const f = fakePage([1920, 1080]);
    await expect(moveWindowToOrigin(f.page)).resolves.toEqual([0, 0]);
    expect(f.bounds()).toEqual([{ left: 0, top: 0 }]);
  });

  it("defers the origin move to a caller-supplied window position", async () => {
    const f = fakePage([1920, 1080]);
    await expect(moveWindowToOrigin(f.page, ["--window-position=100,100"])).resolves.toBeNull();
    expect(f.bounds()).toEqual([]);
  });

  it("plans no correction when the window already fills the work area", () => {
    expect(fitPlan([1920, 1040], [1920, 1040])).toBeNull();
    expect(fitPlan([1920, 1040], [1920, 1007])).toEqual([1920, 1073]);
    // never asks for more than the shortfall
    expect(fitPlan([1920, 1040], [1900, 1040])).toEqual([1940, 1040]);
  });
});
