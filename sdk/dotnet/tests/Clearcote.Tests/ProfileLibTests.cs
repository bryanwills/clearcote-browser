using Clearcote;
using Xunit;

namespace Clearcote.Tests;

/// Mirrors the Node and Python SDK profilelib tests. The three implementations must agree —
/// a persona chosen on one must be the persona chosen on another for the same host and key.
public class ProfileLibTests
{
    private static HostFacts Host() => new()
    {
        OsFamily = "windows",
        BrowserMajor = 150,
        GpuVendor = "intel",
        GpuTier = 0,
        ScreenWidth = 3440,
        ScreenHeight = 1440,
        DevicePixelRatio = 1,
        HardwareConcurrency = 16,
        DeviceMemory = 16,
    };

    private static ProfileIndexEntry Entry(string id, Action<ProfileIndexEntry>? over = null)
    {
        var e = new ProfileIndexEntry
        {
            Id = id,
            OsFamily = "windows",
            BrowserMajor = 150,
            GpuVendor = "intel",
            GpuTier = 0,
            ScreenWidth = 1920,
            ScreenHeight = 1080,
            DevicePixelRatio = 1,
            HardwareConcurrency = 16,
            DeviceMemory = 16,
            EncodedSize = 10000,
            CapturedAt = DateTimeOffset.UtcNow.ToString("O"),
        };
        over?.Invoke(e);
        return e;
    }

    [Theory]
    [InlineData("ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 (0x0000220A) Direct3D11 vs_5_0 ps_5_0, D3D11)", "nvidia")]
    [InlineData("ANGLE (Intel, Intel(R) UHD Graphics 770 (0xA780) Direct3D11 vs_5_0 ps_5_0, D3D11)", "intel")]
    [InlineData("ANGLE (AMD, AMD Radeon RX 6800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)", "amd")]
    [InlineData("ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)", "apple")]
    [InlineData("Google SwiftShader", "software")]
    [InlineData("llvmpipe (LLVM 15.0.7, 256 bits)", "software")]
    [InlineData("", "unknown")]
    [InlineData(null, "unknown")]
    public void GpuVendorClass_ClassifiesRealStrings(string? renderer, string expected)
        => Assert.Equal(expected, ProfileLib.GpuVendorClass(renderer));

    [Fact]
    public void Eligible_RejectsMismatchedOs()
        => Assert.False(ProfileLib.Eligible(Entry("a", e => e.OsFamily = "linux"), Host()));

    [Fact]
    public void Eligible_RejectsMismatchedMajor_EvenWhenOtherwisePerfect()
    {
        // A Chrome-138 capture on a 150 engine contradicts itself; no score should rescue it.
        var perfectButOld = Entry("old", e =>
        {
            e.BrowserMajor = 138;
            e.ScreenWidth = 3440;
            e.ScreenHeight = 1440;
        });
        Assert.True(ProfileLib.ScoreProfile(perfectButOld, Host()) > 0.8);
        Assert.False(ProfileLib.Eligible(perfectButOld, Host()));
    }

    [Fact]
    public void Eligible_RejectsOversizedPayload()
    {
        Assert.False(ProfileLib.Eligible(Entry("big", e => e.EncodedSize = ProfileLib.DefaultMaxEncoded + 1), Host()));
        Assert.True(ProfileLib.Eligible(Entry("ok", e => e.EncodedSize = ProfileLib.DefaultMaxEncoded - 1), Host()));
    }

    [Fact]
    public void Score_MatchingGpuBeatsMismatch()
        => Assert.True(
            ProfileLib.ScoreProfile(Entry("m", e => e.GpuVendor = "intel"), Host()) >
            ProfileLib.ScoreProfile(Entry("x", e => e.GpuVendor = "nvidia"), Host()));

    [Fact]
    public void Score_SoftwareRasterizerIsLowest()
        => Assert.True(
            ProfileLib.ScoreProfile(Entry("sw", e => e.GpuVendor = "software"), Host()) <
            ProfileLib.ScoreProfile(Entry("real", e => e.GpuVendor = "nvidia"), Host()));

    [Fact]
    public void Score_LargerScreenPenalisedMoreThanSmaller()
    {
        // Claiming a display the host cannot contain is the documented block trigger, so the
        // asymmetry is deliberate — assert it rather than assume it.
        var smaller = Entry("s", e => { e.ScreenWidth = 1920; e.ScreenHeight = 1080; });
        var larger = Entry("l", e => { e.ScreenWidth = 5120; e.ScreenHeight = 2880; });
        Assert.True(ProfileLib.ScoreProfile(smaller, Host()) > ProfileLib.ScoreProfile(larger, Host()));
    }

