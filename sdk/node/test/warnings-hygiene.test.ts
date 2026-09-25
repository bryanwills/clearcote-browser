import { describe, it, expect, vi, afterEach } from "vitest";
import { coherenceWarnings, emitWarnings, serveExposureWarnings } from "../src/warnings.js";

// Automation-hygiene warnings (mirrors sdk/python/tests/test_warnings.py).
const codes = (o: Record<string, unknown>) => new Set(coherenceWarnings(o, "win32", "149").map((w) => w.code));

describe("automation hygiene warnings", () => {
  it("flags an open DevTools", () => {
    expect(codes({ devtools: true }).has("devtools-open")).toBe(true);
    expect(codes({ _userArgs: ["--auto-open-devtools-for-tabs"] }).has("devtools-open")).toBe(true);
    expect(codes({ devtools: false }).has("devtools-open")).toBe(false);
  });

  it("flags a custom user agent", () => {
    expect(codes({ userAgent: "Mozilla/5.0 (Macintosh) Chrome/120" }).has("custom-user-agent")).toBe(true);
    expect(codes({ _userArgs: ["--user-agent=Mozilla/5.0 Foo"] }).has("custom-user-agent")).toBe(true);
    expect(codes({ userAgent: undefined }).has("custom-user-agent")).toBe(false);
  });

  it("flags a DevTools endpoint exposed through args (last value wins)", () => {
    expect(codes({ _userArgs: ["--remote-debugging-address=0.0.0.0"] }).has("cdp-public-bind")).toBe(true);
    expect(codes({ _userArgs: ["--remote-debugging-address=127.0.0.1"] }).has("cdp-public-bind")).toBe(false);
    expect(codes({ _userArgs: ["--remote-debugging-address=0.0.0.0", "--remote-debugging-address=::1"] })
      .has("cdp-public-bind")).toBe(false);
    expect(codes({ _userArgs: ["--remote-allow-origins=*"] }).has("cdp-any-origin")).toBe(true);
    expect(codes({ _userArgs: ["--remote-allow-origins=http://a.test, *"] }).has("cdp-any-origin")).toBe(true);
    expect(codes({ _userArgs: ["--remote-allow-origins=http://127.0.0.1:9222"] }).has("cdp-any-origin")).toBe(false);
  });

  it("checks serve's bind address and origins", () => {
    const c = (h: string, o: string) => new Set(serveExposureWarnings(h, o).map((w) => w.code));
    expect(c("127.0.0.1", "http://127.0.0.1:9222,http://localhost:9222").size).toBe(0);
    expect(c("localhost", "http://localhost:9222").size).toBe(0);
    expect(c("[::1]", "http://localhost:9222").size).toBe(0);
    expect([...c("0.0.0.0", "http://0.0.0.0:9222")]).toEqual(["cdp-public-bind"]);
    expect([...c("127.0.0.1", "*")]).toEqual(["cdp-any-origin"]);
    expect(c("10.0.0.5", "*")).toEqual(new Set(["cdp-public-bind", "cdp-any-origin"]));
  });
});

describe("emitWarnings", () => {
  const saved = process.env.CLEARCOTE_NO_WARN;
  afterEach(() => {
    vi.restoreAllMocks();
    if (saved === undefined) delete process.env.CLEARCOTE_NO_WARN;
    else process.env.CLEARCOTE_NO_WARN = saved;
  });

  it("prints unless quiet or CLEARCOTE_NO_WARN", () => {
    delete process.env.CLEARCOTE_NO_WARN;
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    emitWarnings(serveExposureWarnings("0.0.0.0", "*"), true);
    expect(spy).not.toHaveBeenCalled();
    emitWarnings(serveExposureWarnings("0.0.0.0", "*"));
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockClear();
    process.env.CLEARCOTE_NO_WARN = "1";
    emitWarnings(serveExposureWarnings("0.0.0.0", "*"));
    expect(spy).not.toHaveBeenCalled();
  });
});
