using Microsoft.Playwright;
using Xunit;

namespace Clearcote.Tests;

/// <summary>
/// Live-engine geometry tests. Skipped unless CLEARCOTE_LIVE_ENGINE points at a chrome binary
/// (add CLEARCOTE_LICENSE_KEY for a PRO build). These belong in the release gate.
/// </summary>
/// <remarks>
/// Unit tests with a faked page cannot catch a binding mismatch: the Node port's window fit silently
/// did nothing for a while because Playwright's JS binding evaluates an arrow-function STRING to a
/// function object instead of calling it, and the fake — which sniffed the string — happily played
/// along. Only a real browser catches that class of bug, and .NET's EvaluateAsync has the same
/// expression-vs-function ambiguity, so it needs its own live check.
/// </remarks>
public class GeometryLiveTests
{
    private static string? LiveExe => Environment.GetEnvironmentVariable("CLEARCOTE_LIVE_ENGINE");

    private record Measured(
        int[] Screen, int[] Avail, int[] Inner, int[] Outer, int[] Pos, int Resizes, bool MediaAgrees = true);

    private const string ReadJs =
        "[[screen.width, screen.height], [screen.availWidth, screen.availHeight], " +
        "[innerWidth, innerHeight], [outerWidth, outerHeight], [screenX, screenY], " +
        "[window.__resizes | 0], " +
        "[+matchMedia(`(device-width: ${screen.width}px) and (device-height: ${screen.height}px)`).matches]]";