    [Fact]
    public void Score_FresherPreferred()
    {
        var fresh = Entry("f", e => e.CapturedAt = DateTimeOffset.UtcNow.ToString("O"));
        var stale = Entry("s", e => e.CapturedAt = DateTimeOffset.UtcNow.AddDays(-900).ToString("O"));
        Assert.True(ProfileLib.ScoreProfile(fresh, Host()) > ProfileLib.ScoreProfile(stale, Host()));
    }

    private static List<ProfileIndexEntry> Index() =>
        Enumerable.Range(0, 40)
            .Select(i => Entry($"p{i}", e =>
            {
                e.ScreenWidth = 1280 + i * 16;
                e.HardwareConcurrency = 8 + (i % 8);
            }))
            .ToList();

    [Fact]
    public void Best_IsTopScoringAndStable()
    {
        var a = ProfileLib.SelectProfile(Index(), Host(), SelectMode.Best);
        var b = ProfileLib.SelectProfile(Index(), Host(), SelectMode.Best);
        Assert.Equal(a.Entry.Id, b.Entry.Id);
        var top = Index().OrderByDescending(e => ProfileLib.ScoreProfile(e, Host())).First();
        Assert.Equal(top.Id, a.Entry.Id);
    }

    [Fact]
    public void Rotate_IsStickyPerKey()
    {
        var ids = Enumerable.Range(0, 5)
            .Select(_ => ProfileLib.SelectProfile(Index(), Host(), SelectMode.Rotate, "account-42").Entry.Id)
            .Distinct()
            .Count();
        Assert.Equal(1, ids);
    }

    [Fact]
    public void Rotate_SpreadsAcrossKeys()
    {
        // The whole point is not converging on one identity.
        var ids = Enumerable.Range(0, 60)
            .Select(i => ProfileLib.SelectProfile(Index(), Host(), SelectMode.Rotate, $"acct-{i}").Entry.Id)
            .Distinct()
            .Count();
        Assert.True(ids > 5, $"expected spread across the pool, got {ids} distinct");
    }

    [Fact]
    public void KeylessRotate_IsStableNotRandom()
    {
        // An identity whose device changes every launch is a harder tell than a fixed one.
        var ids = Enumerable.Range(0, 5)
            .Select(_ => ProfileLib.SelectProfile(Index(), Host()).Entry.Id)
            .Distinct()
            .Count();
        Assert.Equal(1, ids);
    }

    [Fact]
    public void TopN_BoundsThePool()
    {
        var ids = Enumerable.Range(0, 60)
            .Select(i => ProfileLib.SelectProfile(Index(), Host(), SelectMode.Rotate, $"k{i}", topN: 3).Entry.Id)
            .Distinct()
            .Count();
        Assert.True(ids <= 3);
    }

    [Fact]
    public void ReportsPoolSize()
        => Assert.Equal(40, ProfileLib.SelectProfile(Index(), Host()).PoolSize);

    [Fact]
    public void Throws_RatherThanReturningIncoherentProfile()
    {
        // A wrong persona is worse than none: it turns a clean browser into a contradictory one.
        var idx = new List<ProfileIndexEntry>
        {
            Entry("a", e => e.BrowserMajor = 138),
            Entry("b", e => e.OsFamily = "linux"),
        };
        var ex = Assert.Throws<InvalidOperationException>(() => ProfileLib.SelectProfile(idx, Host()));
        Assert.Contains("no profile matches host", ex.Message);
    }

    [Fact]
    public void Error_NamesTheReason()
    {
        var ex = Assert.Throws<InvalidOperationException>(
            () => ProfileLib.SelectProfile(new List<ProfileIndexEntry>(), Host()));
        Assert.Contains("chromium major=150", ex.Message);
    }

    [Fact]
    public void VersionAgnostic_ProfileIsEligibleOnAnyEngine()
    {
        // The chrome-fingerprints case: records are Chrome ~114/115, the engine is 150, and
        // convert_dataset.py drops the version precisely so there is nothing to disagree with.
        var e = Entry("hw-only", x => x.BrowserMajor = null);
        Assert.True(ProfileLib.Eligible(e, Host()));
        var otherEngine = Host();
        otherEngine.BrowserMajor = 138;
        Assert.True(ProfileLib.Eligible(e, otherEngine));
    }

    [Fact]
    public void PinnedWrongVersion_IsStillRejected()
    {
        // Pinning a version and getting it wrong IS a contradiction — UA says 138 while the
        // engine behaves like 150 — unlike carrying no version at all.
        Assert.False(ProfileLib.Eligible(Entry("old", x => x.BrowserMajor = 138), Host()));
    }

    [Fact]
    public void PlatformToken_MatchesNodeAndPython()
    {
        // Node's process.platform and Python's sys.platform both yield these exact strings, and
        // the keyless sticky key is hashed from them — so the same machine must resolve to the
        // same persona whichever SDK launched it.
        Assert.Contains(ProfileLib.PlatformToken(), new[] { "win32", "darwin", "linux", "unknown" });
    }
}
