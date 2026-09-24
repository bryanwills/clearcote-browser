// Entry-point wiring the pure helper tests cannot reach: profile:"auto" through launch(),
// launchPersistentContext() and serve(); the throwaway-profile lifecycle of launch() and
// launchAgent(); and the proxy switches serve() puts on the engine command line.
//
// Stubbed: Playwright, the child-process spawn, and the two expensive "auto" collaborators (the
// host measurement launches a browser, the resolver calls the profile service). Everything between
// them — option merging, binary resolution, arg assembly, temp-directory handling — runs for real.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const stub = vi.hoisted(() => ({
  // PROFILE_DIR is read once, at import: point it somewhere empty before the SDK loads, so no saved
  // profile on this machine (a real auto.json included) can change what these tests see.
  savedProfileDir: ((prev) => { process.env.CLEARCOTE_PROFILE_DIR = `${process.cwd()}/.no-saved-profiles`; return prev; })(process.env.CLEARCOTE_PROFILE_DIR),
  launches: [] as Array<{ kind: "persistent" | "incognito"; userDataDir?: string; opts: Record<string, unknown> }>,
  spawns: [] as string[][],
  failLaunch: null as Error | null,
  host: {
    os_family: "windows", browser_major: 153, gpu_vendor: "intel",
    screen_width: 1920, screen_height: 1080, device_pixel_ratio: 1,
    hardware_concurrency: 8, device_memory: 8,
  },
  serviceProfile: { navigator: { user_agent: "captured-ua", languages: ["en-US", "en"] } },
}));

vi.mock("playwright-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("playwright-core")>();
  const { EventEmitter } = await import("node:events");
  const fakeContext = () => {
    const ctx = new EventEmitter() as EventEmitter & Record<string, unknown>;
    ctx.pages = () => [];
    ctx.browser = () => null;
    ctx.close = async () => { ctx.emit("close", ctx); };
    return ctx;
  };
  const chromium = {
    launchPersistentContext: async (userDataDir: string, opts: Record<string, unknown>) => {
      stub.launches.push({ kind: "persistent", userDataDir, opts });
      if (stub.failLaunch) throw stub.failLaunch;
      return fakeContext();
    },
    launch: async (opts: Record<string, unknown>) => {
      stub.launches.push({ kind: "incognito", opts });
      if (stub.failLaunch) throw stub.failLaunch;
      const browser = new EventEmitter() as EventEmitter & Record<string, unknown>;
      browser.newPage = async () => ({});
      browser.newContext = async () => fakeContext();
      browser.close = async () => {};
      return browser;
    },
  };
  return { ...actual, chromium };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  return {
    ...actual,
    spawn: (_cmd: string, args: string[]) => {
      stub.spawns.push(args);
      const p = new EventEmitter() as EventEmitter & Record<string, unknown>;
      p.exitCode = null;
      p.killed = false;
      p.pid = 4242;
      p.kill = () => { p.killed = true; return true; };
      queueMicrotask(() => p.emit("spawn"));
      return p;
    },
  };
});

vi.mock("../src/profilesource.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/profilesource.js")>()),
  measureHost: async () => stub.host,
}));

vi.mock("../src/profileauto.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/profileauto.js")>()),
  resolveAuto: async () => ({ profile: stub.serviceProfile, selection: { entry: { id: "svc-1" } }, source: "service" }),
}));

import { launch, launchAgent, launchPersistentContext, serve } from "../src/index.js";
import { resolveLicenseKey } from "../src/license.js";

afterAll(() => {
  if (stub.savedProfileDir === undefined) delete process.env.CLEARCOTE_PROFILE_DIR;
  else process.env.CLEARCOTE_PROFILE_DIR = stub.savedProfileDir;
});

const ENV_KEYS = ["HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "CLEARCOTE_NO_WARN", "CLEARCOTE_LICENSE_KEY",
  "CLEARCOTE_BINARY", "CLEARCOTE_BROWSER_VERSION"] as const;
