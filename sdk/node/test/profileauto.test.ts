// Fallback behaviour for `profile: "auto"`: service first, local directory as backup.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostFacts } from "../src/profilelib.js";

let root: string;
root = mkdtempSync(join(tmpdir(), "cc-auto-"));
process.env.CLEARCOTE_PROFILE_DIR = join(root, "cache");

const { resolveAuto, resolveLocal, localSetupHint, _resetHint } = await import("../src/profileauto.js");

const HOST: HostFacts = {
  os_family: "windows", browser_major: 150, gpu_vendor: "nvidia",
  screen_width: 3440, screen_height: 1440, device_pixel_ratio: 1,
  hardware_concurrency: 16, device_memory: 16,
};

/** A VERSION-AGNOSTIC local profile: the UA carries no Chrome version, exactly like a converted
 *  chrome-fingerprints record. It therefore stays eligible whatever major the engine reports,
 *  which is what makes it usable as a backup across engine upgrades. */
function profileBlob(): Record<string, unknown> {
  return {
    meta: { captured_at: "2026-07-01T00:00:00.000Z" },
    navigator: {
      user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36",
      platform: "Win32",
    },
    screen: { width: 1920, height: 1080, device_pixel_ratio: 1 },
    webgl: { webgl1: { debug: { UNMASKED_RENDERER_WEBGL: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)" } } },
    hardware_concurrency: 16,
    device_memory: 16,
  };
}

// Each case uses a DISTINCT major so it gets a distinct index-cache key. fetchIndex deliberately
// serves a stale cached index when the service is down, so without this a previous test's cache
// would make a 503 look like success — which is exactly what the first run of these tests showed.
let nextMajor = 150;
const freshHost = (): HostFacts => ({ ...HOST, browser_major: nextMajor++ });

let server: Server;
let base: string;
let status = 200;
let localDir: string;

beforeAll(async () => {
  localDir = join(root, "imported");
  mkdirSync(localDir, { recursive: true });
  writeFileSync(join(localDir, "local-1.json"), JSON.stringify(profileBlob()));

  server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (status !== 200) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "service says no" }));
      return;
    }
    if (u.searchParams.get("id")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "svc-1", profile: { ...profileBlob(), _from: "service" } }));
      return;
    }
    // Echo back the major that was asked for, as the real service does — it serves candidates
    // for the described host rather than a fixed version.
    const major = Number(u.searchParams.get("major"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      candidates: [{
        id: "svc-1", os_family: "windows", browser_major: major, gpu_vendor: "nvidia",
        screen_width: 1920, screen_height: 1080, device_pixel_ratio: 1,
        hardware_concurrency: 16, device_memory: 16, encoded_size: 9000,
        captured_at: new Date().toISOString(),
      }],
    }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => { server.close(); rmSync(root, { recursive: true, force: true }); });
beforeEach(() => { status = 200; _resetHint(); });

// autoDownload OFF by default in these tests: the bootstrap fetches a ~1.3MB third-party
// dataset and shells out to Python, which would make the suite slow, network-dependent and
// dependent on a Python install. The bootstrap has its own dedicated test below.
const opts = () => ({ licenseKey: "cc_lic_test", apiBase: base, localDir, quiet: true, autoDownload: false as const });

describe("service first", () => {
  it("uses the service when it is available", async () => {
    const r = await resolveAuto(freshHost(), opts());
    expect(r.source).toBe("service");
    expect(r.selection.entry.id).toBe("svc-1");
    expect(r.fallbackReason).toBeUndefined();
  });
});

describe("fallback to local", () => {
  it("falls back when the service is rate limited (429)", async () => {
    status = 429;
    const r = await resolveAuto(freshHost(), opts());
    expect(r.source).toBe("local");
    expect(r.selection.entry.id).toBe("local-1");
    // The reason must survive: a silent downgrade would hide WHY the identity changed.
    expect(r.fallbackReason).toMatch(/429/);
  });

  it("falls back when the license is rejected (401) — a local persona beats none", async () => {
    status = 401;
    const r = await resolveAuto(freshHost(), opts());
    expect(r.source).toBe("local");
  });

  it("falls back on a server error", async () => {
    status = 503;
    const r = await resolveAuto(freshHost(), opts());
    expect(r.source).toBe("local");
  });

  it("preferLocal skips the service entirely", async () => {
    const r = await resolveAuto(freshHost(), { ...opts(), preferLocal: true });
    expect(r.source).toBe("local");
  });
});

describe("when neither source works (bootstrap disabled)", () => {
  it("reports BOTH failures, not just the local one", async () => {
    // Surfacing only the local error would send the caller to fix a directory when the real
    // problem was the license.
    status = 401;
    const missing = join(root, "does-not-exist");
    await expect(resolveAuto(freshHost(), { ...opts(), localDir: missing })).rejects.toThrow(/service:[\s\S]*local:/);
  });

  it("includes the optional-setup example when there is no local directory", async () => {
    status = 503;
    const missing = join(root, "also-missing");
    await expect(resolveAuto(freshHost(), { ...opts(), localDir: missing })).rejects.toThrow(/convert_dataset\.py/);
  });
});

describe("localSetupHint", () => {
  it("frames the third-party dataset as optional and user-fetched", () => {
    const h = localSetupHint("/tmp/x");
    expect(h).toMatch(/optional/i);
    // We redistribute nothing: the user fetches it from its own repo under its own terms.
    expect(h).toMatch(/own repo|own licence|own terms/i);
    expect(h).toContain("pip install chrome-fingerprints");
    expect(h).toContain("/tmp/x");
  });

  it("offers alternatives, so the dataset is one example and not a requirement", () => {
    const h = localSetupHint("/tmp/x");
    expect(h).toMatch(/your own captures|capture your own/i);
    expect(h).toContain("CLEARCOTE_PROFILE_SOURCE");
  });
});

describe("resolveLocal", () => {
  it("selects from the imported directory", () => {
    const r = resolveLocal(freshHost(), { localDir, quiet: true });
    expect(r.source).toBe("local");
    expect(r.profile).toHaveProperty("navigator");
  });

  it("explains how to populate a missing directory", () => {
    expect(() => resolveLocal(freshHost(), { localDir: join(root, "nope") }))
      .toThrow(/no local profile directory[\s\S]*convert_dataset\.py/);
  });
});

describe("first-run bootstrap", () => {
  it("is ATTEMPTED when the service fails and there is no local library", async () => {
    // Verified end to end separately (download -> convert -> 25/25 indexed -> selected). Here we
    // only assert the attempt happens, without paying for the network: with no converter present
    // ensureLocalProfiles returns false rather than throwing, so the call still ends in the
    // both-failed error — but it must have TRIED, which the default (autoDownload unset) implies.
    status = 503;
    const missing = join(root, "bootstrap-target");
    await expect(
      resolveAuto(freshHost(), {
        licenseKey: "cc_lic_test", apiBase: base, localDir: missing, quiet: true,
        // point the converter somewhere that does not exist so the bootstrap gives up fast
        // instead of downloading during a unit test
        converter: join(root, "no-such-converter.py"),
      } as never),
    ).rejects.toThrow(/service:[\s\S]*local:/);
  });

  it("can be disabled explicitly", async () => {
    status = 503;
    await expect(
      resolveAuto(freshHost(), { ...opts(), localDir: join(root, "never"), autoDownload: false }),
    ).rejects.toThrow(/could not resolve a persona/);
  });
});
