// clearcote — manage the browser binary, diagnose a setup, save a licence key, run a CDP endpoint.
//
//   clearcote install [--version 152] [--channel preview]   download + verify the binary
//   clearcote info    [--quick] [--json] [--proxy URL]      diagnostics (alias: doctor)
//   clearcote update  [--channel preview]                   fetch a newer build if one exists
//   clearcote clear-cache                                   delete every cached binary
//   clearcote login   [key]                                 save a licence key (validated first)
//   clearcote logout                                        remove the saved key
//   clearcote serve   [--port 9222] [--idle-timeout 300] …  multi-identity CDP endpoint
//
// `info` never downloads: it reports what is already cached and what a launch would resolve to.

import { parseArgs } from "node:util";
import * as readline from "node:readline";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import {
  download,
  launch,
  getSessionSeats,
  saveLicenseKey,
  removeLicenseKey,
  licenseKeySource,
  licenseKeyPath,
  resolveLicenseKey,
  resolveGeoDetailed,
  resolveReleaseChannel,
  engineSupportsSwitch,
  serveMultiplex,
  RELEASE,
  type SessionSeats,
} from "./index.js";
import { defaultCacheRoot, listCachedBuilds } from "./download.js";
import { geoCacheRoot } from "./geoip.js";
import { GATED_ENGINE_SWITCHES } from "./launchopts.js";
import { toProxySpec } from "./net.js";

const SDK_VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
  } catch {
    return "unknown";
  }
})();

export const USAGE = `clearcote ${SDK_VERSION} — manage and diagnose the Clearcote browser.

USAGE
  clearcote install [--version <v>] [--channel stable|preview]
  clearcote info [--quick] [--json] [--proxy <url>]      (alias: doctor)
  clearcote update [--channel stable|preview]
  clearcote clear-cache
  clearcote login [key]
  clearcote logout
  clearcote serve [--port 9222] [--host 127.0.0.1] [--idle-timeout <s>] [--data-dir <dir>]
                  [--max-browsers 16] [--allow-origin <origin>]... [--allow-host <name>]... [--headed]
                  [--fingerprint <seed>] [--platform <os>] [--proxy <url>] [--timezone <tz>]
                  [--accept-language <l>] [--geoip]

INFO FLAGS
  --quick          skip everything that needs the network or a launch (seat count, launch test)
  --json           machine-readable output
  --proxy <url>    resolve the exit IP, timezone and language a launch through this proxy would use

ENVIRONMENT
  CLEARCOTE_LICENSE_KEY, CLEARCOTE_RELEASE_CHANNEL, CLEARCOTE_GEOIP_TIMEOUT_SECONDS,
  CLEARCOTE_LICENSE_THROUGH_PROXY, CLEARCOTE_BINARY, CLEARCOTE_CACHE, CLEARCOTE_SERVE_IDLE_TIMEOUT`;

function out(line = ""): void {
  process.stdout.write(line + "\n");
}

function fail(msg: string, code = 1): never {
  process.stderr.write(`clearcote: ${msg}\n`);
  process.exit(code);
}

/** What `info` reports. Also the `--json` shape. */
export interface InfoReport {
  sdk: { version: string; node: string; platform: string };
  license: { source: string; key?: string; seats?: SessionSeats };
  binary: {
    source: "CLEARCOTE_BINARY" | "cache" | "none";
    path?: string;
    tag?: string;
    cached: Array<{ tag: string; path: string }>;
    pinnedFree: string;
    releaseChannel: string;
  };
  engineFeatures?: Record<string, boolean>;
  launch?: { tested: boolean; ok?: boolean; version?: string; error?: string; missingLibs?: string[]; reason?: string };
  fonts?: { bundled: boolean; note: string };
  geoip: { databaseCached: boolean; path: string; proxy?: { exitIp?: string; country?: string; timezone?: string; acceptLanguage?: string; error?: string } };
}

function geoDbPath(): string {
  return join(geoCacheRoot(), "geoip-aio-all.mmdb");
}

