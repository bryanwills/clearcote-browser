import { describe, it, expect } from "vitest";
import { IsolatedWorld, worldFor, ISO_IS_FOCUSED, ISO_VIEWPORT } from "../src/isolated.js";

// Humanize's DOM reads run in an isolated world, never the page's (mirrors
// sdk/python/tests/test_isolated.py).
class FakeCdp {
  calls: [string, any][] = [];
  nextCtx = 7;
  constructor(public values: unknown[] = [], public staleOnce = false, public throwOn = "") {}
  async send(method: string, params?: any): Promise<any> {
    this.calls.push([method, params]);
    if (method === this.throwOn) throw new Error("boom");
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "MAIN" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: ++this.nextCtx };
    if (method === "Runtime.evaluate") {
      if (this.staleOnce) { this.staleOnce = false; throw new Error("Cannot find context with specified id"); }
      return { result: { value: this.values.shift() } };
    }
    throw new Error(method);
  }
}

const fakePage = (cdp: FakeCdp) => {
  let sessions = 0;
  return {
    sessions: () => sessions,
    context: () => ({ newCDPSession: async () => { sessions++; return cdp; } }),
    evaluate: () => { throw new Error("humanize must not evaluate in the page's world"); },
  };
};

describe("IsolatedWorld", () => {
  it("evaluates in an isolated world of the main frame, without Runtime.enable", async () => {
    const cdp = new FakeCdp([[1280, 720], true]);
    const w = new IsolatedWorld(fakePage(cdp));
    expect(await w.evaluate(ISO_VIEWPORT)).toEqual([1280, 720]);
    expect(await w.evaluate(ISO_IS_FOCUSED, "#q")).toBe(true);
    expect(cdp.calls.map(([m]) => m)).toEqual(
      ["Page.getFrameTree", "Page.createIsolatedWorld", "Runtime.evaluate", "Runtime.evaluate"]);
    expect(cdp.calls[1][1]).toEqual({ frameId: "MAIN" });
    const ev = cdp.calls[3][1];
    expect(ev.contextId).toBe(8);
    expect(ev.returnByValue).toBe(true);
    expect(ev.expression).toBe(`(${ISO_IS_FOCUSED})(${JSON.stringify("#q")})`);
  });

  it("re-creates the world after a navigation", async () => {
    const cdp = new FakeCdp([[800, 600]], true);
    expect(await new IsolatedWorld(fakePage(cdp)).evaluate(ISO_VIEWPORT)).toEqual([800, 600]);
    expect(cdp.calls.filter(([m]) => m === "Page.createIsolatedWorld").length).toBe(2);
    expect(cdp.calls.at(-1)![1].contextId).toBe(9);
  });

  it("resolves undefined instead of touching the page world", async () => {
    const noCdp = { context: () => ({ newCDPSession: async () => { throw new Error("no cdp"); } }),
      evaluate: () => { throw new Error("must not fall back to page.evaluate"); } };
    expect(await new IsolatedWorld(noCdp).evaluate(ISO_VIEWPORT)).toBeUndefined();
    const scriptError = new FakeCdp();
    scriptError.send = async (m: string) =>
      m === "Runtime.evaluate" ? { exceptionDetails: { text: "SyntaxError" } }
        : m === "Page.getFrameTree" ? { frameTree: { frame: { id: "MAIN" } } } : { executionContextId: 1 };
    expect(await new IsolatedWorld(fakePage(scriptError)).evaluate(ISO_VIEWPORT)).toBeUndefined();
  });

  it("keeps one world (and one CDP session) per page", async () => {
    const page = fakePage(new FakeCdp([1, 2]));
    expect(worldFor(page)).toBe(worldFor(page));
    await worldFor(page).evaluate(ISO_VIEWPORT);
    await worldFor(page).evaluate(ISO_VIEWPORT);
    expect(page.sessions()).toBe(1);
  });
});
