import { describe, it, expect } from "vitest";
import {
  selectProfile,
  scoreProfile,
  eligible,
  gpuVendorClass,
  DEFAULT_MAX_ENCODED,
  type ProfileIndexEntry,
  type HostFacts,
} from "../src/profilelib.js";

const HOST: HostFacts = {
  os_family: "windows",
  browser_major: 150,
  gpu_vendor: "intel",
  gpu_tier: 0,
  screen_width: 3440,
  screen_height: 1440,
  device_pixel_ratio: 1,
  hardware_concurrency: 16,
  device_memory: 16,
};

function entry(id: string, over: Partial<ProfileIndexEntry> = {}): ProfileIndexEntry {
  return {
    id,
    os_family: "windows",
    browser_major: 150,
    gpu_vendor: "intel",
    gpu_tier: 0,
    screen_width: 1920,
    screen_height: 1080,
    device_pixel_ratio: 1,
    hardware_concurrency: 16,
    device_memory: 16,
    encoded_size: 10000,
    captured_at: new Date().toISOString(),
    ...over,
  };
}

describe("gpuVendorClass", () => {
  it("classifies real ANGLE renderer strings", () => {
    expect(gpuVendorClass("ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 (0x0000220A) Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe("nvidia");
    expect(gpuVendorClass("ANGLE (Intel, Intel(R) UHD Graphics 770 (0xA780) Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe("intel");
    expect(gpuVendorClass("ANGLE (AMD, AMD Radeon RX 6800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe("amd");
    expect(gpuVendorClass("ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)")).toBe("apple");
  });

  it("flags software rasterizers, which can never match a claimed discrete GPU", () => {
    expect(gpuVendorClass("Google SwiftShader")).toBe("software");
    expect(gpuVendorClass("llvmpipe (LLVM 15.0.7, 256 bits)")).toBe("software");
  });

  it("treats a missing renderer as unknown rather than guessing", () => {
    expect(gpuVendorClass(undefined)).toBe("unknown");
    expect(gpuVendorClass("")).toBe("unknown");
  });
});

describe("hard filters", () => {
  it("rejects a mismatched OS", () => {
    expect(eligible(entry("a", { os_family: "linux" }), HOST)).toBe(false);
  });

  it("rejects a mismatched Chromium major even when everything else is perfect", () => {
    // A Chrome-138 capture on a 150 engine reports UA 138 while the engine behaves like 150.
    // No scoring weight should be able to promote that back into the pool.
    const perfectButOld = entry("old", { browser_major: 138, screen_width: 3440, screen_height: 1440 });
    expect(scoreProfile(perfectButOld, HOST)).toBeGreaterThan(0.8);
    expect(eligible(perfectButOld, HOST)).toBe(false);
  });

  it("rejects anything that would blow the argv limit", () => {
    expect(eligible(entry("big", { encoded_size: DEFAULT_MAX_ENCODED + 1 }), HOST)).toBe(false);
    expect(eligible(entry("ok", { encoded_size: DEFAULT_MAX_ENCODED - 1 }), HOST)).toBe(true);
  });

  it("honours an explicit os override", () => {
    expect(eligible(entry("l", { os_family: "linux" }), HOST, { os: "linux" })).toBe(true);
  });
});

describe("scoring", () => {
  it("ranks a matching GPU vendor above a mismatched one", () => {
    const match = entry("m", { gpu_vendor: "intel" });
    const mismatch = entry("x", { gpu_vendor: "nvidia" });
    expect(scoreProfile(match, HOST)).toBeGreaterThan(scoreProfile(mismatch, HOST));
  });

  it("scores a software rasterizer at the bottom — the pixels can never match the claim", () => {
    const sw = entry("sw", { gpu_vendor: "software" });
    const anyReal = entry("real", { gpu_vendor: "nvidia" });
    expect(scoreProfile(sw, HOST)).toBeLessThan(scoreProfile(anyReal, HOST));
  });

  it("penalises a screen LARGER than the host more than a smaller one", () => {
    // Claiming a display the host cannot contain is the documented block trigger; the
    // asymmetry is deliberate, so assert it rather than assuming it.
    const smaller = entry("s", { screen_width: 1920, screen_height: 1080 });
    const larger = entry("l", { screen_width: 5120, screen_height: 2880 });
    expect(scoreProfile(smaller, HOST)).toBeGreaterThan(scoreProfile(larger, HOST));
  });

  it("prefers a fresher capture, all else equal", () => {
    const fresh = entry("f", { captured_at: new Date().toISOString() });
    const stale = entry("s", { captured_at: new Date(Date.now() - 900 * 86_400_000).toISOString() });
    expect(scoreProfile(fresh, HOST)).toBeGreaterThan(scoreProfile(stale, HOST));
  });
});

describe("selection modes", () => {
  const index = Array.from({ length: 40 }, (_, i) =>
    entry(`p${i}`, { screen_width: 1280 + i * 16, hardware_concurrency: 8 + (i % 8) }),
  );

  it("'best' always returns the top-scoring profile", () => {
    const a = selectProfile(index, HOST, { mode: "best" });
    const b = selectProfile(index, HOST, { mode: "best" });
    expect(a.entry.id).toBe(b.entry.id);
    const top = [...index].sort((x, y) => scoreProfile(y, HOST) - scoreProfile(x, HOST))[0];
    expect(a.entry.id).toBe(top.id);
  });

  it("'rotate' is sticky: the same key always resolves to the same profile", () => {
    const runs = Array.from({ length: 5 }, () =>
      selectProfile(index, HOST, { mode: "rotate", key: "account-42" }).entry.id,
    );
    expect(new Set(runs).size).toBe(1);
  });

  it("'rotate' spreads different keys across the pool", () => {
    const ids = new Set(
      Array.from({ length: 60 }, (_, i) =>
        selectProfile(index, HOST, { mode: "rotate", key: `acct-${i}` }).entry.id,
      ),
    );
    // The whole point is not converging on one identity.
    expect(ids.size).toBeGreaterThan(5);
  });

  it("keyless 'rotate' is still stable, not random", () => {
    // An identity whose device changes every launch is a harder tell than a fixed one.
    const runs = Array.from({ length: 5 }, () => selectProfile(index, HOST).entry.id);
    expect(new Set(runs).size).toBe(1);
  });

  it("respects topN as the pool width", () => {
    const ids = new Set(
      Array.from({ length: 60 }, (_, i) =>
        selectProfile(index, HOST, { mode: "rotate", key: `k${i}`, topN: 3 }).entry.id,
      ),
    );
    expect(ids.size).toBeLessThanOrEqual(3);
  });

  it("reports the pool size so an over-narrow index is visible", () => {
    expect(selectProfile(index, HOST).poolSize).toBe(index.length);
  });
});

describe("failure behaviour", () => {
  it("throws rather than returning an incoherent profile", () => {
    // A wrong persona is worse than none: it converts a clean browser into a contradictory one.
    const index = [entry("a", { browser_major: 138 }), entry("b", { os_family: "linux" })];
    expect(() => selectProfile(index, HOST)).toThrow(/no profile matches host/);
  });

  it("names the reason in the error so it is actionable", () => {
    expect(() => selectProfile([], HOST)).toThrow(/chromium major=150/);
  });
});
