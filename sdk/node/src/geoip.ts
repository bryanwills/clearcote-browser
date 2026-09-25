// geoip: resolve the egress IP's geo (timezone + lat/lon + language) so the browser matches the
// proxy actually in use — the way Camoufox does it. Primary source is daijro's offline
// "geoip-all-in-one" MaxMind DB (more accurate than a single online API; merges IP2Location +
// GeoLite2 + DB-IP, timezone computed from coordinates). Flow: discover the exit IP via a small
// IP-echo *through the proxy*, then look that IP up in the cached .mmdb. Falls back to ip-api.com
// (direct geo through the proxy) if the DB can't be fetched/opened.
//
// The .mmdb (GPL-3.0 data) is downloaded + cached on first use (≈52 MB zip → ≈120 MB), NOT bundled.
// The exit-IP and ip-api lookups go THROUGH the proxy (HTTP or SOCKS5, see ./net.ts); we never fall
// back to the local IP under a proxy, which would give the wrong region.
//
// Budget: CLEARCOTE_GEOIP_TIMEOUT_SECONDS (default 20) bounds the whole resolution. A lookup that
// runs out of budget fails rather than hanging a launch.

import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import extract from "extract-zip";
import maxmind, { type Reader } from "maxmind";
import { PROXIED_REQUEST_SCHEMES, proxiedRequest, toProxySpec, type ProxySpec } from "./net.js";

const MMDB_URL = "https://github.com/daijro/geoip-all-in-one/releases/latest/download/geoip-aio-all.mmdb.zip";
const MMDB_MAX_AGE_DAYS = 30;
const IPECHO_URLS = ["http://api.ipify.org", "http://ip-api.com/line/?fields=query"];
const IPAPI_URL = "http://ip-api.com/json/?fields=status,message,countryCode,timezone,lat,lon,query";

export interface Geo {
  ip?: string;
  country?: string;
  timezone?: string;
  acceptLanguage?: string;
  location?: string; // "lat,lon"
}

function log(quiet: boolean | undefined, m: string): void {
  if (!quiet) process.stderr.write(`[clearcote] ${m}\n`);
}

/** Where the geoip database is cached (CLEARCOTE_CACHE/geoip when set). */
export function geoCacheRoot(): string {
  if (process.env.CLEARCOTE_CACHE) return path.join(process.env.CLEARCOTE_CACHE, "geoip");
  if (process.platform === "win32")
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "clearcote", "geoip");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "clearcote", "geoip");
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "clearcote", "geoip");
}

/** Whole-resolution budget in ms: CLEARCOTE_GEOIP_TIMEOUT_SECONDS (seconds, > 0), default 20s. */
export function geoipTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.CLEARCOTE_GEOIP_TIMEOUT_SECONDS ?? "").trim();
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 20_000;
}

async function getText(url: string, proxy: ProxySpec | null, timeoutMs: number): Promise<string> {
  const res = await proxiedRequest(url, { proxy, timeoutMs: Math.max(1, timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.text()).trim();
}

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-f:]+$/i;
function looksLikeIp(s: string): boolean {
  return IPV4.test(s) || (s.includes(":") && IPV6.test(s));
}

/** Discover the egress IP via an IP-echo through the proxy (or direct), within `deadline`. */
async function exitIp(proxy: ProxySpec | null, deadline: number, quiet?: boolean): Promise<string | null> {
  for (const url of IPECHO_URLS) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    try {
      const ip = (await getText(url, proxy, Math.min(left, 8000))).split(/\s+/)[0];
      if (looksLikeIp(ip)) return ip;
    } catch {
      /* try next */
    }
  }
  log(quiet, "geoip: could not determine the exit IP");
  return null;
}

