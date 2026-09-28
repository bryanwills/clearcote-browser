#!/usr/bin/env python3
"""Release smoke test (Python side): actually launch the browser and prove the engine starts.

    python smoke_launch.py free   # the open build, keyless
    python smoke_launch.py pro    # the licensed build, with CCKEY (or CLEARCOTE_LICENSE_KEY)
    python smoke_launch.py        # both, in this order (the old behaviour)

Launches headless and reads a real navigator.userAgent (proves the process started AND runs JS).
Exits non-zero on ANY failure so a release pipeline can gate on it. This imports whatever
`clearcote` is installed in the current environment, so run it after installing the version you
want to verify (e.g. `pip install clearcote==X`). See docs/RELEASE-SMOKE-TEST.md.

A FREE run must really be keyless: the SDK reads CLEARCOTE_LICENSE_KEY and ~/.clearcote/license.key
on its own, so smoke-release.sh starts it with neither. As a guard, a FREE run whose Chrome major is
not the SDK's pinned open build fails — that is what a key leaking into it looks like.
"""
import os
import platform
import re
import sys

try:
    from clearcote import __version__, launch
    from clearcote.release import RELEASE
except Exception as e:  # noqa: BLE001
    print(f"[PY] import clearcote FAILED: {type(e).__name__}: {e}")
    sys.exit(2)

PIN = str(RELEASE["version"])
PIN_MAJOR = PIN.split(".")[0]


def run(tier: str, key: str | None) -> bool:
    kw = {"license_key": key} if key else {}
    try:
        b = launch(headless=True, args=["--no-sandbox"], quiet=True, **kw)
        page = b.new_page()
        ua = page.evaluate("() => navigator.userAgent")
        b.close()
    except Exception as e:  # noqa: BLE001
        print(f"[PY {platform.system()}] {tier}: LAUNCH_FAIL ({type(e).__name__}: {e})")
        return False
    m = re.search(r"Chrome/(\d+)", ua)
    major = m.group(1) if m else "?"
    ok, why = "Chrome" in ua, ""
    if ok and tier.strip() == "FREE" and major != PIN_MAJOR:
        ok, why = False, f" — expected the pinned open build {PIN_MAJOR}; a licence key reached the free run?"
    print(f"[PY {platform.system()}] {tier}: {'LAUNCH_OK' if ok else 'LAUNCH_FAIL'} | Chrome/{major} | {ua[:58]}{why}")
    return ok


tier = (sys.argv[1] if len(sys.argv) > 1 else "both").lower()
if tier not in ("free", "pro", "both"):
    print(f"usage: {sys.argv[0]} [free|pro|both]")
    sys.exit(2)
key = os.environ.get("CCKEY") or os.environ.get("CLEARCOTE_LICENSE_KEY")
print(f"[PY] clearcote {__version__} (pins open build {PIN}) on {platform.system()} py{sys.version.split()[0]}")

results = []
if tier in ("free", "both"):
    results.append(run("FREE", None))
if tier in ("pro", "both"):
    if key:
        results.append(run("PRO ", key))
    else:
        print("[PY] PRO : SKIPPED (set CCKEY or CLEARCOTE_LICENSE_KEY to test the licensed build)")

sys.exit(0 if all(results) else 1)
