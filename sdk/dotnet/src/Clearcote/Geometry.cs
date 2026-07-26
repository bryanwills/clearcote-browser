using System.IO.Compression;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Playwright;

namespace Clearcote;

/// <summary>
/// Headless window geometry. Port of the Python SDK's <c>_geometry.py</c> and the Node SDK's
/// <c>geometry.ts</c>; the profile table, the seed hashing and the skip rules are identical, so a seed
/// selects the same persona in every SDK.
/// </summary>
/// <remarks>
/// <para>
/// Headed launches take their geometry from the real display and the SDK keeps the page on it
/// (<c>ViewportSize.NoViewport</c>), so screen/avail/inner/outer agree by construction. Headless has
/// no display, and what it reports depends on whether the engine's persona machinery is running.
/// Both regimes were measured on 149.0.7827.114/linux-x64.
/// </para>
/// <para>
/// REGIME 1 — a persona is active (<c>--fingerprint=&lt;seed&gt;</c> on the command line). The engine
/// spoofs screen AND avail from the seed, including a taskbar (seed A -> 1920x1080 / avail 1920x1040,
/// seed B -> 2560x1440 / 1400, seed C -> 1600x900 / 860), and its values BEAT a CDP screen override —
/// so the SDK must not try to set screen here, it would silently lose. Leaving Playwright's emulated
/// viewport on is just as wrong: inner 1280x720 inside an outer of 1920x1040 leaves 640px of window
/// unaccounted for by any frame a real browser has. So NoViewport plus one window resize into the
/// persona's own work area, which lands a maximized window:
/// <c>screen 1920x1080, avail 1920x1040, inner 1920x952, outer 1920x1040, frame (0, 88)</c>.
/// </para>
/// <para>
/// REGIME 2 — no persona (the default seedless launch, and <c>LightStealth</c>, which drops
/// <c>--fingerprint</c> deliberately). Nothing spoofs screen, so Chromium reports screen == the
/// emulated viewport and then synthesizes a frame on top of it:
/// <c>screen 1280x720, avail 1280x720, inner 1280x720, outer 1288x851</c> — a window LARGER than its
/// own screen, an impossible state readable in two property lookups, and it was present on every
/// headless shape reachable through the SDK. The lever is CDP
/// <c>Emulation.setDeviceMetricsOverride</c> via the context's ScreenSize — the only thing that moves
/// screen.* in headless (the engine's own <c>--fingerprint-screen-*</c> switches are inert without a
/// persona: verified through the SDK options and passed raw, headless and headed). So pick a screen
/// size real machines have and size the viewport so the frame lands exactly on the screen edge.
/// </para>
/// <para>
/// CDP LIMIT: the override sets availWidth/availHeight equal to screen.*, so regime 2 always reports
/// no taskbar. Not invented — 78 of 432 real desktop captures (23 of 79 networks) report
/// avail == screen too. It is a minority shape and the only one available here; regime 1 is the more
/// faithful of the two, so prefer a seeded launch when it is an option.
/// </para>
/// <para>
/// PROVENANCE of the regime-2 table: the <c>audit_profiles</c> corpus (real captures from the public
/// fingerprint audit), desktop rows whose geometry is self-consistent and which are not themselves
/// emulated-viewport captures, counted by distinct /24 so one busy machine cannot skew it. macOS rows
/// are dropped (color_depth 30, which this engine cannot spoof), non-1.0 DPR rows are dropped
/// (scaling changes what the rasterizer produces), and ultrawide 3440x1440 is capped to weight 2
/// (12 distinct /24s in the corpus — developers over-represent ultrawides).
/// </para>
/// </remarks>
public static class Geometry
{
    /// <summary>
    /// Regime-2 engine window-frame width delta: <c>outerWidth = innerWidth + 8</c>. Measured with no
    /// persona on 149.0.7827.114/linux-x64, re-confirmed on the 150 build a default launch resolves,
    /// constant across every viewport probed. The regime-2
    /// viewport is sized against this, so drift would put headless windows back outside their screen —
    /// the live test in GeometryTests measures the running engine and fails if it moves.
    /// </summary>
    public const int EngineFrameWidth = 8;

