"""Headless window geometry.

Headed launches take their geometry from the real display and the SDK keeps the page on it
(``no_viewport``), so ``screen`` / ``avail`` / ``inner`` / ``outer`` agree by construction. Headless
has no display, and what it reports depends on whether the engine's persona machinery is running.
Both regimes were measured on 149.0.7827.114/linux-x64; the SDK needs a different answer for each.

REGIME 1 — a persona is active (``--fingerprint=<seed>`` on the command line).
    The engine spoofs ``screen`` AND ``avail`` from the seed, including a taskbar
    (seed A -> 1920x1080 / avail 1920x1040, seed B -> 2560x1440 / 1400, seed C -> 1600x900 / 860),
    and its values BEAT a CDP screen override — so the SDK must not try to set screen here, it would
    silently lose. What it must not do either is leave Playwright's emulated viewport on: that gives
    ``inner`` 1280x720 inside an ``outer`` of 1920x1040, i.e. 640px of window unaccounted for by any
    frame a real browser has. So: ``no_viewport`` (``inner`` tracks the real window) plus one window
    resize to the persona's own work area, which yields a maximized window::

        screen 1920x1080   avail 1920x1040   inner 1920x919   outer 1920x1007   frame (0, 88)

    That frame delta is the engine's own, and it matches real captures (dx 0 maximized / 16 floating,
    dy 87-95 on Windows) far better than anything the SDK could impose.

REGIME 2 — no persona (the default seedless launch, ``light_stealth``, which drops
``--fingerprint`` deliberately, and a ``fingerprint_profile`` / ``profile="auto"`` launch without a
seed — measured: an imported profile only supplies screen/avail when a persona is ALSO running, so
without a seed its display is inert and this regime applies. When a profile is present its own screen
is used instead of a corpus pick.).
    Nothing spoofs ``screen``, so Chromium reports ``screen`` == the emulated viewport and then
    synthesizes a frame on top of it::

        screen 1280x720   avail 1280x720   inner 1280x720   outer 1288x851   <- outer > screen

    A window larger than its own screen is not a statistical tell but an impossible state, readable
    in two property lookups. It was present on every headless shape reachable through the SDK
    (default viewport, explicit viewport, ``no_viewport``, ``no_viewport`` + ``--window-size``).
    Here the SDK does have a lever — CDP ``Emulation.setDeviceMetricsOverride`` via Playwright's
    context ``screen`` option, the only thing that moves ``screen.*`` in headless. (The engine's own
    ``--fingerprint-screen-*`` / ``--fingerprint-avail-*`` switches are inert without a persona:
    verified through the SDK kwargs and passed raw, headless and headed.) So pick a screen size real
    machines have and size the viewport so the frame lands exactly on the screen edge.

    CDP LIMIT: the override sets ``availWidth/availHeight`` equal to ``screen.*``, so regime 2 always
    reports no taskbar. Not invented — 78 of 432 real desktop captures (23 of 79 networks) report
    ``avail == screen`` too. A minority shape, and the only one available here. Regime 1 is the more
    faithful of the two for that reason: prefer a seeded launch when it is an option.

PROVENANCE of the regime-2 table: the ``audit_profiles`` corpus (real captures from the public
fingerprint audit), desktop rows whose geometry is self-consistent and which are not themselves
emulated-viewport captures, counted by distinct /24 so one busy machine cannot skew it. Regenerate
with ``scripts/derive-headless-geometry.cjs``. Three deliberate deviations, because the corpus
samples an audit site's visitors rather than the web:

* macOS rows dropped — they report ``color_depth`` 30, which this engine cannot spoof, so a macOS
  screen size would contradict the depth the page actually reads.
* Non-1.0 device-pixel-ratio rows dropped (e.g. the common Windows ``1536x864 @1.25``). DPR is
  reachable over CDP, but scaling changes what the rasterizer produces, and an unverified DPR is a
  worse trade than a slightly narrower screen pool.
* Ultrawide ``3440x1440`` capped to weight 2 (the corpus has 12 distinct /24s on it — developers
  over-represent ultrawides; uncapped it would be picked for ~1 launch in 5).
"""

import base64
import gzip
import hashlib
import json
import logging

logger = logging.getLogger("clearcote")

