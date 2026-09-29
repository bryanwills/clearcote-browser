#!/usr/bin/env node
// Release smoke test (Node side): actually launch the browser and prove the engine starts.
//
//   node smoke_launch.mjs free   # the open build, keyless
//   node smoke_launch.mjs pro    # the licensed build, with CCKEY (or CLEARCOTE_LICENSE_KEY)
//   node smoke_launch.mjs        # both, in this order (the old behaviour)
//
// Launches headless and reads a real navigator.userAgent (proves the process started AND runs JS).
// Exits non-zero on ANY failure so a release pipeline can gate on it. Imports whatever `clearcote` is
// installed in the current directory's node_modules, so run it after `npm i clearcote@X`.
// See docs/RELEASE-SMOKE-TEST.md.
//
// A FREE run must really be keyless: the SDK reads CLEARCOTE_LICENSE_KEY and ~/.clearcote/license.key
// on its own, so smoke-release.sh starts it with neither. As a guard, a FREE run whose Chrome major is
// not the SDK's pinned open build fails — that is what a key leaking into it looks like.

import os from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let launch, RELEASE;
try {
  ({ launch, RELEASE } = await import("clearcote"));
} catch (e) {
  console.log(`[NODE] import clearcote FAILED: ${e?.message ?? e}`);
  process.exit(2);
}

// The package's exports map does not expose package.json, so read the installed copy directly.
let sdkVersion = "?";
try {
  sdkVersion = JSON.parse(readFileSync(join(process.cwd(), "node_modules", "clearcote", "package.json"), "utf8")).version;
} catch {}
const PIN = String(RELEASE?.version ?? "?");
const PIN_MAJOR = PIN.split(".")[0];

async function run(tier, key) {
  const kw = key ? { licenseKey: key } : {};
  try {
    const b = await launch({ headless: true, args: ["--no-sandbox"], quiet: true, ...kw });
    const p = await b.newPage();
    const ua = await p.evaluate(() => navigator.userAgent);
    await b.close();
    const major = (ua.match(/Chrome\/(\d+)/) || [])[1] ?? "?";
    let ok = ua.includes("Chrome");
    let why = "";
    if (ok && tier.trim() === "FREE" && major !== PIN_MAJOR) {
      ok = false;
      why = ` — expected the pinned open build ${PIN_MAJOR}; a licence key reached the free run?`;
    }
    console.log(`[NODE ${os.platform()}] ${tier}: ${ok ? "LAUNCH_OK" : "LAUNCH_FAIL"} | Chrome/${major} | ${ua.slice(0, 58)}${why}`);
    return ok;
  } catch (e) {
    console.log(`[NODE ${os.platform()}] ${tier}: LAUNCH_FAIL (${e?.message ?? e})`);
    return false;
  }
}

const tier = (process.argv[2] || "both").toLowerCase();
if (!["free", "pro", "both"].includes(tier)) {
  console.log("usage: node smoke_launch.mjs [free|pro|both]");
  process.exit(2);
}
const key = process.env.CCKEY || process.env.CLEARCOTE_LICENSE_KEY;
console.log(`[NODE] clearcote ${sdkVersion} (pins open build ${PIN}) on ${os.platform()} node ${process.version}`);

const results = [];
if (tier === "free" || tier === "both") results.push(await run("FREE", undefined));
if (tier === "pro" || tier === "both") {
  if (key) results.push(await run("PRO ", key));
  else console.log("[NODE] PRO : SKIPPED (set CCKEY or CLEARCOTE_LICENSE_KEY to test the licensed build)");
}

process.exit(results.every(Boolean) ? 0 : 1);
