// Proxy tunnelling (./net.ts), geoip timeout + fail-closed (#3), licence seats + licence-through-proxy.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proxiedRequest, toProxySpec } from "../src/net.js";
import { geoipTimeoutMs, resolveGeoDetailed, GeoipError } from "../src/geoip.js";
import { applyGeoip } from "../src/index.js";
import {
  getSessionSeats,
  licenseThroughProxyRequested,
  saveLicenseKey,
  removeLicenseKey,
  licenseKeySource,
  licenseKeyPath,
  acquireLease,
} from "../src/license.js";
import { startOrigin, startHttpProxy, startSocks5, type Started } from "./helpers/proxies.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  vi.restoreAllMocks();
});
function keep<T extends Started<unknown>>(s: T): T {
  cleanups.push(() => s.close());
  return s;
}

describe("toProxySpec", () => {
  it("splits inline credentials and fills default ports", () => {
    expect(toProxySpec("socks5://us%40er:p%3Ass@h.test")).toEqual({ server: "socks5://h.test:1080", username: "us@er", password: "p:ss" });
    expect(toProxySpec("proxy.test:3128")).toEqual({ server: "http://proxy.test:3128" });
    expect(toProxySpec({ server: "http://h:8080", username: "u", password: "p" })).toEqual({ server: "http://h:8080", username: "u", password: "p" });
    expect(toProxySpec(null)).toBeNull();
  });

  it("keeps an IPv6 proxy host bracketed once, so it stays a valid URL", () => {
    const spec = toProxySpec("socks5://u:p@[::1]:1080");
    expect(spec).toEqual({ server: "socks5://[::1]:1080", username: "u", password: "p" });
    expect(new URL(spec!.server).port).toBe("1080");
    expect(toProxySpec("http://[2001:db8::5]")?.server).toBe("http://[2001:db8::5]:80");
  });
});

describe("proxiedRequest never passes a cut-off response as complete", () => {
  async function rawOrigin(reply: string) {
    const net = await import("node:net");
    const srv = net.createServer((s) => { s.once("data", () => { s.end(reply); }); s.on("error", () => {}); });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    cleanups.push(() => new Promise<void>((r) => srv.close(() => r())));
    return (srv.address() as { port: number }).port;
  }

  it("rejects a body shorter than Content-Length", async () => {
    const port = await rawOrigin("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{\"partial\":");
    const socks = keep(await startSocks5());
    await expect(proxiedRequest(`http://127.0.0.1:${port}/`, { proxy: { server: `socks5://127.0.0.1:${socks.port}` }, timeoutMs: 3000 }))
      .rejects.toThrow(/truncated/);
  });

  it("rejects a chunked body without its terminating chunk", async () => {
    const port = await rawOrigin("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n");
    const socks = keep(await startSocks5());
    await expect(proxiedRequest(`http://127.0.0.1:${port}/`, { proxy: { server: `socks5://127.0.0.1:${socks.port}` }, timeoutMs: 3000 }))
      .rejects.toThrow(/truncated/);
  });

  it("still decodes a complete chunked body", async () => {
    const port = await rawOrigin("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n");
    const socks = keep(await startSocks5());
    const r = await proxiedRequest(`http://127.0.0.1:${port}/`, { proxy: { server: `socks5://127.0.0.1:${socks.port}` }, timeoutMs: 3000 });
    expect(await r.text()).toBe("hello world");
  });
});

