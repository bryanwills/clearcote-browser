// Exercises the profile-service client against a REAL local HTTP server rather than a mocked
// fetch, so the request shape, auth header, caching and fallback paths are all genuinely tested.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostFacts } from "../src/profilelib.js";

let dir: string;
// PROFILE_DIR is read at module load, so the env must be set before the import below.
dir = mkdtempSync(join(tmpdir(), "cc-profsrc-"));
process.env.CLEARCOTE_PROFILE_DIR = dir;

// Static type-only import: erased at compile time, so it cannot run before the env is set above.
// The VALUE import stays dynamic for exactly that reason.
const { fetchIndex, fetchProfile, resolveAutoProfile, hostOsFamily } = await import("../src/profilesource.js");

const HOST = {
  os_family: "windows",
  browser_major: 150,
  gpu_vendor: "intel",
  screen_width: 3440,
  screen_height: 1440,
  device_pixel_ratio: 1,
  hardware_concurrency: 16,
  device_memory: 16,
} as HostFacts;

let server: Server;
let base: string;
const seen: { url: string; auth: string | undefined }[] = [];
let indexStatus = 200;
let profileStatus = 200;

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", auth: req.headers.authorization });
    const u = new URL(req.url ?? "/", "http://x");
    if (u.searchParams.get("id")) {
      res.writeHead(profileStatus, { "content-type": "application/json" });
      res.end(JSON.stringify(profileStatus === 200
        ? { id: u.searchParams.get("id"), profile: { navigator: { user_agent: "ua" }, screen: { width: 1920 } } }
        : { error: "nope" }));
      return;
    }
    res.writeHead(indexStatus, { "content-type": "application/json" });
    res.end(JSON.stringify(indexStatus === 200
      ? {
          candidates: [
            { id: "p-best", os_family: "windows", browser_major: 150, gpu_vendor: "intel",
              screen_width: 1920, screen_height: 1080, device_pixel_ratio: 1,
              hardware_concurrency: 16, device_memory: 16, encoded_size: 9000,
              captured_at: new Date().toISOString() },
            { id: "p-nvidia", os_family: "windows", browser_major: 150, gpu_vendor: "nvidia",
              screen_width: 1920, screen_height: 1080, device_pixel_ratio: 1,
              hardware_concurrency: 16, device_memory: 16, encoded_size: 9000,
              captured_at: new Date().toISOString() },
          ],
        }
      : { error: "nope" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  seen.length = 0;
  indexStatus = 200;
  profileStatus = 200;
});

const opts = () => ({ licenseKey: "cc_lic_test", apiBase: base });

describe("hostOsFamily", () => {
  it("maps the Node platform onto corpus os_family values", () => {
    expect(["windows", "macos", "linux"]).toContain(hostOsFamily());
  });
});

describe("auth", () => {
  it("sends the license as a bearer token", async () => {
    await fetchIndex(HOST, opts());
    expect(seen[0].auth).toBe("Bearer cc_lic_test");
  });

  it("refuses to call the service with no key, and says why", async () => {
    const prev = process.env.CLEARCOTE_LICENSE_KEY;
    delete process.env.CLEARCOTE_LICENSE_KEY;
    await expect(fetchIndex(HOST, { apiBase: base })).rejects.toThrow(/license key/i);
    if (prev) process.env.CLEARCOTE_LICENSE_KEY = prev;
  });
});

describe("index", () => {
  it("requests the host's os and chromium major", async () => {
    await fetchIndex(HOST, opts());
    expect(seen[0].url).toContain("os=windows");
    expect(seen[0].url).toContain("major=150");
  });

  it("falls back to a stale cached index rather than failing the launch", async () => {
    await fetchIndex(HOST, opts());       // populate cache
    seen.length = 0;
    indexStatus = 503;                     // service down
    const out = await fetchIndex(HOST, opts());
    expect(out.length).toBe(2);            // served from cache
  });

  it("offline uses the cache and never touches the network", async () => {
    await fetchIndex(HOST, opts());
    seen.length = 0;
    const out = await fetchIndex(HOST, { ...opts(), offline: true });
    expect(out.length).toBe(2);
    expect(seen.length).toBe(0);
  });
});

describe("profile fetch", () => {
  it("caches on disk so a repeat costs no request at all", async () => {
    // The service makes repeats free of DISTINCT budget; not spending a request is better still.
    await fetchProfile("p-cache-1", opts());
    expect(seen.length).toBe(1);
    seen.length = 0;
    const again = await fetchProfile("p-cache-1", opts());
    expect(seen.length).toBe(0);
    expect(again).toHaveProperty("navigator");
  });

  it("surfaces the service's error body on failure", async () => {
    profileStatus = 429;
    await expect(fetchProfile("p-limited", opts())).rejects.toThrow(/429/);
  });

  it("offline without a cached copy fails clearly", async () => {
    await expect(fetchProfile("p-never-seen", { ...opts(), offline: true })).rejects.toThrow(/not cached/);
  });
});

describe("resolveAutoProfile", () => {
  it("picks the host-coherent candidate, not merely the first", async () => {
    // p-best matches the host's Intel GPU; p-nvidia does not. GPU dominates the score.
    const { selection, profile } = await resolveAutoProfile(HOST, { ...opts(), mode: "best" });
    expect(selection.entry.id).toBe("p-best");
    expect(profile).toHaveProperty("navigator");
  });

  it("is sticky: the same key resolves to the same profile across calls", async () => {
    const a = await resolveAutoProfile(HOST, { ...opts(), key: "acct-7" });
    const b = await resolveAutoProfile(HOST, { ...opts(), key: "acct-7" });
    expect(a.selection.entry.id).toBe(b.selection.entry.id);
  });

  it("writes the chosen profile into the library cache", async () => {
    const { selection } = await resolveAutoProfile(HOST, { ...opts(), mode: "best" });
    expect(existsSync(join(dir, "library", `profile-${selection.entry.id}.json`))).toBe(true);
  });
});