    /// <summary>Regime-2 engine window-frame height delta: <c>outerHeight = innerHeight + 131</c>.</summary>
    public const int EngineFrameHeight = 131;

    /// <summary>(ScreenWidth, ScreenHeight, Weight, OsHint) — Weight is distinct /24s in the corpus.</summary>
    public static readonly (int Width, int Height, int Weight, string Os)[] HeadlessScreenProfiles =
    {
        (1920, 1080, 24, "windows"),
        (2560, 1440, 13, "windows"),
        (1920, 1200, 6, "linux"),
        (1366, 768, 3, "windows"),
        (1600, 900, 3, "linux"),
        (3440, 1440, 2, "windows"),   // capped from 12 (see the class remarks)
        (3840, 2160, 2, "windows"),
        (1680, 1050, 2, "windows"),
    };

    private static readonly string[] CallerWindowFlags =
        { "--window-size", "--window-position", "--start-maximized" };

    /// <summary>
    /// Whether <c>--fingerprint=&lt;seed&gt;</c> is on the command line, i.e. the engine spoofs
    /// screen/avail itself (regime 1). <c>LightStealth</c> drops that switch on purpose, so this is
    /// false for it even though a seed was passed to the SDK.
    /// </summary>
    public static bool PersonaActive(IEnumerable<string>? args) =>
        args?.Any(a => (a ?? "").StartsWith("--fingerprint=", StringComparison.Ordinal)) == true;

    /// <summary>True when the caller passed their own window geometry flag.</summary>
    public static bool CallerSizedTheWindow(IEnumerable<string>? args) =>
        args?.Any(a => CallerWindowFlags.Contains((a ?? "").Split('=')[0])) == true;