# ---------------------------------------------------------------------------
# Regime-2 engine window-frame delta: outer = inner + (WIDTH, HEIGHT).
#
# Measured with no persona on 149.0.7827.114/linux-x64, and re-confirmed on the 150 build a
# default launch resolves (same 8/131). Constant across every viewport probed
# (1280x720 -> 1288x851, 1920x947 -> 1928x1078, 1912x909 -> 1920x1040, 2552x1269 -> 2560x1400).
# The regime-2 viewport is sized against these, so an engine that changed them would put headless
# windows back outside their screen. tests/test_geometry.py measures the running engine and fails on
# drift — keep it in the release gate. (Regime 1 needs no constant: the window is fitted to the
# persona's work area and the engine computes its own frame.)
# ---------------------------------------------------------------------------
ENGINE_FRAME_WIDTH = 8
ENGINE_FRAME_HEIGHT = 131

# (screen_width, screen_height, weight, os_hint) — weight is distinct /24s in the corpus.
HEADLESS_SCREEN_PROFILES = (
    (1920, 1080, 24, "windows"),
    (2560, 1440, 13, "windows"),
    (1920, 1200, 6, "linux"),
    (1366, 768, 3, "windows"),
    (1600, 900, 3, "linux"),
    (3440, 1440, 2, "windows"),   # capped from 12 (see module docstring)
    (3840, 2160, 2, "windows"),
    (1680, 1050, 2, "windows"),
)

# Geometry the caller may have chosen; any of them means hands off.
_CALLER_GEOMETRY_KEYS = ("viewport", "no_viewport", "screen")
# Window flags that mean the caller sized the window themselves (regime 1 skips its resize).
_CALLER_WINDOW_FLAGS = ("--window-size", "--window-position", "--start-maximized")


def persona_active(args):
    """Whether ``--fingerprint=<seed>`` is on the command line, i.e. the engine will spoof
    ``screen``/``avail`` itself (regime 1). ``light_stealth`` drops that switch on purpose, so this
    is False for it even though a seed was passed to the SDK."""
    return any(str(a).startswith("--fingerprint=") for a in (args or []))


def _pick(seed):
    """Weighted, deterministic choice from ``HEADLESS_SCREEN_PROFILES``.

    Same construction as ``_light_stealth_values``: the full sha256 digest as a big integer, so the
    Python, Node and .NET SDKs select the identical row for a given seed. An unset seed maps to a
    fixed key rather than randomness, so a seedless launch stays reproducible.
    """
    key = str(seed if seed not in (None, "") else "clearcote-headless-geometry")
    h = int(hashlib.sha256(key.encode("utf-8")).hexdigest(), 16)
    total = sum(row[2] for row in HEADLESS_SCREEN_PROFILES)
    point = h % total
    for row in HEADLESS_SCREEN_PROFILES:
        point -= row[2]
        if point < 0:
            return row
    return HEADLESS_SCREEN_PROFILES[-1]  # unreachable; keeps the return total


_PROFILE_FLAG = "--fingerprint-profile="


def profile_screen_from_args(args):
    """The imported profile's own screen, as ``(width, height)``, or None.

    Reads the value off ``--fingerprint-profile`` (gzip+base64 of the capture JSON) — the single form
    every SDK has in hand here, whatever the caller passed (path, dict or JSON string). Best-effort by
    design: a profile the engine can still use must never fail a launch just because this could not
    read a screen out of it, so every failure returns None and the corpus table is used instead.

    A screen too small to hold the engine's frame is rejected for the same reason the corpus table has
    no tiny rows: the leftover viewport would not lay out a desktop site.
    """
    for arg in (args or []):
        arg = str(arg)
        if not arg.startswith(_PROFILE_FLAG):
            continue
        try:
            raw = gzip.decompress(base64.b64decode(arg[len(_PROFILE_FLAG):]))
            screen = json.loads(raw).get("screen") or {}
            width, height = int(screen["width"]), int(screen["height"])
        except Exception:  # noqa: BLE001
            return None
        if width - ENGINE_FRAME_WIDTH < 1024 or height - ENGINE_FRAME_HEIGHT < 600:
            logger.debug("profile screen %dx%d is too small to size a viewport against", width, height)
            return None
        return (width, height)
    return None


def _geometry_for(screen):
    """Context geometry for a given screen: viewport = screen minus the engine's frame."""
    width, height = screen
    return {
        "screen": {"width": width, "height": height},
        "viewport": {"width": width - ENGINE_FRAME_WIDTH, "height": height - ENGINE_FRAME_HEIGHT},
    }