    private static async Task<(Measured First, Measured SecondTab)> MeasureBothAsync(string? fingerprint)
    {
        var dir = Path.Combine(Path.GetTempPath(), "cc-live2-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        try
        {
            var context = await Clearcote.LaunchPersistentContextAsync(dir, new LaunchOptions
            {
                ExecutablePath = LiveExe, Args = new[] { "--no-sandbox" }, Quiet = true,
                Fingerprint = fingerprint,
            }).ConfigureAwait(false);
            try
            {
                await context.AddInitScriptAsync(
                    "window.__resizes = 0; addEventListener('resize', () => { window.__resizes++; }, true);")
                    .ConfigureAwait(false);
                var first = await ReadAsync(await context.NewPageAsync().ConfigureAwait(false)).ConfigureAwait(false);
                var second = await ReadAsync(await context.NewPageAsync().ConfigureAwait(false)).ConfigureAwait(false);
                return (first, second);
            }
            finally
            {
                await context.CloseAsync().ConfigureAwait(false);
            }
        }
        finally
        {
            TestTemp.Remove(dir);
        }
    }

    private static async Task<Measured> ReadAsync(IPage page)
    {
        await page.GotoAsync("data:text/html,<body style='margin:0'>geo</body>").ConfigureAwait(false);
        await page.WaitForTimeoutAsync(700).ConfigureAwait(false);
        var m = await page.EvaluateAsync<int[][]>(ReadJs).ConfigureAwait(false);
        return new Measured(m[0], m[1], m[2], m[3], m[4], m[5][0], m[6][0] == 1);
    }

    private static async Task<Measured> MeasureAsync(string? fingerprint)
    {
        var dir = Path.Combine(Path.GetTempPath(), "cc-live-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        try
        {
            var context = await Clearcote.LaunchPersistentContextAsync(dir, new LaunchOptions
            {
                ExecutablePath = LiveExe,
                Args = new[] { "--no-sandbox" },
                Quiet = true,
                Fingerprint = fingerprint,
            }).ConfigureAwait(false);
            try
            {
                // Runs before any page script: if the window were resized after a page starts
                // running JS, a detector would see a resize event and a jump in innerWidth.
                await context.AddInitScriptAsync(
                    "window.__resizes = 0; addEventListener('resize', () => { window.__resizes++; }, true);")
                    .ConfigureAwait(false);
                var page = await context.NewPageAsync().ConfigureAwait(false);
                await page.GotoAsync("data:text/html,<body style='margin:0'>geo</body>").ConfigureAwait(false);
                await page.WaitForTimeoutAsync(700).ConfigureAwait(false);   // first paint
                var m = await page.EvaluateAsync<int[][]>(ReadJs).ConfigureAwait(false);
                return new Measured(m[0], m[1], m[2], m[3], m[4], m[5][0], m[6][0] == 1);
            }
            finally
            {
                await context.CloseAsync().ConfigureAwait(false);
            }
        }
        finally
        {
            TestTemp.Remove(dir);
        }
    }

    // No Skippable* package here (and not worth a new test dependency), so an unset
    // CLEARCOTE_LIVE_ENGINE makes these no-op instead of failing the normal suite.
    [Fact]
    public async Task Regime1_PersonaOwnsTheScreen_AndTheWindowIsMaximized()
    {
        if (string.IsNullOrEmpty(LiveExe)) return;
        var m = await MeasureAsync("live-geo-dotnet");

        Assert.True(Geometry.GeometryIsCoherent(m.Screen, m.Avail, m.Inner, m.Outer),
            $"live geometry escapes its screen: screen={Fmt(m.Screen)} avail={Fmt(m.Avail)} " +
            $"inner={Fmt(m.Inner)} outer={Fmt(m.Outer)}");
        // screen must not have collapsed onto the viewport — that collapse is the original bug
        Assert.NotEqual(Fmt(m.Screen), Fmt(m.Inner));
        // the persona reserves a taskbar
        Assert.True(m.Avail[1] < m.Screen[1], "persona reported no taskbar");
        // the fit maximized into the work area — the assertion that catches a silently no-op fit
        Assert.Equal(Fmt(m.Avail), Fmt(m.Outer));
        // and it happened on about:blank, before the page ran any script
        Assert.Equal(0, m.Resizes);
    }

    /// Maximized on its display, whatever frame this platform's engine draws (linux 8x131 vs windows
    /// 16x134 is why nothing is sized against a constant any more).
    private static void AssertMaximizedOnTheDisplay(Measured m, string label = "")
    {
        var at = $"{label} screen={Fmt(m.Screen)} avail={Fmt(m.Avail)} inner={Fmt(m.Inner)} outer={Fmt(m.Outer)}";
        Assert.True(Geometry.GeometryIsCoherent(m.Screen, m.Avail, m.Inner, m.Outer), $"escapes its screen: {at}");
        Assert.True(Fmt(m.Avail) == Fmt(m.Outer), $"not fitted to the work area: {at}");
        Assert.True(m.Pos[0] == 0 && m.Pos[1] == 0, $"not at the origin: {at} pos={m.Pos[0]},{m.Pos[1]}");
        var (dx, dy) = (m.Outer[0] - m.Inner[0], m.Outer[1] - m.Inner[1]);
        Assert.True(dx is >= 0 and <= 16 && dy is >= 60 and <= 160, $"implausible frame ({dx}, {dy}): {at}");
    }

    [Fact]
    public async Task Regime2_SeedlessDisplayIsTheCrossSdkRow_AndTheWindowIsMaximized()
    {
        if (string.IsNullOrEmpty(LiveExe)) return;
        var m = await MeasureAsync(null);
        var (screen, _) = Geometry.HeadlessGeometry(null);
        var display = Geometry.HeadlessDisplay(null, Array.Empty<string>());

        Assert.Equal($"{screen.Width}x{screen.Height}", Fmt(m.Screen));
        Assert.Equal($"{display.AvailWidth}x{display.AvailHeight}", Fmt(m.Avail));
        // a real display, not an emulated screen: device-width media queries agree with screen.*
        Assert.True(m.MediaAgrees, "device-width media query disagrees with screen.*");
        AssertMaximizedOnTheDisplay(m);
        Assert.Equal(0, m.Resizes);
    }

    [Fact]
    public async Task Regime2_ASecondTabSharesTheDisplayAndTheWindow()
    {
        if (string.IsNullOrEmpty(LiveExe)) return;
        var (first, second) = await MeasureBothAsync(null);
        foreach (var (label, m) in new[] { ("first page", first), ("second tab", second) })
        {
            AssertMaximizedOnTheDisplay(m, label);
            Assert.Equal(0, m.Resizes);
        }
        Assert.Equal(Fmt(first.Inner), Fmt(second.Inner));
    }

    [Fact]
    public async Task LaunchAsync_SetsTheDisplay_SoTheDocumentedFitMaximizes()
    {
        // LaunchAsync hands back an IBrowser the SDK cannot hook, but the display is a command-line
        // switch, so the workaround its docs give (NoViewport + the public fit) lands on a real screen.
        if (string.IsNullOrEmpty(LiveExe)) return;
        var browser = await Clearcote.LaunchAsync(new LaunchOptions
        {
            ExecutablePath = LiveExe, Args = new[] { "--no-sandbox" }, Quiet = true,
        }).ConfigureAwait(false);
        try
        {
            var page = await browser.NewPageAsync(new() { ViewportSize = ViewportSize.NoViewport }).ConfigureAwait(false);
            await Geometry.FitWindowToWorkAreaAsync(page).ConfigureAwait(false);
            AssertMaximizedOnTheDisplay(await ReadAsync(page).ConfigureAwait(false), "fitted page");
        }
        finally
        {
            await browser.CloseAsync().ConfigureAwait(false);
        }
    }

    private static string Fmt(int[] pair) => $"{pair[0]}x{pair[1]}";
}