describe("proxiedRequest", () => {
  it("goes direct without a proxy", async () => {
    const origin = keep(await startOrigin(() => ({ body: '{"ok":1}' })));
    const r = await proxiedRequest(`http://127.0.0.1:${origin.port}/x`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: 1 });
  });

  it("sends a plain-http request through an HTTP proxy (absolute form) with Proxy-Authorization", async () => {
    const origin = keep(await startOrigin((req, body) => ({ body: JSON.stringify({ path: req.url, body }) })));
    const proxy = keep(await startHttpProxy({ requireAuth: "Basic " + Buffer.from("u:p").toString("base64") }));
    const r = await proxiedRequest(`http://127.0.0.1:${origin.port}/api?q=1`, {
      method: "POST", body: '{"a":1}', headers: { "content-type": "application/json" },
      proxy: { server: `http://127.0.0.1:${proxy.port}`, username: "u", password: "p" },
    });
    expect(r.ok).toBe(true);
    expect(await r.json()).toEqual({ path: "/api?q=1", body: '{"a":1}' });
    expect(proxy.log).toEqual([{ kind: "absolute", target: `http://127.0.0.1:${origin.port}/api?q=1`, auth: "Basic dTpw" }]);
  });

  it("surfaces a 407 from an HTTP proxy that rejects the credentials as an HTTP status", async () => {
    const origin = keep(await startOrigin(() => ({ body: "{}" })));
    const proxy = keep(await startHttpProxy({ requireAuth: "Basic nope" }));
    const r = await proxiedRequest(`http://127.0.0.1:${origin.port}/`, { proxy: { server: `http://127.0.0.1:${proxy.port}` } });
    expect(r.status).toBe(407);
    expect(origin.log).toHaveLength(0);
  });

  it("goes through a SOCKS5 proxy with username/password (hostname sent, not resolved locally)", async () => {
    const origin = keep(await startOrigin(() => ({ body: '{"via":"socks"}' })));
    const socks = keep(await startSocks5({ user: "alice", pass: "s3cret" }));
    const r = await proxiedRequest(`http://localhost:${origin.port}/`, { proxy: `socks5://alice:s3cret@127.0.0.1:${socks.port}` });
    expect(await r.json()).toEqual({ via: "socks" });
    expect(socks.log).toEqual([{ host: "localhost", port: origin.port, user: "alice" }]);
  });

  it("rejects when the SOCKS5 proxy refuses the credentials, and nothing reaches the origin", async () => {
    const origin = keep(await startOrigin(() => ({ body: "{}" })));
    const socks = keep(await startSocks5({ user: "alice", pass: "right" }));
    await expect(proxiedRequest(`http://127.0.0.1:${origin.port}/`, { proxy: `socks5://alice:wrong@127.0.0.1:${socks.port}`, timeoutMs: 5000 }))
      .rejects.toThrow(/rejected the username\/password/);
    expect(origin.log).toHaveLength(0);
  });

  it("times out against a proxy that never answers", async () => {
    const net = await import("node:net");
    const held = new Set<import("node:net").Socket>();
    const silent = net.createServer((s) => { held.add(s); });
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
    cleanups.push(() => new Promise<void>((r) => { for (const s of held) s.destroy(); silent.close(() => r()); }));
    const port = (silent.address() as import("node:net").AddressInfo).port;
    const t0 = Date.now();
    await expect(proxiedRequest("http://example.invalid/", { proxy: `socks5://127.0.0.1:${port}`, timeoutMs: 400 })).rejects.toThrow(/timed out/);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe("geoip timeout + fail-closed (#3)", () => {
  it("reads CLEARCOTE_GEOIP_TIMEOUT_SECONDS, defaulting to 20s and ignoring junk", () => {
    expect(geoipTimeoutMs({})).toBe(20_000);
    expect(geoipTimeoutMs({ CLEARCOTE_GEOIP_TIMEOUT_SECONDS: "7" })).toBe(7000);
    expect(geoipTimeoutMs({ CLEARCOTE_GEOIP_TIMEOUT_SECONDS: "1.5" })).toBe(1500);
    expect(geoipTimeoutMs({ CLEARCOTE_GEOIP_TIMEOUT_SECONDS: "0" })).toBe(20_000);
    expect(geoipTimeoutMs({ CLEARCOTE_GEOIP_TIMEOUT_SECONDS: "abc" })).toBe(20_000);
  });

  it("reports WHY a lookup failed, within its budget, through a dead proxy", async () => {
    const t0 = Date.now();
    const r = await resolveGeoDetailed("socks5://127.0.0.1:1", { quiet: true, timeoutMs: 1500 });
    expect(r.geo).toBeNull();
    expect(r.reason).toMatch(/exit IP through the proxy|timed out/);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("throws GeoipError instead of launching on the host's clock", async () => {
    const fp: Record<string, unknown> = {};
    await expect(applyGeoip(fp, { server: "socks5://127.0.0.1:1" }, true)).rejects.toBeInstanceOf(GeoipError);
    expect(fp.timezone).toBeUndefined();
  });

  it("still launches when the caller set BOTH timezone and acceptLanguage explicitly", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fp: Record<string, unknown> = { timezone: "Europe/Paris", acceptLanguage: "fr-FR,fr" };
    await expect(applyGeoip(fp, { server: "socks5://127.0.0.1:1" }, false)).resolves.toBeUndefined();
    expect(fp).toEqual({ timezone: "Europe/Paris", acceptLanguage: "fr-FR,fr" });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/using the explicit timezone and acceptLanguage/));
  });

  it("with only ONE of the two explicit, it still fails closed", async () => {
    await expect(applyGeoip({ timezone: "Europe/Paris" }, { server: "socks5://127.0.0.1:1" }, true)).rejects.toBeInstanceOf(GeoipError);
  });
});

describe("licence seats + licence through proxy", () => {
  let home: string;
  const savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cc-home-"));
    for (const k of ["HOME", "USERPROFILE", "CLEARCOTE_LICENSE_KEY", "CLEARCOTE_LICENSE_THROUGH_PROXY", "CLEARCOTE_LICENSE_API", "CLEARCOTE_INSTANCE_ID"]) savedEnv[k] = process.env[k];
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.CLEARCOTE_LICENSE_KEY;
    delete process.env.CLEARCOTE_LICENSE_THROUGH_PROXY;
    process.env.CLEARCOTE_INSTANCE_ID = "test-instance";
    cleanups.push(() => {
      for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      rmSync(home, { recursive: true, force: true });
    });
  });

  it("licenseThroughProxy: option wins, else the env switch", () => {
    expect(licenseThroughProxyRequested(undefined, {})).toBe(false);
    expect(licenseThroughProxyRequested(undefined, { CLEARCOTE_LICENSE_THROUGH_PROXY: "1" })).toBe(true);
    expect(licenseThroughProxyRequested(false, { CLEARCOTE_LICENSE_THROUGH_PROXY: "true" })).toBe(false);
  });

  it("getSessionSeats: ok / invalid / older server / unreachable / no key — never throws", async () => {
    const api = keep(await startOrigin((req) => {
      const auth = req.headers.authorization;
      if (req.url !== "/api/v1/lease/seats") return { status: 404, body: '{"error":"not found"}' };
      if (auth === "Bearer cc_lic_good") return { body: '{"used":2,"limit":5,"plan":"team"}' };
      if (auth === "Bearer cc_lic_unl") return { body: '{"used":1,"limit":null,"plan":"pro"}' };
      return { status: 401, body: '{"error":"Invalid license key."}' };
    }));
    const base = `http://127.0.0.1:${api.port}`;
    expect(await getSessionSeats({ licenseKey: "cc_lic_good", licenseApiBase: base })).toEqual({ state: "ok", used: 2, limit: 5, plan: "team" });
    expect(await getSessionSeats({ licenseKey: "cc_lic_unl", licenseApiBase: base })).toEqual({ state: "ok", used: 1, limit: null, plan: "pro" });
    expect(await getSessionSeats({ licenseKey: "cc_lic_bad", licenseApiBase: base })).toMatchObject({ state: "invalid", reason: "Invalid license key." });
    const old = keep(await startOrigin(() => ({ status: 404, body: "{}" })));
    expect(await getSessionSeats({ licenseKey: "cc_lic_good", licenseApiBase: `http://127.0.0.1:${old.port}` })).toMatchObject({ state: "unavailable" });
    expect(await getSessionSeats({ licenseKey: "cc_lic_good", licenseApiBase: "http://127.0.0.1:1" })).toMatchObject({ state: "unavailable", reason: expect.stringMatching(/unreachable/) });
    expect(await getSessionSeats({})).toEqual({ state: "no-key" });
  });

  it("getSessionSeats goes through the proxy only when licenseThroughProxy is on", async () => {
    const api = keep(await startOrigin(() => ({ body: '{"used":0,"limit":3}' })));
    const proxy = keep(await startHttpProxy());
    const base = `http://127.0.0.1:${api.port}`;
    const px = `http://127.0.0.1:${proxy.port}`;
    await getSessionSeats({ licenseKey: "k", licenseApiBase: base, proxy: px });
    expect(proxy.log).toHaveLength(0);
    await getSessionSeats({ licenseKey: "k", licenseApiBase: base, proxy: px, licenseThroughProxy: true });
    expect(proxy.log.map((l) => l.target)).toEqual([`${base}/api/v1/lease/seats`]);
  });

  it("acquireLease sends checkout through a SOCKS5 proxy with licenseThroughProxy, and direct without it", async () => {
    const api = keep(await startOrigin((req) => ({
      body: JSON.stringify({ lease_id: `L-${req.url}`, token: "tok", exp: Math.floor(Date.now() / 1000) + 3600, lease_ttl_sec: 600, heartbeat_interval_sec: 3600, concurrency: { used: 1, limit: 5 } }),
    })));
    const socks = keep(await startSocks5());
    const base = `http://127.0.0.1:${api.port}`;
    const proxy = { server: `socks5://127.0.0.1:${socks.port}` };

    const viaProxy = await acquireLease({ licenseKey: "cc_lic_proxy_route", licenseApiBase: base, proxy, licenseThroughProxy: true, quiet: true });
    expect(viaProxy?.token).toBe("tok");
    expect(socks.log).toEqual([{ host: "127.0.0.1", port: api.port, user: undefined }]);
    expect(api.log.at(-1)?.url).toBe("/api/v1/lease/checkout");

    const direct = await acquireLease({ licenseKey: "cc_lic_direct_route", licenseApiBase: base, proxy, quiet: true });
    expect(direct?.token).toBe("tok");
    expect(socks.log).toHaveLength(1); // unchanged: the second checkout did not use the proxy
    expect(api.log).toHaveLength(2);
  });

  it("login/logout key storage: saved owner-only, source reported masked, removed cleanly", () => {
    expect(licenseKeySource()).toEqual({ source: "none" });
    const p = saveLicenseKey("  cc_lic_abcdefghijklmnop  ");
    expect(p).toBe(licenseKeyPath());
    expect(readFileSync(p, "utf8")).toBe("cc_lic_abcdefghijklmnop\n");
    if (process.platform !== "win32") expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(licenseKeySource()).toEqual({ source: "file", masked: "cc_lic_…mnop" });
    process.env.CLEARCOTE_LICENSE_KEY = "cc_lic_fromenv_zzzz";
    expect(licenseKeySource().source).toBe("env");
    expect(removeLicenseKey()).toBe(true);
    expect(existsSync(p)).toBe(false);
    expect(removeLicenseKey()).toBe(false);
  });
});
