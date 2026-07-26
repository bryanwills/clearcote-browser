using System.IO.Compression;
using System.Text;
using System.Text.Json;
using Clearcote;
using Microsoft.Playwright;
using Xunit;

namespace Clearcote.Tests;

/// <summary>
/// Headless window-geometry tests.
/// </summary>
/// <remarks>
/// A default headless launch used to report a window LARGER than the screen it claims to be on
/// (screen 1280x720, outer 1288x851) — not a subtle statistical tell but a state no real browser can
/// be in, readable with two property lookups. These lock down the frame arithmetic, the regime split
/// (with --fingerprint the engine's persona owns screen/avail and the SDK only fits the window;
/// without it the SDK overrides screen itself), and the rule that a caller's own geometry always wins.
///
/// PARITY: the vector below is duplicated verbatim in sdk/python/tests/test_geometry.py and
/// sdk/node/test/geometry.test.ts. A seed must select the same persona in every SDK, or a persona
/// stops being portable between them.
/// </remarks>
public class GeometryTests
{
    // ─────────────────────────────────────────────────────── frame arithmetic
    [Fact]
    public void EveryProfileRowLeavesAWindowThatFitsItsScreen()
    {
        foreach (var (w, h, _, _) in Geometry.HeadlessScreenProfiles)
        {
            var inner = new[] { w - Geometry.EngineFrameWidth, h - Geometry.EngineFrameHeight };
            var outer = new[] { inner[0] + Geometry.EngineFrameWidth, inner[1] + Geometry.EngineFrameHeight };
            // CDP forces avail == screen (measured), so that is what a page will read.
            Assert.True(Geometry.GeometryIsCoherent(new[] { w, h }, new[] { w, h }, inner, outer),
                $"{w}x{h}: window escapes its screen");
        }
    }

    [Fact]
    public void ViewportIsDerivedFromWhicheverScreenTheSeedSelected()
    {
        var table = Geometry.HeadlessScreenProfiles.Select(p => (p.Width, p.Height)).ToHashSet();
        for (var i = 0; i < 200; i++)
        {
            var (screen, viewport) = Geometry.HeadlessGeometry($"formula-{i}");
            Assert.Contains((screen.Width, screen.Height), table);
            Assert.Equal(screen.Width - Geometry.EngineFrameWidth, viewport.Width);
            Assert.Equal(screen.Height - Geometry.EngineFrameHeight, viewport.Height);
        }
    }

    [Fact]
    public void CoherenceCheckRejectsThePreFixDefault()
    {
        // If the invariant accepted this, it would not have caught anything.
        Assert.False(Geometry.GeometryIsCoherent(
            new[] { 1280, 720 }, new[] { 1280, 720 }, new[] { 1280, 720 }, new[] { 1288, 851 }));
    }

    [Fact]
    public void WindowLandsFlushWithTheScreenEdge()
    {
        var (screen, viewport) = Geometry.HeadlessGeometry("flush");
        Assert.Equal(screen.Width, viewport.Width + Geometry.EngineFrameWidth);
        Assert.Equal(screen.Height, viewport.Height + Geometry.EngineFrameHeight);
    }

    // ─────────────────────────────────────────────────────── selection
    [Fact]
    public void SelectionIsDeterministicAndSeedlessIsStableRatherThanRandom()
    {
        var a = Geometry.HeadlessGeometry("abc");
        var b = Geometry.HeadlessGeometry("abc");
        Assert.Equal((a.Screen.Width, a.Screen.Height), (b.Screen.Width, b.Screen.Height));

        var n1 = Geometry.HeadlessGeometry(null);
        var n2 = Geometry.HeadlessGeometry("");
        Assert.Equal((n1.Screen.Width, n1.Screen.Height), (n2.Screen.Width, n2.Screen.Height));
    }

    [Fact]
    public void EveryRowIsReachableAndWeightingFollowsTheCorpus()
    {
        var seen = new Dictionary<(int, int), int>();
        for (var i = 0; i < 4000; i++)
        {
            var (screen, _) = Geometry.HeadlessGeometry($"s{i}");
            var key = (screen.Width, screen.Height);
            seen[key] = seen.GetValueOrDefault(key) + 1;
        }
        Assert.Equal(Geometry.HeadlessScreenProfiles.Length, seen.Count);
        Assert.Equal(seen.Values.Max(), seen[(1920, 1080)]);
        // the capped ultrawide must stay rare
        Assert.True(seen.GetValueOrDefault((3440, 1440)) / 4000.0 < 0.08);
    }