function missingSharedLibs(exe: string): string[] {
  if (process.platform !== "linux") return [];
  const r = spawnSync("ldd", ["--", exe], { encoding: "utf8" });
  return (r.stdout || "").split("\n").filter((l) => l.includes("not found")).map((l) => l.trim().split(" ")[0]);
}

export async function buildInfo(flags: { quick?: boolean; proxy?: string }): Promise<InfoReport> {
  const src = licenseKeySource();
  let channel: string;
  try {
    channel = resolveReleaseChannel();
  } catch (e) {
    channel = `invalid (${(e as Error).message})`;
  }
  const cached = listCachedBuilds();
  const envBinary = process.env.CLEARCOTE_BINARY;
  const pick = envBinary ? { path: envBinary } : cached[0];
  const report: InfoReport = {
    sdk: { version: SDK_VERSION, node: process.version, platform: `${process.platform}-${process.arch}` },
    license: { source: src.source, ...(src.masked ? { key: src.masked } : {}) },
    binary: {
      source: envBinary ? "CLEARCOTE_BINARY" : pick ? "cache" : "none",
      ...(pick ? { path: pick.path } : {}),
      ...(!envBinary && pick ? { tag: (pick as { tag: string }).tag } : {}),
      cached,
      pinnedFree: `${RELEASE.version} (${RELEASE.tag})`,
      releaseChannel: channel,
    },
    geoip: { databaseCached: existsSync(geoDbPath()), path: geoDbPath() },
  };

  if (pick && existsSync(pick.path)) {
    report.engineFeatures = Object.fromEntries(
      ["proxy-auth", "socks5-credentials", "socks5-udp", ...Object.keys(GATED_ENGINE_SWITCHES).map((s) => s.slice(2))]
        .map((name) => [name, engineSupportsSwitch(pick.path, name)]),
    );
  }

  if (process.platform === "linux" && pick) {
    const template = join(dirname(pick.path), "fonts", "fonts.conf.template");
    report.fonts = existsSync(template)
      ? { bundled: true, note: "metric-compatible Windows font clones are bundled with this build" }
      : { bundled: false, note: "this build ships no font bundle; a Windows persona on this host may render with Linux fonts" };
  }

  if (!flags.quick && src.source !== "none") {
    report.license.seats = await getSessionSeats();
  }

  if (flags.quick) {
    report.launch = { tested: false, reason: "skipped (--quick)" };
  } else if (!pick) {
    report.launch = { tested: false, reason: "no binary installed — run: clearcote install" };
  } else {
    try {
      const b = await launch({ executablePath: pick.path, headless: true, quiet: true, ephemeralProfile: false });
      const version = b.version();
      await b.close();
      report.launch = { tested: true, ok: true, version };
    } catch (e) {
      const libs = missingSharedLibs(pick.path);
      report.launch = { tested: true, ok: false, error: (e as Error).message.split("\n")[0], ...(libs.length ? { missingLibs: libs } : {}) };
    }
  }

  if (flags.proxy) {
    const r = await resolveGeoDetailed(flags.proxy, { quiet: true });
    report.geoip.proxy = r.geo && r.geo.timezone
      ? { exitIp: r.geo.ip, country: r.geo.country, timezone: r.geo.timezone, acceptLanguage: r.geo.acceptLanguage }
      : { error: r.reason };
  }
  return report;
}