let _mmdbInflight: Promise<string | null> | null = null;
async function ensureMmdb(quiet?: boolean): Promise<string | null> {
  const dir = geoCacheRoot();
  const file = path.join(dir, "geoip-aio-all.mmdb");
  if (existsSync(file)) {
    const ageDays = (Date.now() - statSync(file).mtimeMs) / 86_400_000;
    if (ageDays < MMDB_MAX_AGE_DAYS) return file;
  }
  if (_mmdbInflight) return _mmdbInflight;
  _mmdbInflight = (async () => {
    try {
      mkdirSync(dir, { recursive: true });
      const zip = path.join(dir, "geoip-aio-all.mmdb.zip");
      log(quiet, "geoip: downloading the geoip-all-in-one database (~52 MB, first run only)");
      const res = await fetch(MMDB_URL, { redirect: "follow" });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body as any), createWriteStream(zip));
      const tmp = path.join(dir, ".extract");
      rmSync(tmp, { recursive: true, force: true });
      await extract(zip, { dir: tmp });
      const found = findMmdb(tmp);
      if (!found) throw new Error("no .mmdb in archive");
      rmSync(file, { force: true });
      // move (rename across same dir)
      const fs = await import("node:fs");
      fs.renameSync(found, file);
      rmSync(zip, { force: true });
      rmSync(tmp, { recursive: true, force: true });
      log(quiet, "geoip: database ready");
      return file;
    } catch (e) {
      log(quiet, `geoip: database fetch failed (${(e as Error).message}) — falling back to ip-api`);
      return null;
    } finally {
      _mmdbInflight = null;
    }
  })();
  return _mmdbInflight;
}

function findMmdb(dir: string): string | null {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop() as string;
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.toLowerCase().endsWith(".mmdb")) return full;
    }
  }
  return null;
}

let _reader: Reader<any> | null = null;
async function mmdbLookup(ip: string, deadline: number, quiet?: boolean): Promise<Geo | null> {
  // The first-run database download (~52 MB) may outlast the budget. It keeps going in the
  // background and caches for the next launch; this launch falls back to ip-api instead of waiting.
  const left = deadline - Date.now();
  if (left <= 0) return null;
  let timer: NodeJS.Timeout | undefined;
  const file = await Promise.race([
    ensureMmdb(quiet),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), left); }),
  ]);
  if (timer) clearTimeout(timer);
  if (!file) return null;
  try {
    if (!_reader) _reader = await maxmind.open(file);
    const rec: any = _reader.get(ip);
    if (!rec) return null;
    const country: string | undefined = rec?.country?.iso_code;
    const lat = rec?.location?.latitude;
    const lon = rec?.location?.longitude;
    const tz: string | undefined = rec?.location?.time_zone;
    if (!tz && lat == null) return null;
    return {
      ip,
      country,
      timezone: tz,
      acceptLanguage: acceptLanguageForCountry(country),
      location: lat != null && lon != null ? `${lat},${lon}` : undefined,
    };
  } catch (e) {
    log(quiet, `geoip: mmdb read failed (${(e as Error).message})`);
    return null;
  }
}

// Fallback: ip-api.com returns geo directly (through the proxy), no DB needed.
async function ipApiFallback(proxy: ProxySpec | null, deadline: number): Promise<Geo | null> {
  const left = deadline - Date.now();
  if (left <= 0) return null;
  try {
    const txt = await getText(IPAPI_URL, proxy, Math.min(left, 8000));
    const j = JSON.parse(txt);
    if (j?.status !== "success") return null;
    return {
      ip: j.query,
      country: j.countryCode,
      timezone: j.timezone,
      acceptLanguage: acceptLanguageForCountry(j.countryCode),
      location: j.lat != null && j.lon != null ? `${j.lat},${j.lon}` : undefined,
    };
  } catch {
    return null;
  }
}

/** Outcome of a geo resolution: the geo, or why there is none. */
export interface GeoResult {
  geo: Geo | null;
  /** Human-readable failure reason when `geo` is null or has no timezone. */
  reason?: string;
  /** How long the resolution took, in ms. */
  elapsedMs: number;
}

/**
 * Resolve geo for the egress (through `proxy` if given — HTTP or SOCKS5 — else direct), reporting
 * why it failed. Never throws. Bounded by `timeoutMs` (default {@link geoipTimeoutMs}).
 */
