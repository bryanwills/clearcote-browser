/**
 * Live-engine geometry tests. Skipped unless CLEARCOTE_LIVE_ENGINE points at a chrome binary
 * (add CLEARCOTE_LICENSE_KEY for a PRO build). These belong in the release gate.
 *
 * WHY THEY EXIST: the unit tests could not catch the bug that actually shipped here. The window fit
 * read the page with `page.evaluate("() => [...]")`, and Playwright's JS binding evaluates an
 * arrow-function STRING to a function object instead of calling it — so the reader got undefined, the
 * plausibility guard said no, and the fit silently did nothing. The faked page in the unit tests
 * sniffed the string and played along. A real browser is the only thing that catches that class of
 * mismatch, and each SDK's binding has its own quirks.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launchPersistentContext } from "../src/index.js";
import {
  ENGINE_FRAME_HEIGHT,
  ENGINE_FRAME_WIDTH,
  geometryIsCoherent,
  headlessGeometry,
} from "../src/geometry.js";

const LIVE_EXE = process.env.CLEARCOTE_LIVE_ENGINE;

const READ = "[[screen.width, screen.height], [screen.availWidth, screen.availHeight], " +
  "[innerWidth, innerHeight], [outerWidth, outerHeight], [screenX, screenY], [window.__resizes]]";

async function measure(fingerprint?: string, tabs = 1) {
  const dir = mkdtempSync(join(tmpdir(), "cc-live-node-"));
  try {
    const ctx = await launchPersistentContext(dir, {
      executablePath: LIVE_EXE, args: ["--no-sandbox"], quiet: true,
      ...(fingerprint ? { fingerprint } : {}),
    });
    try {
      // Runs before any page script: a window resized after a page starts running JS would show up
      // here as a resize event and a jump in innerWidth.
      await ctx.addInitScript("window.__resizes = 0; addEventListener('resize', () => { window.__resizes++; }, true);");
      const out = [];
      for (let i = 0; i < tabs; i++) {
        const page = await ctx.newPage();
        await page.goto("data:text/html,<body style='margin:0'>geo</body>");
        await page.waitForTimeout(700);   // first paint: innerWidth reads 0 before it
        const m = (await page.evaluate(READ)) as number[][];
        out.push({ screen: m[0], avail: m[1], inner: m[2], outer: m[3], pos: m[4], resizes: m[5][0] });
      }
      return out;
    } finally {
      await ctx.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.runIf(LIVE_EXE)("live engine geometry", () => {
  it("regime 1: the persona owns the screen and the window is maximized into its work area", async () => {
    const [m] = await measure("live-geo-node");
    expect(geometryIsCoherent(m.screen, m.avail, m.inner, m.outer)).toBe(true);
    // screen must not have collapsed onto the viewport — that collapse is the original bug
    expect(m.screen).not.toEqual(m.inner);
    // the persona reserves a taskbar
    expect(m.avail[1]).toBeLessThan(m.screen[1]);
    // this is the assertion that catches a silently no-op fit (the arrow-function-string bug)
    expect(m.outer).toEqual(m.avail);
    // the frame the engine synthesizes stays in the range real captures show
    const dx = m.outer[0] - m.inner[0];
    const dy = m.outer[1] - m.inner[1];
    expect(dx).toBeGreaterThanOrEqual(0);
    expect(dx).toBeLessThanOrEqual(16);
    expect(dy).toBeGreaterThanOrEqual(60);
    expect(dy).toBeLessThanOrEqual(160);
    // and it all happened on about:blank, before the page ran a line of script
    expect(m.resizes).toBe(0);
  }, 120_000);

  it("regime 2: the seedless screen override applies and the engine frame is unchanged", async () => {
    const [m] = await measure();
    const expected = headlessGeometry(undefined);
    expect(m.screen).toEqual([expected.screen.width, expected.screen.height]);
    expect(m.inner).toEqual([expected.viewport.width, expected.viewport.height]);
    expect(geometryIsCoherent(m.screen, m.avail, m.inner, m.outer)).toBe(true);
    // flush with the screen edge, and positioned so it does not hang off that edge
    expect(m.outer).toEqual(m.screen);
    expect(m.pos).toEqual([0, 0]);
    // the constants the regime-2 viewport is sized against must still hold
    expect([m.outer[0] - m.inner[0], m.outer[1] - m.inner[1]])
      .toEqual([ENGINE_FRAME_WIDTH, ENGINE_FRAME_HEIGHT]);
    expect(m.resizes).toBe(0);
  }, 120_000);

  it("a second tab in the same window reports the same geometry", async () => {
    const [first, second] = await measure(undefined, 2);
    expect(second.screen).toEqual(first.screen);
    expect(second.inner).toEqual(first.inner);
    expect(second.outer).toEqual(first.outer);
    expect(second.resizes).toBe(0);
  }, 150_000);
});
