#!/usr/bin/env node
/**
 * Re-derive the headless screen-profile table used by all three SDKs
 * (sdk/python/clearcote/_geometry.py, sdk/node/src/geometry.ts, sdk/dotnet/src/Clearcote/Geometry.cs)
 * from the real captures in `audit_profiles`.
 *
 * READ-ONLY: issues SELECTs and nothing else. `audit_profiles` is the ground-truth corpus every
 * persona table is derived from; never write to it.
 *
 * Usage (credentials come from the environment, never from this file):
 *
 *   DB_HOST=... DB_USER=... DB_PASSWORD=... DB_DATABASE=... [DB_PORT=3306] [DB_SSL=true] \
 *     node scripts/derive-headless-geometry.cjs
 *
 * Needs `mysql2` resolvable (npm i mysql2, or run from a workspace that has it).
 *
 * WHAT IT COMPUTES, and why each filter is there:
 *
 *  - Desktop captures only; mobile/tablet geometry is a different persona problem.
 *  - Drops captures whose own geometry is incoherent (inner > outer > avail > screen violations).
 *    Those are mostly other automation tools; keeping them would teach the table to imitate bots.
 *  - Drops captures where screen == inner exactly: that is the emulated-viewport signature, i.e. a
 *    headless browser (including our own pre-fix launches). Same reason.
 *  - Counts DISTINCT /24 rather than captures, so one busy machine cannot skew the weighting. In the
 *    corpus a single Mac contributed 98 of 432 coherent captures.
 *  - Reports the frame delta (outer - inner) distribution, which is what the engine has to reproduce,
 *    and the taskbar delta (screen.height - avail.height).
 *  - Reports the avail == screen share, because CDP cannot spoof avail separately from screen: that
 *    subset is the only shape a no-persona headless launch can reproduce exactly.
 *
 * The committed tables additionally drop macOS rows (color_depth 30, unspoofable on this engine) and
 * non-1.0 DPR rows, and cap ultrawide 3440x1440 to weight 2 — an audit site's visitors
 * over-represent ultrawides relative to the web. Those three are judgement calls, not data; they are
 * documented in each SDK's geometry module and must be re-applied by hand after re-running this.
 */
const mysql = require("mysql2/promise");

const REQUIRED = ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_DATABASE"];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`missing env: ${missing.join(", ")}\nsee the usage block at the top of this file`);
  process.exit(2);
}

const mode = (xs) => {
  const c = new Map();
  for (const x of xs) c.set(x, (c.get(x) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1]);
};
const net24 = (ip) =>
  (ip || "").includes(":")
    ? (ip || "").split(":").slice(0, 3).join(":") + "::/48"
    : (ip || "").split(".").slice(0, 3).join(".") + ".0/24";

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    port: Number(process.env.DB_PORT || 3306),
    ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  });
  const [rows] = await conn.query(
    "SELECT os_family, ip, profile FROM audit_profiles WHERE device_class = 'desktop'");
  await conn.end();

  const real = [];
  let unparsed = 0;
  for (const r of rows) {
    let p;
    try { p = JSON.parse(r.profile); } catch { unparsed++; continue; }
    const s = p.screen || {};
    const q = {
      os: (r.os_family || "").toLowerCase(), net: net24(r.ip),
      sw: s.width, sh: s.height, aw: s.avail_width, ah: s.avail_height,
      iw: s.inner_width, ih: s.inner_height, ow: s.outer_width, oh: s.outer_height,
      dpr: s.device_pixel_ratio, cd: s.color_depth,
    };
    if ([q.sw, q.sh, q.aw, q.ah, q.iw, q.ih, q.ow, q.oh, q.dpr].some((v) => typeof v !== "number")) continue;
    const coherent = q.iw <= q.ow && q.ih <= q.oh && q.ow <= q.aw && q.oh <= q.ah
      && q.aw <= q.sw && q.ah <= q.sh;
    if (!coherent) continue;
    if (q.sw === q.iw && q.sh === q.ih) continue;   // emulated-viewport (headless) signature
    real.push(q);
  }

  const byScreen = new Map();
  for (const q of real) {
    const k = `${q.sw}x${q.sh}@${q.dpr}`;
    if (!byScreen.has(k)) byScreen.set(k, { nets: new Set(), n: 0, os: [], cd: [], availEq: 0 });
    const g = byScreen.get(k);
    g.nets.add(q.net); g.n++; g.os.push(q.os); g.cd.push(q.cd);
    if (q.aw === q.sw && q.ah === q.sh) g.availEq++;
  }

  console.log(`desktop rows ${rows.length}, unparsed ${unparsed}, coherent non-emulated ${real.length}, ` +
    `distinct /24 ${new Set(real.map((q) => q.net)).size}`);
  console.log("\nscreen@dpr        /24s  caps  os        depth  avail==screen   <- weight = /24s");
  for (const [k, g] of [...byScreen.entries()].sort((a, b) => b[1].nets.size - a[1].nets.size || b[1].n - a[1].n)) {
    console.log(`  ${k.padEnd(16)} ${String(g.nets.size).padEnd(5)} ${String(g.n).padEnd(5)} ` +
      `${String(mode(g.os)[0][0]).padEnd(9)} ${String(mode(g.cd)[0][0]).padEnd(6)} ${g.availEq}/${g.n}`);
  }

  const availEq = real.filter((q) => q.aw === q.sw && q.ah === q.sh);
  console.log(`\navail == screen: ${availEq.length}/${real.length} captures, ` +
    `${new Set(availEq.map((q) => q.net)).size}/${new Set(real.map((q) => q.net)).size} networks ` +
    `(the only shape a no-persona headless launch can reproduce — CDP ties avail to screen)`);
  console.log(`frame delta (outer-inner) dx: ${JSON.stringify(mode(real.map((q) => q.ow - q.iw)).slice(0, 6))}`);
  console.log(`frame delta (outer-inner) dy: ${JSON.stringify(mode(real.map((q) => q.oh - q.ih)).slice(0, 6))}`);
  console.log(`taskbar (screen.h-avail.h):   ${JSON.stringify(mode(real.map((q) => q.sh - q.ah)).slice(0, 6))}`);
  const maximized = real.filter((q) => Math.abs(q.ow - q.aw) <= 2 && Math.abs(q.oh - q.ah) <= 2).length;
  console.log(`maximized windows: ${maximized}/${real.length}`);
})().catch((e) => { console.error("failed:", e.message); process.exit(1); });