let savedEnv: Record<string, string | undefined>;
let root: string;
let temp: string; // the TEMP every launch sees: anything left in it after a test leaked
let exe: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  root = mkdtempSync(join(tmpdir(), "cc-entry-"));
  temp = join(root, "temp");
  const home = join(root, "home");
  for (const d of [temp, home, join(root, "engine")]) mkdirSync(d);
  // A modern engine as far as the capability probes can tell. Deliberately no chrome.dll next to
  // it: checkInstall only verifies a tree that looks like a full install.
  exe = join(root, "engine", process.platform === "win32" ? "chrome.exe" : "chrome");
  writeFileSync(exe, Buffer.from("MZ\0socks5-credentials\0\0proxy-auth\0\0fingerprint-profile\0", "latin1"));
  // No licence (a key would select the PRO binary and a lease), no saved profiles, no warnings.
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.TEMP = temp;
  process.env.TMP = temp;
  process.env.TMPDIR = temp;
  process.env.CLEARCOTE_NO_WARN = "1";
  for (const k of ["CLEARCOTE_LICENSE_KEY", "CLEARCOTE_BINARY", "CLEARCOTE_BROWSER_VERSION"]) delete process.env[k];
  stub.launches.length = 0;
  stub.spawns.length = 0;
  stub.failLaunch = null;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(root, { recursive: true, force: true });
});

/** The persona a --fingerprint-profile switch carries (gzip + base64 JSON). */
function decodedProfile(args: string[]): unknown {
  const a = args.find((x) => x.startsWith("--fingerprint-profile="));
  return a ? JSON.parse(gunzipSync(Buffer.from(a.slice("--fingerprint-profile=".length), "base64")).toString("utf8")) : undefined;
}

const base = () => ({ executablePath: exe, headless: false, quiet: true });

it("harness: no licence is visible, so no launch here can take a real lease", () => {
  expect(resolveLicenseKey()).toBeUndefined();
});

describe("profile: \"auto\" on every entry point", () => {
  // Regression: launch() is profile-backed by default (0.23.0), and launchPersistentContext loaded
  // "auto" as a SAVED profile name -> ENOENT ~/.clearcote/profiles/auto.json. Only the incognito
  // path (ephemeralProfile: false) knew "auto" was special.
  it("launch() — the default ephemeral profile", async () => {
    const browser = await launch({ ...base(), profile: "auto" });
    const call = stub.launches.at(-1)!;
    expect(call.kind).toBe("persistent");
    const args = call.opts.args as string[];
    expect(decodedProfile(args)).toEqual(stub.serviceProfile);
    expect(args.some((a) => a.startsWith("--fingerprint="))).toBe(false); // "auto" never seeds
    await browser.close();
  });

  it("launchPersistentContext()", async () => {
    const udd = join(root, "profile");
    const context = await launchPersistentContext(udd, { ...base(), profile: "auto" });
    const call = stub.launches.at(-1)!;
    expect(call.userDataDir).toBe(udd);
    expect(decodedProfile(call.opts.args as string[])).toEqual(stub.serviceProfile);
    expect(call.opts).not.toHaveProperty("profileSelect"); // an SDK option, not a Playwright one
    await context.close();
  });

  it("launch({ ephemeralProfile: false }) — unchanged", async () => {
    const browser = await launch({ ...base(), profile: "auto", ephemeralProfile: false });
    const call = stub.launches.at(-1)!;
    expect(call.kind).toBe("incognito");
    expect(decodedProfile(call.opts.args as string[])).toEqual(stub.serviceProfile);
    await browser.close();
  });

  it("serve()", async () => {
    const { port, close } = await fakeCdpEndpoint();
    try {
      const srv = await serve({ ...base(), port, profile: "auto" });
      expect(decodedProfile(stub.spawns.at(-1)!)).toEqual(stub.serviceProfile);
      await srv.close();
    } finally {
      await close();
    }
  });

  it("a saved profile name that does not exist still fails loudly", async () => {
    await expect(launch({ ...base(), profile: "no-such-profile" })).rejects.toThrow(/no-such-profile/);
  });
});

