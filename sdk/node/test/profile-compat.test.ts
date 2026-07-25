// Backwards compatibility with engines that predate imported profiles.
//
// THE BUG THIS GUARDS. The free 149 build ships a 15-patch stack with no persona-profile patch,
// so `--fingerprint-profile` is not merely handled badly — Chromium discards unknown switches
// SILENTLY. A 149 user who asked for a profile would launch with no persona at all while
// believing they had one, which is strictly worse than the seed farbling 149 does support,
// because the failure is invisible.
import { describe, it, expect } from "vitest";
import { engineSupportsProfiles, MIN_PROFILE_ENGINE_MAJOR } from "../src/profileauto.js";
import { defaultStickyKey } from "../src/profilelib.js";

describe("engineSupportsProfiles", () => {
  it("rejects the free 149 engine, which has no persona-profile patch", () => {
    expect(engineSupportsProfiles(149)).toBe(false);
  });

  it("accepts 150, where --fingerprint-profile landed", () => {
    expect(engineSupportsProfiles(150)).toBe(true);
    expect(MIN_PROFILE_ENGINE_MAJOR).toBe(150);
  });

  it("accepts future majors without needing a new release", () => {
    expect(engineSupportsProfiles(151)).toBe(true);
    expect(engineSupportsProfiles(200)).toBe(true);
  });

  it("rejects everything older, not just 149", () => {
    for (const major of [120, 138, 145, 148]) {
      expect(engineSupportsProfiles(major), `major ${major}`).toBe(false);
    }
  });

  it("rejects a non-numeric major rather than assuming support", () => {
    // An unreadable version must degrade to the safe path, not the optimistic one.
    expect(engineSupportsProfiles(Number.NaN)).toBe(false);
    expect(engineSupportsProfiles(undefined as unknown as number)).toBe(false);
  });
});

describe("the 149 fallback identity", () => {
  it("is stable across calls, so a downgraded launch is still a CONSISTENT identity", () => {
    // The fallback seed is defaultStickyKey(). If it varied per launch, a 149 user would get a
    // new device on every visit — a harder tell than a fixed one.
    const a = defaultStickyKey();
    const b = defaultStickyKey();
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("is a plausible seed value for --fingerprint", () => {
    // The engine hashes non-numeric seeds, so any stable string works; it just must not be empty
    // or contain characters that would need quoting on a command line.
    expect(defaultStickyKey()).toMatch(/^[0-9a-f]+$/);
  });
});