    /// <summary>
    /// Weighted, deterministic choice from <see cref="HeadlessScreenProfiles"/>. Same construction as
    /// <c>LightStealthValues</c>: the full sha256 digest as a big integer, so Python, Node and .NET
    /// select the identical row for a seed. An unset seed maps to a fixed key rather than randomness,
    /// so a seedless launch stays reproducible.
    /// </summary>
    private static (int Width, int Height, int Weight, string Os) Pick(string? seed)
    {
        var key = string.IsNullOrEmpty(seed) ? "clearcote-headless-geometry" : seed;
        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(key));
        var big = new BigInteger(digest, isUnsigned: true, isBigEndian: true);
        var total = HeadlessScreenProfiles.Sum(p => p.Weight);
        var point = (int)(big % total);
        foreach (var row in HeadlessScreenProfiles)
        {
            point -= row.Weight;
            if (point < 0) return row;
        }
        return HeadlessScreenProfiles[^1];
    }

    /// <summary>Context geometry for a given screen: viewport = screen minus the engine's frame.</summary>
    private static (ScreenSize Screen, ViewportSize Viewport) GeometryFor(int width, int height) => (
        new ScreenSize { Width = width, Height = height },
        new ViewportSize { Width = width - EngineFrameWidth, Height = height - EngineFrameHeight }
    );

    private const string ProfileFlag = "--fingerprint-profile=";

    /// <summary>The imported profile's own screen, or null.</summary>
    /// <remarks>
    /// Measured: <c>--fingerprint-profile</c> supplies screen/avail only when a persona
    /// (<c>--fingerprint=</c>) is ALSO running. Without a seed the profile's display is inert, so the
    /// SDK's override is all the page sees — and taking it from the profile keeps the imported identity
    /// instead of giving every seedless profile launch the same corpus screen. Reads the value off the
    /// switch (gzip+base64 of the capture JSON), the one form every SDK has in hand here. Best-effort:
    /// failures return null and the corpus table is used. A screen too small to hold the engine's frame
    /// is rejected — which is what keeps a <c>profile="auto"</c> capture made on a headless host, whose
    /// screen can be the 800x600 surface, from becoming the persona's display.
    /// </remarks>
    public static (int Width, int Height)? ProfileScreenFromArgs(IEnumerable<string>? args)
    {
        foreach (var raw in args ?? Array.Empty<string>())
        {
            var arg = raw ?? "";
            if (!arg.StartsWith(ProfileFlag, StringComparison.Ordinal)) continue;
            try
            {
                var packed = Convert.FromBase64String(arg[ProfileFlag.Length..]);
                using var input = new MemoryStream(packed);
                using var gz = new GZipStream(input, CompressionMode.Decompress);
                using var doc = JsonDocument.Parse(gz);
                if (!doc.RootElement.TryGetProperty("screen", out var screen)) return null;
                if (!screen.TryGetProperty("width", out var w) || !screen.TryGetProperty("height", out var h))
                    return null;
                var width = w.GetInt32();
                var height = h.GetInt32();
                if (width - EngineFrameWidth < 1024 || height - EngineFrameHeight < 600) return null;
                return (width, height);
            }
            catch (Exception)
            {
                return null;
            }
        }
        return null;
    }

    /// <summary>
    /// Regime-2 context geometry. The viewport is the screen minus the engine's frame, so the
    /// synthesized outerWidth/Height lands exactly on the screen edge (a maximized window).
    /// </summary>
    public static (ScreenSize Screen, ViewportSize Viewport) HeadlessGeometry(string? seed = null)
    {
        var row = Pick(seed);
        return GeometryFor(row.Width, row.Height);
    }

    /// <summary>Which regime a launch falls into, and the regime-2 values when it applies.</summary>
    public enum Mode
    {
        /// <summary>Headed, or the caller chose their own geometry — nothing to do.</summary>
        None,
        /// <summary>Regime 1: NoViewport, and the window still needs fitting to the persona's work area.</summary>
        Persona,
        /// <summary>Regime 2: the SDK's screen + viewport apply.</summary>
        Profile,
    }

    /// <summary>
    /// Resolve the geometry a headless launch should use.
    /// </summary>
    /// <remarks>
    /// Returns <see cref="Mode.None"/> when the launch is headed (the real window is already coherent)
    /// or when the caller set ViewportSize / ScreenSize themselves. Note a null
    /// <paramref name="headless"/> means headless, matching Playwright.
    /// </remarks>
    public static (Mode Mode, ScreenSize? Screen, ViewportSize? Viewport) Resolve(
        bool? headless,
        string? seed,
        IEnumerable<string>? args,
        bool callerSetGeometry)
    {
        if (headless == false) return (Mode.None, null, null);
        if (callerSetGeometry) return (Mode.None, null, null);
        if (PersonaActive(args)) return (Mode.Persona, null, null);
        // An imported profile carries its own display; prefer it over a corpus pick.
        var fromProfile = ProfileScreenFromArgs(args);
        var (screen, viewport) = fromProfile is not null
            ? GeometryFor(fromProfile.Value.Width, fromProfile.Value.Height)
            : HeadlessGeometry(seed);
        return (Mode.Profile, screen, viewport);
    }

    // A plain expression, NOT "() => [...]": Playwright evaluates an arrow-function string to a
    // function object rather than calling it (which silently broke the Node port once).
    private const string WorkareaJs = "[screen.availWidth, screen.availHeight]";
    private const string OuterJs = "[outerWidth, outerHeight]";

    /// <summary>
    /// A work area only a non-engaged persona would report (the headless default) is not worth fitting to.
    /// </summary>
    private static bool Plausible(int[]? area) =>
        area is { Length: 2 } && area[0] >= 1024 && area[1] >= 600;

    private static Dictionary<string, object> Bounds(int width, int height) => new()
    {
        ["left"] = 0, ["top"] = 0, ["width"] = width, ["height"] = height,
    };

    /// <summary>
    /// The bounds correction, given what the window reported after the first attempt, or null when
    /// nothing needs correcting.
    /// </summary>
    /// <remarks>
    /// Requested bounds and reported outerHeight are not the same quantity: on 149 the window reports
    /// 33px less than the bounds height it was given, so fitting bounds to the work area lands 33px
    /// short of maximized (real maximized captures have outer == avail). Rather than hardcode 33,
    /// measure the shortfall and add it back — that self-tunes if the engine changes. Never asks for
    /// more than the shortfall, so the window cannot be pushed past the work area.
    /// </remarks>
    public static (int Width, int Height)? FitPlan(int[] avail, int[] outer)
    {
        var dw = avail[0] - outer[0];
        var dh = avail[1] - outer[1];
        if (dw <= 0 && dh <= 0) return null;
        return (avail[0] + Math.Max(dw, 0), avail[1] + Math.Max(dh, 0));
    }

    /// <summary>
    /// Regime 1: size the headless window to the persona's own work area, so the page reports a
    /// maximized window (outer == avail) instead of the 800x600 headless default sitting inside a
    /// spoofed 1920x1080 screen. Returns the reported outer size, or null if skipped.
    /// </summary>
    /// <remarks>
    /// <c>--start-maximized</c> and CDP <c>windowState: "maximized"</c> are both no-ops in headless
    /// (measured — the window stays at its default size), which is why this sets explicit bounds.
    /// Never throws: a geometry improvement must not be able to fail a launch.
    /// </remarks>
    public static async Task<(int Width, int Height)?> FitWindowToPersonaAsync(
        IPage page, IEnumerable<string>? args = null)
    {
        if (CallerSizedTheWindow(args)) return null;
        try
        {
            var avail = await page.EvaluateAsync<int[]>(WorkareaJs).ConfigureAwait(false);
            if (!Plausible(avail)) return null;
            var cdp = await page.Context.NewCDPSessionAsync(page).ConfigureAwait(false);
            var target = await cdp.SendAsync("Browser.getWindowForTarget").ConfigureAwait(false);
            var windowId = target!.Value.GetProperty("windowId").GetInt32();

            await cdp.SendAsync("Browser.setWindowBounds", new Dictionary<string, object>
            {
                ["windowId"] = windowId, ["bounds"] = Bounds(avail[0], avail[1]),
            }).ConfigureAwait(false);
            var outer = await page.EvaluateAsync<int[]>(OuterJs).ConfigureAwait(false);

            var plan = FitPlan(avail, outer);
            if (plan is not null)
            {
                await cdp.SendAsync("Browser.setWindowBounds", new Dictionary<string, object>
                {
                    ["windowId"] = windowId, ["bounds"] = Bounds(plan.Value.Width, plan.Value.Height),
                }).ConfigureAwait(false);
                outer = await page.EvaluateAsync<int[]>(OuterJs).ConfigureAwait(false);
                // Overshooting would trade one impossible geometry for another (outer > avail).
                if (outer[0] > avail[0] || outer[1] > avail[1])
                {
                    await cdp.SendAsync("Browser.setWindowBounds", new Dictionary<string, object>
                    {
                        ["windowId"] = windowId, ["bounds"] = Bounds(avail[0], avail[1]),
                    }).ConfigureAwait(false);
                    outer = await page.EvaluateAsync<int[]>(OuterJs).ConfigureAwait(false);
                }
            }
            return (outer[0], outer[1]);
        }
        catch (Exception)
        {
            return null;   // deliberately silent: never fail a launch over geometry
        }
    }

    /// <summary>
    /// Regime 2: move the real window to (0, 0). Returns the position applied, or null if skipped.
    /// </summary>
    /// <remarks>
    /// Regime 2 leaves the real window at the headless default position — measured (10, 10) — while
    /// the emulated viewport makes outerWidth/Height span the whole spoofed screen.
    /// <c>screenX + outerWidth</c> then exceeds <c>screen.width</c>: the window hangs 10px past the
    /// screen edge on both axes. Only 6% of real single-display captures do that, so it is a weak but
    /// free tell. The move costs one CDP call and leaves the emulated viewport untouched (verified:
    /// inner/outer unchanged, screenX/Y become 0). Never throws.
    /// </remarks>
    public static async Task<(int X, int Y)?> MoveWindowToOriginAsync(
        IPage page, IEnumerable<string>? args = null)
    {
        if (CallerSizedTheWindow(args)) return null;
        try
        {
            var cdp = await page.Context.NewCDPSessionAsync(page).ConfigureAwait(false);
            var target = await cdp.SendAsync("Browser.getWindowForTarget").ConfigureAwait(false);
            var windowId = target!.Value.GetProperty("windowId").GetInt32();
            // left/top only — sending width/height here would fight the emulated viewport.
            await cdp.SendAsync("Browser.setWindowBounds", new Dictionary<string, object>
            {
                ["windowId"] = windowId,
                ["bounds"] = new Dictionary<string, object> { ["left"] = 0, ["top"] = 0 },
            }).ConfigureAwait(false);
            return (0, 0);
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>
    /// Apply the headless window fixup once, using the context's existing page (a persistent context
    /// always has one) or its first new page: fit to the persona's work area, or move to the origin.
    /// </summary>
    public static async Task InstallWindowFixupAsync(
        IBrowserContext context, IEnumerable<string>? args = null, bool persona = true)
    {
        var page = context.Pages.Count > 0
            ? context.Pages[0]
            : await context.NewPageAsync().ConfigureAwait(false);
        if (persona) await FitWindowToPersonaAsync(page, args).ConfigureAwait(false);
        else await MoveWindowToOriginAsync(page, args).ConfigureAwait(false);
    }

    /// <summary>
    /// Apply the regime-2 screen override to a persistent context, and keep applying it to pages
    /// opened later.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Playwright .NET 1.49 accepts <c>ScreenSize</c> on <c>NewContextAsync</c> but SILENTLY DROPS it
    /// on <c>LaunchPersistentContextAsync</c> (verified against engine 149.0.7827.114: screen came
    /// back equal to the viewport, so <c>outer</c> exceeded <c>screen</c> — exactly the geometry this
    /// module exists to prevent). The Python and Node bindings send it on both, which is why only
    /// this SDK needs the workaround.
    /// </para>
    /// <para>
    /// So issue the override directly: the same <c>Emulation.setDeviceMetricsOverride</c> call
    /// Playwright uses for the viewport, with <c>screenWidth/screenHeight</c> added. Verified to
    /// survive navigations and to fire no resize event. It is per-TARGET — a second tab does not
    /// inherit it — so new pages get it too, via the context's Page event.
    /// </para>
    /// </remarks>
    public static async Task InstallScreenOverrideAsync(
        IBrowserContext context, ScreenSize screen, ViewportSize viewport)
    {
        async Task ApplyAsync(IPage page)
        {
            try
            {
                var cdp = await context.NewCDPSessionAsync(page).ConfigureAwait(false);
                await cdp.SendAsync("Emulation.setDeviceMetricsOverride", new Dictionary<string, object>
                {
                    ["width"] = viewport.Width,
                    ["height"] = viewport.Height,
                    ["screenWidth"] = screen.Width,
                    ["screenHeight"] = screen.Height,
                    ["deviceScaleFactor"] = 1,
                    ["mobile"] = false,
                }).ConfigureAwait(false);
            }
            catch (Exception)
            {
                // Never fail a launch (or a later page) over geometry.
            }
        }

        // Pages opened after the launch (including window.open from the site) need it as well. The
        // handler cannot be awaited, so it is fire-and-forget with the same swallow.
        context.Page += (_, page) => { _ = ApplyAsync(page); };
        foreach (var page in context.Pages.ToArray())
            await ApplyAsync(page).ConfigureAwait(false);
    }

    /// <summary><c>inner &lt;= outer &lt;= avail &lt;= screen</c> on both axes — the chain a real window satisfies.</summary>
    public static bool GeometryIsCoherent(int[] screen, int[] avail, int[] inner, int[] outer) =>
        inner[0] <= outer[0] && inner[1] <= outer[1]
        && outer[0] <= avail[0] && outer[1] <= avail[1]
        && avail[0] <= screen[0] && avail[1] <= screen[1];
}