    [Theory]
    [InlineData(null, 1920, 1080, 1912, 949)]
    [InlineData("", 1920, 1080, 1912, 949)]
    [InlineData("seed-1", 1920, 1200, 1912, 1069)]
    [InlineData("acct-42", 1366, 768, 1358, 637)]
    [InlineData("clearcote", 2560, 1440, 2552, 1309)]
    [InlineData("x", 2560, 1440, 2552, 1309)]
    [InlineData("y", 3440, 1440, 3432, 1309)]
    [InlineData("z", 1920, 1080, 1912, 949)]
    [InlineData("12345", 1920, 1080, 1912, 949)]
    public void CrossSdkParityVector(string? seed, int sw, int sh, int vw, int vh)
    {
        var (screen, viewport) = Geometry.HeadlessGeometry(seed);
        Assert.Equal((sw, sh), (screen.Width, screen.Height));
        Assert.Equal((vw, vh), (viewport.Width, viewport.Height));
    }

    // ─────────────────────────────────────────────────────── regime detection
    [Fact]
    public void PersonaActiveTracksTheFingerprintSwitchNotTheOption()
    {
        // LightStealth passes a seed to the SDK but deliberately drops --fingerprint, so no persona runs.
        Assert.True(Geometry.PersonaActive(new[] { "--fingerprint=abc", "--no-sandbox" }));
        Assert.False(Geometry.PersonaActive(new[] { "--fingerprint-platform=windows", "--fingerprint-screen-width=1920" }));
        Assert.False(Geometry.PersonaActive(Array.Empty<string>()));
        Assert.False(Geometry.PersonaActive(null));
    }

    [Fact]
    public void CallerSizedTheWindowDetectsEveryWindowFlag()
    {
        Assert.True(Geometry.CallerSizedTheWindow(new[] { "--window-size=1920,1080" }));
        Assert.True(Geometry.CallerSizedTheWindow(new[] { "--window-position=0,0" }));
        Assert.True(Geometry.CallerSizedTheWindow(new[] { "--start-maximized" }));
        Assert.False(Geometry.CallerSizedTheWindow(new[] { "--no-sandbox", "--fingerprint=x" }));
    }

    // ─────────────────────────────────────────────────────── resolve / skip rules
    [Theory]
    [InlineData(null)]
    [InlineData(true)]
    public void RegimeTwoAppliesScreenAndViewportWhenHeadless(bool? headless)
    {
        var r = Geometry.Resolve(headless, "seed", new[] { "--no-sandbox" }, callerSetGeometry: false);
        var expected = Geometry.HeadlessGeometry("seed");
        Assert.Equal(Geometry.Mode.Profile, r.Mode);
        Assert.Equal((expected.Screen.Width, expected.Screen.Height), (r.Screen!.Width, r.Screen.Height));
        Assert.Equal((expected.Viewport.Width, expected.Viewport.Height), (r.Viewport!.Width, r.Viewport.Height));
    }

    [Fact]
    public void RegimeOneLeavesScreenToThePersona()
    {
        // Setting screen here would be a silent no-op: the persona's value beats the CDP override.
        var r = Geometry.Resolve(true, "seed", new[] { "--fingerprint=seed" }, callerSetGeometry: false);
        Assert.Equal(Geometry.Mode.Persona, r.Mode);
        Assert.Null(r.Screen);
        Assert.Null(r.Viewport);
    }

