import { describe, it, expect, afterEach, vi } from "vitest";
import { IPECHO_URLS, checkEgressDrift, startEgressDriftCheck } from "../src/geoip.js";
import { startOrigin, startHttpProxy, type Started } from "./helpers/proxies.js";

// A rotating proxy changes the exit per connection (mirrors the Python test_egress_drift_* tests).
const saved = [...IPECHO_URLS];
const started: Started<unknown>[] = [];
afterEach(async () => {
  IPECHO_URLS.splice(0, IPECHO_URLS.length, ...saved);
  vi.restoreAllMocks();
  for (const s of started.splice(0)) await s.close();
});

async function setup(state: { ip: string }) {
  const origin = await startOrigin(() => ({ body: state.ip }));
  const proxy = await startHttpProxy();
  started.push(origin as Started<unknown>, proxy as Started<unknown>);
  IPECHO_URLS.splice(0, IPECHO_URLS.length, `http://localhost:${origin.port}/echo`);
  return { spec: { server: `http://127.0.0.1:${proxy.port}` }, proxy };
}

describe("egress drift", () => {
  it("detects a rotating exit through the proxy", async () => {
    const state = { ip: "203.0.113.7" };
    const { spec, proxy } = await setup(state);
    expect(await checkEgressDrift(spec, "203.0.113.7")).toBeNull(); // sticky: same exit
    state.ip = "203.0.113.99";
    expect(await checkEgressDrift(spec, "203.0.113.7")).toBe("203.0.113.99");
    expect(await checkEgressDrift(spec, "2001:db8::1")).toBeNull(); // other family: not a rotation
    expect(await checkEgressDrift(undefined, "203.0.113.7")).toBeNull(); // no proxy
    expect(proxy.log.length).toBe(3);
  });

  it("prints one warning, and nothing when quiet or sticky", async () => {
    const state = { ip: "203.0.113.99" };
    const { spec } = await setup(state);
    const savedNoWarn = process.env.CLEARCOTE_NO_WARN;
    delete process.env.CLEARCOTE_NO_WARN;
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await startEgressDriftCheck(spec, "203.0.113.7", true);
      expect(spy).not.toHaveBeenCalled();
      await startEgressDriftCheck(spec, "203.0.113.7");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0][0])).toContain("203.0.113.7 -> 203.0.113.99");
      spy.mockClear();
      state.ip = "203.0.113.7";
      await startEgressDriftCheck(spec, "203.0.113.7");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      if (savedNoWarn !== undefined) process.env.CLEARCOTE_NO_WARN = savedNoWarn;
    }
  });
});