describe("throwaway profiles are never left behind", () => {
  const leftovers = () => readdirSync(temp);

  // Regression: the temp profile was created before the launch and never removed when it failed.
  it("launch() removes its profile when the launch fails", async () => {
    stub.failLaunch = new Error("browser failed to start");
    await expect(launch(base())).rejects.toThrow("browser failed to start");
    expect(stub.launches.at(-1)!.userDataDir).toMatch(/clearcote-run-/);
    expect(leftovers()).toEqual([]);
  });

  it("launch() removes its profile when option resolution fails before any browser starts", async () => {
    await expect(launch({ ...base(), profile: "no-such-profile" })).rejects.toThrow();
    expect(leftovers()).toEqual([]);
  });

  it("launchAgent() removes its profile when the launch fails", async () => {
    stub.failLaunch = new Error("browser failed to start");
    await expect(launchAgent(base())).rejects.toThrow("browser failed to start");
    expect(stub.launches.at(-1)!.userDataDir).toMatch(/clearcote-agent-/);
    expect(leftovers()).toEqual([]);
  });

  // The caller never learns the path of a profile it did not name, so keeping it only leaks it.
  it("launchAgent() removes the profile it created when the context closes", async () => {
    const context = await launchAgent(base());
    const dir = stub.launches.at(-1)!.userDataDir!;
    expect(existsSync(dir)).toBe(true);
    await context.close();
    await vi.waitFor(() => expect(existsSync(dir)).toBe(false));
    expect(leftovers()).toEqual([]);
  });

  it("launchAgent({ userDataDir }) keeps the caller's profile", async () => {
    const udd = join(root, "keep-me");
    mkdirSync(udd);
    const context = await launchAgent({ ...base(), userDataDir: udd });
    await context.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(udd)).toBe(true);
  });
});

describe("serve() proxy switches", () => {
  // Regression: serve() appended --proxy-server=<the caller's raw server> AFTER the resolved proxy
  // args. The last --proxy-server wins, and with user:pass@ still in it Chromium drops the entry.
  it("sends URL credentials to the engine and never puts userinfo on --proxy-server", async () => {
    const { port, close } = await fakeCdpEndpoint();
    try {
      const srv = await serve({ ...base(), port, proxy: { server: "socks5://user:p%40ss@127.0.0.1:1080" } });
      const args = stub.spawns.at(-1)!;
      expect(args).toContain("--socks5-credentials=user:p@ss");
      expect(args.filter((a) => a.startsWith("--proxy-server="))).toEqual(["--proxy-server=socks5://127.0.0.1:1080"]);
      await srv.close();
    } finally {
      await close();
    }
  });

  it("keeps a plain proxy on a single --proxy-server", async () => {
    const { port, close } = await fakeCdpEndpoint();
    try {
      const srv = await serve({ ...base(), port, proxy: { server: "http://127.0.0.1:3128" } });
      expect(stub.spawns.at(-1)!.filter((a) => a.startsWith("--proxy-server="))).toEqual(["--proxy-server=http://127.0.0.1:3128"]);
      await srv.close();
    } finally {
      await close();
    }
  });
});

describe("launch() proxy options", () => {
  it("routes SOCKS5 credentials written in the URL to the engine, not Playwright", async () => {
    const browser = await launch({ ...base(), proxy: { server: "socks5://user:pass@127.0.0.1:1080" } });
    const call = stub.launches.at(-1)!;
    expect(call.opts.args).toEqual(expect.arrayContaining(["--proxy-server=socks5://127.0.0.1:1080", "--socks5-credentials=user:pass"]));
    expect(call.opts.proxy).toBeUndefined();
    await browser.close();
  });
});

/** A stand-in for the browser's CDP HTTP endpoint, which serve() polls until it answers. */
async function fakeCdpEndpoint(): Promise<{ port: number; close: () => Promise<void> }> {
  const server: HttpServer = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}
