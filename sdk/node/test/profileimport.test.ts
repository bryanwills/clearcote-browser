import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importDirectory, loadImportedProfile, indexEntryFromProfile } from "../src/profileimport.js";
import { eligible, selectProfile, type HostFacts } from "../src/profilelib.js";

let dir: string;

function profile(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meta: { captured_at: "2026-07-01T00:00:00.000Z", schema_version: 1 },
    navigator: {
      user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
      platform: "Win32",
    },
    screen: { width: 1920, height: 1080, device_pixel_ratio: 1 },
    webgl: {
      webgl1: {
        debug: {
          UNMASKED_RENDERER_WEBGL: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 (0x0000220A) Direct3D11 vs_5_0 ps_5_0, D3D11)",
        },
      },
    },
    hardware_concurrency: 16,
    device_memory: 16,
    ...over,
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cc-import-"));
  writeFileSync(join(dir, "win-nvidia.json"), JSON.stringify(profile()));
  writeFileSync(join(dir, "mac.json"), JSON.stringify(profile({
    navigator: {
      user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
      platform: "MacIntel",
    },
  })));
  // A converted chrome-fingerprints record: hardware identity, deliberately NO Chrome version.
  writeFileSync(join(dir, "hardware-only.json"), JSON.stringify(profile({
    navigator: { user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", platform: "Win32" },
  })));
  writeFileSync(join(dir, "broken.json"), "{ not json");
  writeFileSync(join(dir, "not-a-profile.json"), JSON.stringify({ hello: "world" }));
  writeFileSync(join(dir, "ignored.txt"), "not json at all");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("importDirectory", () => {
  it("indexes every valid profile and reports the rest", () => {
    const { index, skipped } = importDirectory(dir);
    expect(index.map((e) => e.id).sort()).toEqual(["hardware-only", "mac", "win-nvidia"]);
    // A half-converted directory must be visible, not silently thin.
    expect(skipped.map((s) => s.file).sort()).toEqual(["broken.json", "not-a-profile.json"]);
    expect(skipped.find((s) => s.file === "broken.json")!.reason).toMatch(/unreadable JSON/);
    expect(skipped.find((s) => s.file === "not-a-profile.json")!.reason).toMatch(/no navigator/);
  });

  it("derives os_family, gpu class and geometry from the blob", () => {
    const e = importDirectory(dir).index.find((x) => x.id === "win-nvidia")!;
    expect(e.os_family).toBe("windows");
    expect(e.gpu_vendor).toBe("nvidia");
    expect(e.browser_major).toBe(150);
    expect(e.screen_width).toBe(1920);
    expect(e.hardware_concurrency).toBe(16);
  });

  it("classifies macOS from navigator.platform", () => {
    expect(importDirectory(dir).index.find((x) => x.id === "mac")!.os_family).toBe("macos");
  });

  it("measures the ENCODED size, so an oversized profile is caught before spawn", () => {
    const e = importDirectory(dir).index.find((x) => x.id === "win-nvidia")!;
    // gzip+base64 of a small profile — must be a real number, well under the argv budget.
    expect(e.encoded_size).toBeGreaterThan(0);
    expect(e.encoded_size).toBeLessThan(24000);
  });

  it("throws a clear error when the source is not a directory", () => {
    expect(() => importDirectory(join(dir, "win-nvidia.json"))).toThrow(/not a directory/);
  });
});

describe("version-agnostic (hardware-only) profiles", () => {
  const host: HostFacts = {
    os_family: "windows", browser_major: 150, gpu_vendor: "nvidia",
    screen_width: 3440, screen_height: 1440, device_pixel_ratio: 1,
    hardware_concurrency: 16, device_memory: 16,
  };

  it("records no browser_major when the UA carries no Chrome version", () => {
    const e = importDirectory(dir).index.find((x) => x.id === "hardware-only")!;
    expect(e.browser_major).toBeNull();
  });

  it("are ELIGIBLE on any engine — they inherit its version and cannot contradict it", () => {
    // This is the chrome-fingerprints case: records are Chrome ~114/115, the engine is 150, and
    // the converter drops the version precisely so there is nothing to disagree with.
    const e = importDirectory(dir).index.find((x) => x.id === "hardware-only")!;
    expect(eligible(e, host)).toBe(true);
    expect(eligible(e, { ...host, browser_major: 138 })).toBe(true);
  });

  it("a profile that PINS the wrong version is still rejected", () => {
    const e = indexEntryFromProfile("old", {
      navigator: { user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/138.0.0.0", platform: "Win32" },
      screen: { width: 1920, height: 1080 },
    })!;
    expect(e.browser_major).toBe(138);
    expect(eligible(e, host)).toBe(false);
  });
});

describe("end to end", () => {
  it("an imported directory feeds selection directly", () => {
    const { index } = importDirectory(dir);
    const sel = selectProfile(index, {
      os_family: "windows", browser_major: 150, gpu_vendor: "nvidia",
      screen_width: 3440, screen_height: 1440, device_pixel_ratio: 1,
      hardware_concurrency: 16, device_memory: 16,
    }, { mode: "best" });
    expect(["win-nvidia", "hardware-only"]).toContain(sel.entry.id);
    const loaded = loadImportedProfile(dir, sel.entry.id);
    expect(loaded).toHaveProperty("navigator");
  });

  it("refuses ids that could escape the source directory", () => {
    expect(() => loadImportedProfile(dir, "../../etc/passwd")).toThrow(/invalid profile id/);
    expect(() => loadImportedProfile(dir, "sub/other")).toThrow(/invalid profile id/);
  });

  it("reports a missing id clearly", () => {
    expect(() => loadImportedProfile(dir, "nope")).toThrow(/not found/);
  });
});

describe("converted chrome-fingerprints records", () => {
  // REGRESSION. The converter deliberately leaves `user_agent` and `platform` null (it drops the
  // browser version so the persona inherits the engine's) and carries the platform in `uadata`
  // instead. An importer that reads only the UA string skips every one of those records — 25/25
  // in the first end-to-end run — and the failure looks like "the dataset is broken".
  const converted = {
    meta: { schema_version: 1, source: "chrome-fingerprints", captured_at: null, chrome_version: null },
    navigator: {
      user_agent: null,
      platform: null,
      uadata: {
        platform: "Windows",
        mobile: false,
        high_entropy: { platform: "Windows", platformVersion: "15.0.0", architecture: "x86", bitness: "64" },
      },
    },
    screen: { width: 1536, height: 864, device_pixel_ratio: 1.25 },
    webgl: { webgl1: { debug: { UNMASKED_RENDERER_WEBGL: "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)" } } },
    hardware_concurrency: 12,
    device_memory: 8,
  };

  it("classifies the OS from uadata when the UA string is null", () => {
    const e = indexEntryFromProfile("conv", converted)!;
    expect(e).not.toBeNull();
    expect(e.os_family).toBe("windows");
    expect(e.gpu_vendor).toBe("intel");
    expect(e.screen_width).toBe(1536);
  });

  it("records no browser_major, so the record stays engine-agnostic", () => {
    expect(indexEntryFromProfile("conv", converted)!.browser_major).toBeNull();
  });

  it("classifies macOS and Android from uadata too", () => {
    const mac = { ...converted, navigator: { user_agent: null, platform: null, uadata: { platform: "macOS", mobile: false } } };
    expect(indexEntryFromProfile("m", mac)!.os_family).toBe("macos");
    const android = { ...converted, navigator: { user_agent: null, platform: null, uadata: { platform: "Android", mobile: true } } };
    expect(indexEntryFromProfile("a", android)!.os_family).toBe("android");
  });

  it("treats uadata.mobile as android even when the platform string is odd", () => {
    const m = { ...converted, navigator: { user_agent: null, platform: null, uadata: { platform: "", mobile: true } } };
    expect(indexEntryFromProfile("x", m)!.os_family).toBe("android");
  });

  it("still skips a record with no usable platform signal at all", () => {
    const blank = { ...converted, navigator: { user_agent: null, platform: null, uadata: {} } };
    expect(indexEntryFromProfile("blank", blank)).toBeNull();
  });
});