function printInfo(r: InfoReport): void {
  const ok = (b: boolean | undefined) => (b ? "yes" : "no");
  out(`clearcote SDK   ${r.sdk.version}  (node ${r.sdk.node}, ${r.sdk.platform})`);
  out(`Licence         ${r.license.source === "none" ? "none (free build)" : `${r.license.key} from ${r.license.source}`}`);
  const seats = r.license.seats;
  if (seats) {
    if (seats.state === "ok") out(`Seats           ${seats.used} of ${seats.limit ?? "unlimited"} in use${seats.plan ? `  (plan: ${seats.plan})` : ""}`);
    else out(`Seats           unavailable: ${seats.reason ?? seats.state}`);
  }
  out(`Binary          ${r.binary.path ? `${r.binary.path}${r.binary.tag ? `  [${r.binary.tag}]` : ""} (${r.binary.source})` : "not installed — run: clearcote install"}`);
  out(`Release channel ${r.binary.releaseChannel}`);
  out(`Free pin        ${r.binary.pinnedFree}`);
  if (r.binary.cached.length > 1) out(`Also cached     ${r.binary.cached.slice(1).map((c) => c.tag).join(", ")}`);
  if (r.engineFeatures) {
    out(`Engine support  ${Object.entries(r.engineFeatures).map(([k, v]) => `${k}=${ok(v)}`).join("  ")}`);
  }
  if (r.launch) {
    if (!r.launch.tested) out(`Launch test     ${r.launch.reason}`);
    else if (r.launch.ok) out(`Launch test     ok (${r.launch.version})`);
    else {
      out(`Launch test     FAILED: ${r.launch.error}`);
      for (const lib of r.launch.missingLibs ?? []) out(`                missing library: ${lib}`);
    }
  }
  if (r.fonts) out(`Fonts           ${r.fonts.note}`);
  out(`GeoIP database  ${r.geoip.databaseCached ? "cached" : "not cached (downloaded on first geoip launch)"}`);
  if (r.geoip.proxy) {
    const p = r.geoip.proxy;
    out(p.error ? `Proxy geo       FAILED: ${p.error}` : `Proxy geo       exit ${p.exitIp} (${p.country})  timezone ${p.timezone}  language ${p.acceptLanguage}`);
  }
}