def headless_geometry(seed=None):
    """Regime-2 context geometry: ``{"screen": {...}, "viewport": {...}}``.

    The viewport is the screen minus the engine's frame, so the synthesized ``outerWidth/Height``
    lands exactly on the screen edge (a maximized window) instead of past it.
    """
    sw, sh, _weight, _os = _pick(seed)
    return _geometry_for((sw, sh))


def apply_headless_geometry(pw_kwargs, seed=None, args=None):
    """Default a headless launch's geometry in place. Returns what was applied, or None.

    ``{"mode": "persona"}`` means regime 1: ``no_viewport`` was set and the window still needs
    fitting to the persona's work area (see ``fit_window_to_persona``). ``{"mode": "profile", ...}``
    means regime 2: ``screen`` + ``viewport`` were set and nothing else is needed.

    Skipped when the launch is headed (the real window is already coherent) and when the caller
    expressed ANY geometry intent. ``headless`` unset means headless, matching Playwright.
    """
    if pw_kwargs.get("headless") is False:
        return None
    if any(k in pw_kwargs for k in _CALLER_GEOMETRY_KEYS):
        return None
    if persona_active(args):
        pw_kwargs["no_viewport"] = True
        return {"mode": "persona"}
    # An imported profile carries its own display; prefer it over a corpus pick so the identity the
    # caller imported is the one the page sees (and so profile launches don't all share one screen).
    from_profile = profile_screen_from_args(args)
    geom = _geometry_for(from_profile) if from_profile else headless_geometry(seed)
    pw_kwargs.update(geom)
    return {"mode": "profile", "source": "imported" if from_profile else "corpus", **geom}


def caller_sized_the_window(args):
    """True when the caller passed their own window geometry flag."""
    return any(str(a).split("=", 1)[0] in _CALLER_WINDOW_FLAGS for a in (args or []))


# A plain expression, NOT "() => [...]": Playwright's JS/.NET bindings evaluate an
# arrow-function string to a function object rather than calling it, which silently broke the
# Node port. An expression behaves the same in every binding.
_WORKAREA_JS = "[screen.availWidth, screen.availHeight]"
_OUTER_JS = "[outerWidth, outerHeight]"


def _plausible(area):
    """Guard against fitting the window to a nonsense work area: if the persona did not engage the
    page reports the headless default (800x600), and 'maximizing' to that would be worse than
    leaving the window alone."""
    return bool(area) and len(area) == 2 and area[0] >= 1024 and area[1] >= 600


def _bounds(width, height):
    return {"left": 0, "top": 0, "width": int(width), "height": int(height)}


def _fit_plan(avail, outer):
    """The bounds correction, given what the window reported after the first attempt.

    Requested bounds and reported ``outerHeight`` are NOT the same quantity: on 149 the window
    reports 33px less than the bounds height it was given, so fitting bounds to the work area lands
    the window 33px short of maximized (real maximized captures have ``outer == avail``). Rather than
    hardcode 33, measure the shortfall and add it back — that self-tunes if the engine changes.

    Returns None when nothing needs correcting, else the ``(width, height)`` to request. Never asks
    for MORE than the shortfall, so the window cannot be pushed past the work area.
    """
    dw = avail[0] - outer[0]
    dh = avail[1] - outer[1]
    if dw <= 0 and dh <= 0:
        return None
    return (avail[0] + max(dw, 0), avail[1] + max(dh, 0))


def fit_window_to_persona(page, args=None):
    """Regime 1: size the headless window to the persona's own work area, so the page reports a
    maximized window (``outer == avail``) instead of the 800x600 headless default sitting inside a
    spoofed 1920x1080 screen.

    Note ``--start-maximized`` and CDP ``windowState: "maximized"`` are both no-ops in headless
    (measured — the window stays at its default size), which is why this sets explicit bounds.

    Returns the ``(width, height)`` the window ended up reporting, or None if skipped. Never raises:
    a geometry improvement must not be able to fail a launch.
    """
    if caller_sized_the_window(args):
        return None
    try:
        avail = page.evaluate(_WORKAREA_JS)
        if not _plausible(avail):
            logger.debug("skipping window fit: implausible work area %r", avail)
            return None
        cdp = page.context.new_cdp_session(page)
        window_id = cdp.send("Browser.getWindowForTarget")["windowId"]
        cdp.send("Browser.setWindowBounds",
                 {"windowId": window_id, "bounds": _bounds(avail[0], avail[1])})
        outer = page.evaluate(_OUTER_JS)
        plan = _fit_plan(avail, outer)
        if plan:
            cdp.send("Browser.setWindowBounds",
                     {"windowId": window_id, "bounds": _bounds(*plan)})
            outer = page.evaluate(_OUTER_JS)
            # Overshooting would trade one impossible geometry for another (outer > avail), so
            # fall back to the uncorrected bounds rather than ship that.
            if outer[0] > avail[0] or outer[1] > avail[1]:
                logger.debug("window fit overshot (%r > %r); reverting", outer, avail)
                cdp.send("Browser.setWindowBounds",
                         {"windowId": window_id, "bounds": _bounds(avail[0], avail[1])})
                outer = page.evaluate(_OUTER_JS)
        return (outer[0], outer[1])
    except Exception as exc:  # noqa: BLE001
        logger.debug("window fit skipped: %s", exc)
        return None