export async function resolveGeoDetailed(
  proxy?: string | { server?: string; username?: string; password?: string },
  opts: { quiet?: boolean; timeoutMs?: number } = {},
): Promise<GeoResult> {
  const started = Date.now();
  const budget = opts.timeoutMs ?? geoipTimeoutMs();
  const deadline = started + budget;
  let spec: ProxySpec | null;
  try {
    spec = toProxySpec(proxy ?? null);
  } catch (e) {
    return { geo: null, reason: `invalid proxy (${(e as Error).message})`, elapsedMs: Date.now() - started };
  }
  // Say which scheme, rather than the "could not determine the exit IP" every lookup would end in.
  const scheme = spec ? spec.server.slice(0, spec.server.indexOf(":")).toLowerCase() : "";
  if (spec && !PROXIED_REQUEST_SCHEMES.has(scheme)) {
    return { geo: null, reason: `${scheme}:// proxies are not supported; use http, https or socks5`, elapsedMs: Date.now() - started };
  }
  const ip = await exitIp(spec, deadline, opts.quiet);
  let geo: Geo | null = ip ? await mmdbLookup(ip, deadline, opts.quiet) : null;
  if (!geo) geo = await ipApiFallback(spec, deadline);
  const elapsedMs = Date.now() - started;
  if (geo && geo.timezone) {
    log(opts.quiet, `geoip: ${geo.ip} -> ${geo.country} tz=${geo.timezone} lang=${geo.acceptLanguage}`);
    return { geo, elapsedMs };
  }
  const reason = Date.now() >= deadline
    ? `timed out after ${Math.round(budget / 1000)}s (CLEARCOTE_GEOIP_TIMEOUT_SECONDS)`
    : !ip
      ? `could not determine the exit IP${spec ? " through the proxy" : ""}`
      : geo
        ? `no timezone for exit IP ${ip}`
        : `no geo data for exit IP ${ip}`;
  return { geo, reason, elapsedMs };
}

/**
 * Resolve geo for the egress (through `proxy` if given, else direct). Never throws — returns null
 * on failure. Uses the geoip-all-in-one offline DB first, ip-api.com as a fallback.
 */
export async function resolveGeo(
  proxy?: string | { server?: string; username?: string; password?: string },
  opts: { quiet?: boolean; timeoutMs?: number } = {}
): Promise<Geo | null> {
  return (await resolveGeoDetailed(proxy, opts)).geo;
}

// country (ISO-3166 alpha-2) -> the OS locale a machine there most plausibly runs. The geoip DB has
// no language data, so this maps the resolved country. ONE tag, not a list: the launch expands it
// the way Chrome does (DE -> de-DE -> UI "de", languages de-DE,de,en-US,en; CA -> en-CA ->
// en-GB,en-US,en; MY -> ms-MY -> Intl "ms" with en-US,en). See ./languages.ts resolveLanguages.
// Multi-language countries take the majority language (BE nl, CH de, CA en, IN en).
export const COUNTRY_LANG: Readonly<Record<string, string>> = {
  US: "en-US", GB: "en-GB", CA: "en-CA", AU: "en-AU", NZ: "en-NZ", IE: "en-IE",
  IN: "en-IN", ZA: "en-ZA", SG: "en-SG", PH: "en-PH",
  DE: "de-DE", AT: "de-AT", CH: "de-CH", FR: "fr-FR", BE: "nl-BE", NL: "nl-NL",
  ES: "es-ES", MX: "es-MX", AR: "es-AR", CL: "es-CL", CO: "es-CO", PE: "es-PE",
  VE: "es-VE", EC: "es-EC", UY: "es-UY", PT: "pt-PT", BR: "pt-BR",
  IT: "it-IT", PL: "pl-PL", RU: "ru-RU", UA: "uk-UA", SE: "sv-SE", NO: "nb-NO",
  DK: "da-DK", FI: "fi-FI", CZ: "cs-CZ", SK: "sk-SK", RO: "ro-RO", HU: "hu-HU",
  GR: "el-GR", BG: "bg-BG", HR: "hr-HR", SI: "sl-SI", RS: "sr-RS", LT: "lt-LT",
  LV: "lv-LV", EE: "et-EE", TR: "tr-TR", IL: "he-IL", SA: "ar-SA", AE: "ar-AE",
  EG: "ar-EG", JP: "ja-JP", KR: "ko-KR", CN: "zh-CN", HK: "zh-HK", TW: "zh-TW",
  TH: "th-TH", VN: "vi-VN", ID: "id-ID", MY: "ms-MY",
};

/**
 * The OS-locale tag for a country code (`DE` -> `de-DE`), en-US when unknown. It is a valid one-tag
 * Accept-Language; launch() turns it into Chrome's own language list.
 */
export function acceptLanguageForCountry(cc?: string): string {
  if (!cc) return "en-US";
  return COUNTRY_LANG[cc.toUpperCase()] || "en-US";
}

/**
 * Thrown by launch() when `geoip: true` was requested and the region could not be resolved.
 *
 * Failing closed is the point: continuing would launch with the host's clock and a default
 * language — UTC + en-US on most servers — which is exactly the mismatch geoip exists to prevent.
 * Pass an explicit `timezone` AND `acceptLanguage` to launch anyway when the lookup is unavailable.
 */
export class GeoipError extends Error {
  code = "GEOIP_UNRESOLVED";
  constructor(message: string) {
    super(message);
    this.name = "GeoipError";
  }
}