async function promptKey(): Promise<string> {
  if (!process.stdin.isTTY) {
    fail("no key given. Run `clearcote login <key>`, or copy a key from https://www.clearcotelabs.com/dashboard/licenses");
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const key = await new Promise<string>((resolve) =>
    rl.question("Paste your licence key (https://www.clearcotelabs.com/dashboard/licenses): ", (a) => resolve(a)),
  );
  rl.close();
  return key.trim();
}

function dirSize(p: string): number {
  let total = 0;
  try {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, e.name);
      total += e.isDirectory() ? dirSize(full) : statSync(full).size;
    }
  } catch { /* unreadable — skip */ }
  return total;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    out(USAGE);
    return;
  }
  if (cmd === "version" || cmd === "--version") {
    out(SDK_VERSION);
    return;
  }

  if (cmd === "info" || cmd === "doctor") {
    const { values } = parseArgs({ args: rest, options: { quick: { type: "boolean" }, "no-launch": { type: "boolean" }, json: { type: "boolean" }, proxy: { type: "string" } } });
    const report = await buildInfo({ quick: !!(values.quick || values["no-launch"]), proxy: values.proxy });
    if (values.json) out(JSON.stringify(report, null, 2));
    else printInfo(report);
    return;
  }

  if (cmd === "install" || cmd === "update") {
    const { values } = parseArgs({ args: rest, options: { version: { type: "string" }, channel: { type: "string" } } });
    const releaseChannel = resolveReleaseChannel(values.channel);
    const licenseKey = resolveLicenseKey();
    const path = await download({
      version: values.version,
      releaseChannel,
      licenseKey,
      // update: re-resolve the newest build instead of reusing the SDK's pin (free) — PRO always asks the server
      ...(cmd === "update" ? { autoUpdate: true } : {}),
    });
    out(path);
    return;
  }

  if (cmd === "clear-cache") {
    const root = defaultCacheRoot();
    if (!existsSync(root)) {
      out(`nothing to clear (${root} does not exist)`);
      return;
    }
    // Only build directories: a CLEARCOTE_CACHE pointing at $HOME or a shared directory must not
    // become `rm -rf` of that directory. A build dir carries a .verified marker once complete; a
    // half-finished download has the build-tag name but no marker yet.
    let bytes = 0;
    const removed: string[] = [];
    for (const name of readdirSync(root)) {
      const dir = join(root, name);
      let isDir = false;
      try { isDir = statSync(dir).isDirectory(); } catch { /* vanished */ }
      if (!isDir) continue;
      if (!existsSync(join(dir, ".verified")) && !/^(pro-\d|v\d)/.test(name)) continue;
      bytes += dirSize(dir);
      rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    }
    out(removed.length
      ? `removed ${removed.length} cached build${removed.length === 1 ? "" : "s"} from ${root} (${(bytes / 1e6).toFixed(0)} MB)`
      : `no cached builds in ${root}`);
    return;
  }

  if (cmd === "login") {
    const key = rest[0] ?? (await promptKey());
    if (!key) fail("empty key");
    const seats = await getSessionSeats({ licenseKey: key });
    if (seats.state === "invalid") fail(`the licence server rejected this key (${seats.reason}). Nothing was saved.`);
    const where = saveLicenseKey(key);
    out(`saved to ${where}`);
    if (seats.state === "ok") out(`valid: ${seats.used} of ${seats.limit ?? "unlimited"} seats in use${seats.plan ? `, plan ${seats.plan}` : ""}`);
    else out(`note: could not confirm the key right now (${seats.reason}); it was saved anyway`);
    return;
  }

  if (cmd === "logout") {
    const removed = removeLicenseKey();
    out(removed ? `removed ${licenseKeyPath()}` : "no saved key");
    if (process.env.CLEARCOTE_LICENSE_KEY) out("note: CLEARCOTE_LICENSE_KEY is still set in this environment and will keep being used");
    return;
  }

  if (cmd === "serve") {
    const { values } = parseArgs({
      args: rest,
      options: {
        port: { type: "string" }, host: { type: "string" }, "idle-timeout": { type: "string" }, "data-dir": { type: "string" },
        "max-browsers": { type: "string" }, "allow-origin": { type: "string", multiple: true }, "allow-host": { type: "string", multiple: true }, headed: { type: "boolean" },
        fingerprint: { type: "string" }, platform: { type: "string" }, proxy: { type: "string" }, timezone: { type: "string" },
        "accept-language": { type: "string" }, geoip: { type: "boolean" }, quiet: { type: "boolean" },
      },
    });
    const num = (name: string, v: string | undefined): number | undefined => {
      if (v === undefined) return undefined;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) fail(`--${name} must be a non-negative number`);
      return n;
    };
    const srv = await serveMultiplex({
      port: num("port", values.port) ?? 9222,
      host: values.host,
      idleTimeoutSec: num("idle-timeout", values["idle-timeout"]),
      dataDir: values["data-dir"],
      maxBrowsers: num("max-browsers", values["max-browsers"]),
      allowOrigins: values["allow-origin"],
      allowHosts: values["allow-host"],
      headless: !values.headed,
      quiet: values.quiet,
      ...(values.fingerprint ? { fingerprint: values.fingerprint } : {}),
      ...(values.platform ? { platform: values.platform as "windows" | "linux" | "macos" | "android" } : {}),
      // Split user:pass out of the URL: Chromium rejects a --proxy-server that carries credentials
      // and goes DIRECT, so passing the URL through whole leaked the host's real IP.
      ...(values.proxy ? { proxy: proxyOption(values.proxy) } : {}),
      ...(values.timezone ? { timezone: values.timezone } : {}),
      ...(values["accept-language"] ? { acceptLanguage: values["accept-language"] } : {}),
      ...(values.geoip ? { geoip: true } : {}),
    });
    const stop = () => { void srv.close().then(() => process.exit(0)); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return; // keep running
  }

  fail(`unknown command '${cmd}'. Run \`clearcote --help\`.`, 2);
}

/** `--proxy scheme://user:pass@host:port` as a launch proxy option with the credentials split out. */
export function proxyOption(url: string): { server: string; username?: string; password?: string } {
  let spec;
  try { spec = toProxySpec(url); } catch { spec = null; }
  if (!spec) fail(`--proxy must be a URL such as http://user:pass@host:8080 or socks5://host:1080`);
  return { server: spec.server, ...(spec.username ? { username: spec.username } : {}), ...(spec.password ? { password: spec.password } : {}) };
}