async def fit_window_to_persona_async(page, args=None):
    """Async mirror of ``fit_window_to_persona``."""
    if caller_sized_the_window(args):
        return None
    try:
        avail = await page.evaluate(_WORKAREA_JS)
        if not _plausible(avail):
            logger.debug("skipping window fit: implausible work area %r", avail)
            return None
        cdp = await page.context.new_cdp_session(page)
        window = await cdp.send("Browser.getWindowForTarget")
        window_id = window["windowId"]
        await cdp.send("Browser.setWindowBounds",
                       {"windowId": window_id, "bounds": _bounds(avail[0], avail[1])})
        outer = await page.evaluate(_OUTER_JS)
        plan = _fit_plan(avail, outer)
        if plan:
            await cdp.send("Browser.setWindowBounds",
                           {"windowId": window_id, "bounds": _bounds(*plan)})
            outer = await page.evaluate(_OUTER_JS)
            if outer[0] > avail[0] or outer[1] > avail[1]:
                logger.debug("window fit overshot (%r > %r); reverting", outer, avail)
                await cdp.send("Browser.setWindowBounds",
                               {"windowId": window_id, "bounds": _bounds(avail[0], avail[1])})
                outer = await page.evaluate(_OUTER_JS)
        return (outer[0], outer[1])
    except Exception as exc:  # noqa: BLE001
        logger.debug("window fit skipped: %s", exc)
        return None


def _cdp_window(page):
    """The CDP session + window id for ``page``'s browser window."""
    cdp = page.context.new_cdp_session(page)
    return cdp, cdp.send("Browser.getWindowForTarget")["windowId"]


def move_window_to_origin(page, args=None):
    """Regime 2: move the real window to (0, 0).

    Regime 2 leaves the real window at the headless default position — measured (10, 10) — while the
    emulated viewport makes ``outerWidth/Height`` span the whole spoofed screen. ``screenX +
    outerWidth`` then exceeds ``screen.width``: the window hangs 10px past the screen edge on both
    axes. Only 6% of real single-display captures do that, so it is a weak but free tell. Moving the
    window costs one CDP call and leaves the emulated viewport untouched (verified: inner/outer
    unchanged, screenX/Y become 0).

    Returns the position applied, or None if skipped. Never raises.
    """
    if caller_sized_the_window(args):
        return None
    try:
        cdp, window_id = _cdp_window(page)
        # left/top only — sending width/height here would fight the emulated viewport.
        cdp.send("Browser.setWindowBounds", {"windowId": window_id, "bounds": {"left": 0, "top": 0}})
        return (0, 0)
    except Exception as exc:  # noqa: BLE001
        logger.debug("window move skipped: %s", exc)
        return None


async def move_window_to_origin_async(page, args=None):
    """Async mirror of ``move_window_to_origin``."""
    if caller_sized_the_window(args):
        return None
    try:
        cdp = await page.context.new_cdp_session(page)
        window = await cdp.send("Browser.getWindowForTarget")
        await cdp.send("Browser.setWindowBounds",
                       {"windowId": window["windowId"], "bounds": {"left": 0, "top": 0}})
        return (0, 0)
    except Exception as exc:  # noqa: BLE001
        logger.debug("window move skipped: %s", exc)
        return None


def geometry_is_coherent(screen, avail, inner, outer):
    """``inner <= outer <= avail <= screen`` on both axes — the chain a real window satisfies.

    Exposed because it is the actual invariant under test; takes ``(width, height)`` pairs.
    """
    return (
        inner[0] <= outer[0] and inner[1] <= outer[1]
        and outer[0] <= avail[0] and outer[1] <= avail[1]
        and avail[0] <= screen[0] and avail[1] <= screen[1]
    )
