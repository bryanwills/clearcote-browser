import { describe, it, expect } from "vitest";
import { attachHumanize, needsShift } from "../src/humanize.js";

// Capitals and shifted symbols go behind a real ShiftLeft (mirrors the Python
// test_humanize_types_capitals_and_symbols_behind_a_real_shift). r28 sent "A" and "!" with
// shiftKey=false and no Shift keydown at all.
const fakePage = (withDownUp = true) => {
  const noop = async () => undefined;
  const events: [string, string][] = [];
  const keyboard: Record<string, unknown> = {
    type: async (t: string) => { events.push(["type", t]); },
    press: async (k: string) => { events.push(["press", k]); },
    insertText: noop,
  };
  if (withDownUp) {
    keyboard.down = async (k: string) => { events.push(["down", k]); };
    keyboard.up = async (k: string) => { events.push(["up", k]); };
  }
  const locatorProto = {
    fill: noop, click: noop, type: noop, dblclick: noop, hover: noop, press: noop,
    pressSequentially: noop, clear: noop, tap: noop, check: noop, uncheck: noop,
    dragTo: noop, page: () => null,
  };
  const page = {
    mouse: { move: noop, click: noop, wheel: noop, down: noop, up: noop },
    keyboard,
    click: noop, hover: noop, dblclick: noop, fill: noop, press: noop, type: noop,
    focus: noop, evaluate: async () => undefined, on: () => undefined,
    mainFrame: () => ({}), waitForTimeout: noop,
    locator: () => Object.create(locatorProto),
  };
  return { page: page as never, events };
};

describe("humanized typing and Shift", () => {
  it("holds ShiftLeft around capitals and shifted symbols, across a run", async () => {
    const { page, events } = fakePage();
    await attachHumanize({} as never, page, { humanize: true, seed: "t" });
    await (page as any).keyboard.type("Ab!?c");
    expect(events.filter(([, k]) => ["Shift", "A", "b", "!", "?", "c"].includes(k))).toEqual([
      ["down", "Shift"], ["press", "A"], ["up", "Shift"],
      ["press", "b"],
      ["down", "Shift"], ["press", "!"], ["press", "?"], ["up", "Shift"],
      ["press", "c"],
    ]);
  });

  it("releases Shift when the text ends on a capital", async () => {
    const { page, events } = fakePage();
    await attachHumanize({} as never, page, { humanize: true, seed: "t" });
    await (page as any).keyboard.type("aB");
    expect(events.slice(-2)).toEqual([["press", "B"], ["up", "Shift"]]);
  });

  it("types without Shift when the keyboard has no down/up", async () => {
    const { page, events } = fakePage(false);
    await attachHumanize({} as never, page, { humanize: true, seed: "t" });
    await (page as any).keyboard.type("Ab");
    expect(events.filter(([, k]) => k === "A" || k === "b")).toEqual([["press", "A"], ["press", "b"]]);
  });

  it("knows the US layout's shifted characters", () => {
    for (const c of 'AZ~!@#$%^&*()_+{}|:"<>?') expect(needsShift(c), c).toBe(true);
    for (const c of "az09`-=[];',./ \t\\ö") expect(needsShift(c), c).toBe(false);
  });
});
