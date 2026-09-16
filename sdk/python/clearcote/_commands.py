"""clearcote -- manage the browser binary, diagnose a setup, save a licence key, run a CDP endpoint.

    clearcote install [--version 152] [--channel preview]   download + verify the binary
    clearcote info    [--quick] [--json] [--proxy URL]      diagnostics (alias: doctor)
    clearcote update  [--channel preview]                   fetch a newer build if one exists
    clearcote clear-cache                                   delete every cached binary
    clearcote login   [key]                                 save a licence key (validated first)
    clearcote logout                                        remove the saved key
    clearcote serve   [--port 9222] [--idle-timeout 300] ...  multi-identity CDP endpoint
    clearcote version

``info`` never downloads: it reports what is already cached and what a launch would resolve to.
Mirrors the Node SDK's ``clearcote`` command. (``clearcote-agent`` and ``clearcote-serve`` are
separate, older entry points and are unchanged.)
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys

USAGE = """clearcote {version} -- manage and diagnose the Clearcote browser.

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
  clearcote version

INFO FLAGS
  --quick          skip everything that needs the network or a launch (seat count, launch test)
  --json           machine-readable output
  --proxy <url>    resolve the exit IP, timezone and language a launch through this proxy would use

ENVIRONMENT
  CLEARCOTE_LICENSE_KEY, CLEARCOTE_RELEASE_CHANNEL, CLEARCOTE_GEOIP_TIMEOUT_SECONDS,
  CLEARCOTE_LICENSE_THROUGH_PROXY, CLEARCOTE_BINARY, CLEARCOTE_CACHE, CLEARCOTE_SERVE_IDLE_TIMEOUT"""


class CliExit(SystemExit):
    """Raised by fail(): a SystemExit carrying the message already written to stderr."""


def _sdk_version():
    from . import __version__
    return __version__


def usage():
    return USAGE.format(version=_sdk_version())


def _out(line=""):
    sys.stdout.write(f"{line}\n")
    sys.stdout.flush()


def fail(msg, code=1):
    sys.stderr.write(f"clearcote: {msg}\n")
    sys.stderr.flush()
    raise CliExit(code)


def _geo_db_path():
    from .geoip import geo_cache_root
    return os.path.join(geo_cache_root(), "geoip-aio-all.mmdb")


def _missing_shared_libs(exe):
    if not sys.platform.startswith("linux"):
        return []
    try:
        r = subprocess.run(["ldd", "--", exe], capture_output=True, text=True, timeout=30)
    except Exception:  # noqa: BLE001
        return []
    return [line.strip().split(" ")[0] for line in (r.stdout or "").splitlines() if "not found" in line]


def build_info(quick=False, proxy=None, launch_fn=None):
    """What ``clearcote info`` reports; also the ``--json`` shape (same keys as the Node CLI)."""
    import platform as _platform

    from ._launchopts import GATED_ENGINE_SWITCHES, engine_supports_switch
    from ._license import get_session_seats, license_key_source
    from .download import list_cached_builds, resolve_release_channel
    from .release import RELEASE

    src = license_key_source()
    try:
        channel = resolve_release_channel()
    except ValueError as e:
        channel = f"invalid ({e})"
    cached = list_cached_builds()
    env_binary = os.environ.get("CLEARCOTE_BINARY")
    pick = {"path": env_binary} if env_binary else (cached[0] if cached else None)
    license_info = {"source": src["source"]}
    if src.get("masked"):
        license_info["key"] = src["masked"]
    binary = {"source": "CLEARCOTE_BINARY" if env_binary else ("cache" if pick else "none")}
    if pick:
        binary["path"] = pick["path"]
        if not env_binary:
            binary["tag"] = pick["tag"]
    binary.update({"cached": cached, "pinnedFree": f"{RELEASE['version']} ({RELEASE['tag']})",
                   "releaseChannel": channel})
    report = {
        "sdk": {"version": _sdk_version(), "python": _platform.python_version(),
                "platform": f"{sys.platform}-{_platform.machine().lower()}"},
        "license": license_info,
        "binary": binary,
        "geoip": {"databaseCached": os.path.exists(_geo_db_path()), "path": _geo_db_path()},
    }

    if pick and os.path.exists(pick["path"]):
        names = ["proxy-auth", "socks5-credentials", "socks5-udp"] + [s[2:] for s in GATED_ENGINE_SWITCHES]
        report["engineFeatures"] = {n: engine_supports_switch(pick["path"], n) for n in names}

    if sys.platform.startswith("linux") and pick:
        template = os.path.join(os.path.dirname(pick["path"]), "fonts", "fonts.conf.template")
        report["fonts"] = (
            {"bundled": True, "note": "metric-compatible Windows font clones are bundled with this build"}
            if os.path.exists(template) else
            {"bundled": False, "note": "this build ships no font bundle; a Windows persona on this host "
                                       "may render with Linux fonts"})

    if not quick and src["source"] != "none":
        report["license"]["seats"] = get_session_seats()

    if quick:
        report["launch"] = {"tested": False, "reason": "skipped (--quick)"}
    elif not pick:
        report["launch"] = {"tested": False, "reason": "no binary installed — run: clearcote install"}
    else:
        if launch_fn is None:
            from . import launch as launch_fn  # noqa: N806
        try:
            b = launch_fn(executable_path=pick["path"], headless=True, quiet=True, ephemeral_profile=False)
            try:
                version = b.version
                version = version() if callable(version) else version
            finally:
                b.close()
            report["launch"] = {"tested": True, "ok": True, "version": version}
        except Exception as e:  # noqa: BLE001
            entry = {"tested": True, "ok": False, "error": (str(e).splitlines() or [type(e).__name__])[0]}
            libs = _missing_shared_libs(pick["path"])
            if libs:
                entry["missingLibs"] = libs
            report["launch"] = entry

    if proxy:
        from .geoip import resolve_geo_detailed
        geo, reason, _ms = resolve_geo_detailed(proxy, quiet=True)
        report["geoip"]["proxy"] = (
            {"exitIp": geo.get("ip"), "country": geo.get("country"), "timezone": geo.get("timezone"),
             "acceptLanguage": geo.get("accept_language")}
            if geo and geo.get("timezone") else {"error": reason})
    return report


def print_info(r):
    def yn(b):
        return "yes" if b else "no"

    _out(f"clearcote SDK   {r['sdk']['version']}  (python {r['sdk']['python']}, {r['sdk']['platform']})")
    lic = r["license"]
    _out("Licence         " + ("none (free build)" if lic["source"] == "none" else f"{lic.get('key')} from {lic['source']}"))
    seats = lic.get("seats")
    if seats:
        if seats["state"] == "ok":
            limit = seats.get("limit") if seats.get("limit") is not None else "unlimited"
            plan = f"  (plan: {seats['plan']})" if seats.get("plan") else ""
            _out(f"Seats           {seats['used']} of {limit} in use{plan}")
        else:
            _out(f"Seats           unavailable: {seats.get('reason') or seats['state']}")
    b = r["binary"]
    if b.get("path"):
        tag = f"  [{b['tag']}]" if b.get("tag") else ""
        _out(f"Binary          {b['path']}{tag} ({b['source']})")
    else:
        _out("Binary          not installed — run: clearcote install")
    _out(f"Release channel {b['releaseChannel']}")
    _out(f"Free pin        {b['pinnedFree']}")
    if len(b["cached"]) > 1:
        _out("Also cached     " + ", ".join(c["tag"] for c in b["cached"][1:]))
    if r.get("engineFeatures"):
        _out("Engine support  " + "  ".join(f"{k}={yn(v)}" for k, v in r["engineFeatures"].items()))
    la = r.get("launch")
    if la:
        if not la["tested"]:
            _out(f"Launch test     {la['reason']}")
        elif la.get("ok"):
            _out(f"Launch test     ok ({la['version']})")
        else:
            _out(f"Launch test     FAILED: {la['error']}")
            for lib in la.get("missingLibs") or []:
                _out(f"                missing library: {lib}")
    if r.get("fonts"):
        _out(f"Fonts           {r['fonts']['note']}")
    _out("GeoIP database  " + ("cached" if r["geoip"]["databaseCached"] else "not cached (downloaded on first geoip launch)"))
    p = r["geoip"].get("proxy")
    if p:
        _out(f"Proxy geo       FAILED: {p['error']}" if p.get("error") else
             f"Proxy geo       exit {p['exitIp']} ({p['country']})  timezone {p['timezone']}  language {p['acceptLanguage']}")


def _prompt_key():
    if not sys.stdin or not sys.stdin.isatty():
        fail("no key given. Run `clearcote login <key>`, or copy a key from "
             "https://www.clearcotelabs.com/dashboard/licenses")
    sys.stderr.write("Paste your licence key (https://www.clearcotelabs.com/dashboard/licenses): ")
    sys.stderr.flush()
    return (sys.stdin.readline() or "").strip()


_BUILD_DIR = __import__("re").compile(r"^(pro-.+|v\d.*)$")


def cache_build_dirs(root):
    """Browser build directories directly under the cache root: children holding a ``.verified``
    marker, or named like a build tag (``pro-*`` / ``v<digit>*``). The root itself, and anything
    else that may share it (CLEARCOTE_CACHE can point anywhere), is never touched."""
    out = []
    for name in sorted(os.listdir(root)):
        full = os.path.join(root, name)
        if os.path.islink(full) or not os.path.isdir(full):
            continue
        if os.path.exists(os.path.join(full, ".verified")) or _BUILD_DIR.match(name):
            out.append(full)
    return out


def _dir_size(p):
    total = 0
    for root, _dirs, files in os.walk(p):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def _non_negative(name):
    def conv(v):
        try:
            n = float(v)
        except ValueError:
            n = -1
        if n < 0 or n != n:
            raise argparse.ArgumentTypeError(f"--{name} must be a non-negative number")
        return int(n) if n.is_integer() else n
    return conv


def _parser():
    ap = argparse.ArgumentParser(prog="clearcote", add_help=False)
    sub = ap.add_subparsers(dest="cmd")
    info = sub.add_parser("info", add_help=False, aliases=["doctor"])
    info.add_argument("--quick", action="store_true")
    info.add_argument("--no-launch", action="store_true")
    info.add_argument("--json", action="store_true")
    info.add_argument("--proxy")
    for name in ("install", "update"):
        p = sub.add_parser(name, add_help=False)
        p.add_argument("--version")
        p.add_argument("--channel")
    sub.add_parser("clear-cache", add_help=False)
    login = sub.add_parser("login", add_help=False)
    login.add_argument("key", nargs="?")
    sub.add_parser("logout", add_help=False)
    sub.add_parser("version", add_help=False)
    s = sub.add_parser("serve", add_help=False)
    s.add_argument("--port", type=_non_negative("port"), default=9222)
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--idle-timeout", type=_non_negative("idle-timeout"))
    s.add_argument("--data-dir")
    s.add_argument("--max-browsers", type=_non_negative("max-browsers"))
    s.add_argument("--allow-origin", action="append")
    s.add_argument("--allow-host", action="append")
    s.add_argument("--headed", action="store_true")
    s.add_argument("--fingerprint")
    s.add_argument("--platform")
    s.add_argument("--proxy")
    s.add_argument("--timezone")
    s.add_argument("--accept-language")
    s.add_argument("--geoip", action="store_true")
    s.add_argument("--quiet", action="store_true")
    return ap


def _run(argv):
    if not argv or argv[0] in ("-h", "--help", "help"):
        _out(usage())
        return 0
    if argv[0] in ("version", "--version"):
        _out(_sdk_version())
        return 0
    known = ("info", "doctor", "install", "update", "clear-cache", "login", "logout", "serve")
    if argv[0] not in known:
        fail(f"unknown command '{argv[0]}'. Run `clearcote --help`.", 2)

    parser = _parser()

    def _error(message):
        fail(message, 2)

    parser.error = _error
    for action in parser._subparsers._group_actions:  # noqa: SLF001
        for sp in action.choices.values():
            sp.error = _error
    a = parser.parse_args(argv)
    cmd = a.cmd

    if cmd in ("info", "doctor"):
        report = build_info(quick=bool(a.quick or a.no_launch), proxy=a.proxy)
        if a.json:
            _out(json.dumps(report, indent=2, ensure_ascii=False))
        else:
            print_info(report)
        return 0

    if cmd in ("install", "update"):
        from . import download
        from ._license import resolve_license_key
        from .download import resolve_release_channel
        channel = resolve_release_channel(a.channel)
        path = download(version=a.version, release_channel=channel, license_key=resolve_license_key(),
                        # update: re-resolve the newest build instead of reusing the SDK's pin (free);
                        # PRO always asks the server
                        auto_update=True if cmd == "update" else None)
        _out(path)
        return 0

    if cmd == "clear-cache":
        from .download import default_cache_root
        root = default_cache_root()
        if not os.path.isdir(root):
            _out(f"nothing to clear ({root} does not exist)")
            return 0
        builds = cache_build_dirs(root)
        if not builds:
            _out(f"nothing to clear (no browser builds in {root})")
            return 0
        size = 0
        for d in builds:
            size += _dir_size(d)
            shutil.rmtree(d, ignore_errors=True)
        _out(f"removed {len(builds)} build(s) from {root} ({size / 1e6:.0f} MB)")
        return 0

    if cmd == "login":
        from ._license import get_session_seats, save_license_key
        key = (a.key or "").strip() or _prompt_key()
        if not key:
            fail("empty key")
        seats = get_session_seats(license_key=key)
        if seats["state"] == "invalid":
            fail(f"the licence server rejected this key ({seats.get('reason')}). Nothing was saved.")
        where = save_license_key(key)
        _out(f"saved to {where}")
        if seats["state"] == "ok":
            limit = seats.get("limit") if seats.get("limit") is not None else "unlimited"
            plan = f", plan {seats['plan']}" if seats.get("plan") else ""
            _out(f"valid: {seats['used']} of {limit} seats in use{plan}")
        else:
            _out(f"note: could not confirm the key right now ({seats.get('reason')}); it was saved anyway")
        return 0

    if cmd == "logout":
        from ._license import license_key_path, remove_license_key
        _out(f"removed {license_key_path()}" if remove_license_key() else "no saved key")
        if os.environ.get("CLEARCOTE_LICENSE_KEY"):
            _out("note: CLEARCOTE_LICENSE_KEY is still set in this environment and will keep being used")
        return 0

    if cmd == "serve":
        import signal

        from ._multiplex import serve_multiplex
        from ._net import to_proxy_spec
        opts = {"port": a.port, "host": a.host, "idle_timeout": a.idle_timeout, "data_dir": a.data_dir,
                "allow_origins": a.allow_origin, "allow_hosts": a.allow_host, "headless": not a.headed,
                "quiet": a.quiet}
        if a.max_browsers is not None:
            opts["max_browsers"] = a.max_browsers
        for k in ("fingerprint", "platform", "timezone", "accept_language"):
            if getattr(a, k):
                opts[k] = getattr(a, k)
        if a.proxy:
            # Credentials are split out of the URL: a user:pass@ left in --proxy-server is rejected by
            # Chromium's proxy parser, which then goes DIRECT (the host's real IP).
            try:
                opts["proxy"] = to_proxy_spec(a.proxy)
            except ValueError as e:
                fail(str(e), 2)
        if a.geoip:
            opts["geoip"] = True
        srv = serve_multiplex(**opts)

        def stop(*_a):
            srv.close()

        signal.signal(signal.SIGINT, stop)
        if hasattr(signal, "SIGTERM"):
            signal.signal(signal.SIGTERM, stop)
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            srv.close()
        return 0

    fail(f"unknown command '{cmd}'. Run `clearcote --help`.", 2)
    return 2


def main(argv=None):
    """``clearcote`` console-script entry point. Returns the exit code."""
    argv = sys.argv[1:] if argv is None else list(argv)
    try:
        return _run(argv)
    except CliExit as e:
        return e.code
    except KeyboardInterrupt:
        return 130
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"clearcote: {e}\n")
        return 1


def _console_main():
    sys.exit(main())


if __name__ == "__main__":
    _console_main()