    [Fact]
    public void SkippedWhenHeaded()
    {
        var r = Geometry.Resolve(false, "seed", new[] { "--fingerprint=seed" }, callerSetGeometry: false);
        Assert.Equal(Geometry.Mode.None, r.Mode);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void NeverOverridesACallerWhoSetTheirOwnGeometry(bool persona)
    {
        var args = persona ? new[] { "--fingerprint=seed" } : new[] { "--no-sandbox" };
        var r = Geometry.Resolve(true, "seed", args, callerSetGeometry: true);
        Assert.Equal(Geometry.Mode.None, r.Mode);
        Assert.Null(r.Screen);
        Assert.Null(r.Viewport);
    }

    // ─────────────────────────────────────────────────────── the imported profile's screen
    /// Encode a capture the way Fingerprint.Args does (gzip+base64 on --fingerprint-profile).
    private static string ProfileArg(object profile)
    {
        var json = JsonSerializer.Serialize(profile);
        using var buffer = new MemoryStream();
        using (var gz = new GZipStream(buffer, CompressionLevel.Optimal, leaveOpen: true))
        {
            var bytes = Encoding.UTF8.GetBytes(json);
            gz.Write(bytes, 0, bytes.Length);
        }
        return "--fingerprint-profile=" + Convert.ToBase64String(buffer.ToArray());
    }

    [Fact]
    public void ProfileScreenIsReadOffTheSwitch()
    {
        var arg = ProfileArg(new { screen = new { width = 3440, height = 1440 } });
        Assert.Equal((3440, 1440), Geometry.ProfileScreenFromArgs(new[] { arg, "--no-sandbox" }));
    }

    [Fact]
    public void ImportedDisplayIsUsedInsteadOfACorpusPick()
    {
        // Otherwise every seedless profile launch shares one screen and the imported identity is lost.
        var arg = ProfileArg(new { screen = new { width = 2560, height = 1440 } });
        var r = Geometry.Resolve(true, "some-seed", new[] { arg }, callerSetGeometry: false);
        Assert.Equal(Geometry.Mode.Profile, r.Mode);
        Assert.Equal((2560, 1440), (r.Screen!.Width, r.Screen.Height));
        Assert.Equal((2560 - Geometry.EngineFrameWidth, 1440 - Geometry.EngineFrameHeight),
            (r.Viewport!.Width, r.Viewport.Height));
    }

    [Fact]
    public void ProfileScreenTooSmallFallsBackToTheCorpus()
    {
        // profile="auto" resolved on a headless host can carry the 800x600 headless surface (measured).
        var arg = ProfileArg(new { screen = new { width = 800, height = 600 } });
        Assert.Null(Geometry.ProfileScreenFromArgs(new[] { arg }));
        var r = Geometry.Resolve(true, "seed", new[] { arg }, callerSetGeometry: false);
        var (corpus, _) = Geometry.HeadlessGeometry("seed");
        Assert.Equal((corpus.Width, corpus.Height), (r.Screen!.Width, r.Screen.Height));
    }

    [Theory]
    [InlineData("--fingerprint-profile=not-base64!!")]
    [InlineData("--fingerprint-profile=")]
    [InlineData("--fingerprint-profile=aGVsbG8=")]
    public void AnUnreadableProfileNeverBreaksTheLaunch(string arg)
    {
        Assert.Null(Geometry.ProfileScreenFromArgs(new[] { arg }));
        Assert.Equal(Geometry.Mode.Profile,
            Geometry.Resolve(true, "seed", new[] { arg }, callerSetGeometry: false).Mode);
    }

    [Fact]
    public void ProfileWithoutAScreenBlockFallsBack()
    {
        var arg = ProfileArg(new { navigator = new { platform = "Win32" } });
        Assert.Null(Geometry.ProfileScreenFromArgs(new[] { arg }));
    }

    [Fact]
    public void ASeedBesideAProfileStillTakesThePersonaRegime()
    {
        // With --fingerprint present the ENGINE applies the profile's screen, so the SDK keeps out.
        var arg = ProfileArg(new { screen = new { width = 2560, height = 1440 } });
        var r = Geometry.Resolve(true, "seed", new[] { arg, "--fingerprint=seed" }, callerSetGeometry: false);
        Assert.Equal(Geometry.Mode.Persona, r.Mode);
        Assert.Null(r.Screen);
    }

    // ─────────────────────────────────────────────────────── the fit correction
    [Fact]
    public void FitPlanAddsBackExactlyTheMeasuredShortfall()
    {
        // On 149 the window reports 33px below the bounds height it was handed, so one fit lands short.
        Assert.Equal((1920, 1073), Geometry.FitPlan(new[] { 1920, 1040 }, new[] { 1920, 1007 }));
        // never asks for more than the shortfall
        Assert.Equal((1940, 1040), Geometry.FitPlan(new[] { 1920, 1040 }, new[] { 1900, 1040 }));
    }

    [Fact]
    public void CallerWindowPositionSuppressesBothTheFitAndTheOriginMove()
    {
        // Both window fixups defer to a caller who positioned or sized the window themselves.
        Assert.True(Geometry.CallerSizedTheWindow(new[] { "--window-position=100,100" }));
    }

    [Fact]
    public void FitPlanIsNullWhenTheWindowAlreadyFillsTheWorkArea()
    {
        Assert.Null(Geometry.FitPlan(new[] { 1920, 1040 }, new[] { 1920, 1040 }));
        // and never shrinks a window that somehow overshot
        Assert.Null(Geometry.FitPlan(new[] { 1920, 1040 }, new[] { 1930, 1050 }));
    }
}
