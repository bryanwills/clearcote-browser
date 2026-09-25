using Xunit;

namespace Clearcote.Tests;

// Automation-hygiene warnings (mirrors the Python and Node tests).
public class LaunchWarningsTests
{
    private static HashSet<string> Codes(params string[] args)
        => LaunchWarnings.ForArgs(args).Select(w => w.Code).ToHashSet();

    [Fact]
    public void Coherent_args_are_silent() => Assert.Empty(LaunchWarnings.ForArgs(new[] { "--lang=de" }));

    [Fact]
    public void Flags_automation_devtools_and_user_agent()
    {
        Assert.Contains("automation-arg", Codes("--enable-automation"));
        Assert.Contains("devtools-open", Codes("--auto-open-devtools-for-tabs"));
        Assert.Contains("custom-user-agent", Codes("--user-agent=Mozilla/5.0 Foo"));
    }

    [Fact]
    public void Flags_an_exposed_devtools_endpoint_last_value_wins()
    {
        Assert.Contains("cdp-public-bind", Codes("--remote-debugging-address=0.0.0.0"));
        Assert.DoesNotContain("cdp-public-bind", Codes("--remote-debugging-address=127.0.0.1"));
        Assert.DoesNotContain("cdp-public-bind", Codes("--remote-debugging-address=0.0.0.0", "--remote-debugging-address=::1"));
        Assert.Contains("cdp-any-origin", Codes("--remote-allow-origins=*"));
        Assert.Contains("cdp-any-origin", Codes("--remote-allow-origins=http://a.test, *"));
        Assert.DoesNotContain("cdp-any-origin", Codes("--remote-allow-origins=http://127.0.0.1:9222"));
    }

    [Theory]
    [InlineData("127.0.0.1", "http://127.0.0.1:9222,http://localhost:9222", "")]
    [InlineData("localhost", "http://localhost:9222", "")]
    [InlineData("[::1]", "http://localhost:9222", "")]
    [InlineData("0.0.0.0", "http://0.0.0.0:9222", "cdp-public-bind")]
    [InlineData("127.0.0.1", "*", "cdp-any-origin")]
    [InlineData("10.0.0.5", "*", "cdp-public-bind,cdp-any-origin")]
    public void Serve_bind_and_origins(string host, string origins, string expected)
        => Assert.Equal(expected, string.Join(",", LaunchWarnings.ForServe(host, origins).Select(w => w.Code)));

    [Fact]
    public void Emit_respects_quiet_and_no_warn()
    {
        var saved = Console.Error;
        var sw = new StringWriter();
        Console.SetError(sw);
        try
        {
            using var _ = new Sandbox().Env("CLEARCOTE_NO_WARN", null);
            // Count only this test's lines: other test classes may write to stderr in parallel.
            const string Mine = "bound to 203.0.113.9";
            int Count() => sw.ToString().Split(Mine).Length - 1;
            var ws = LaunchWarnings.ForServe("203.0.113.9", "*");
            LaunchWarnings.Emit(ws, quiet: true);
            Assert.Equal(0, Count());
            LaunchWarnings.Emit(ws, quiet: false);
            Assert.Equal(1, Count());
            Assert.Contains("--remote-allow-origins=* lets any web page", sw.ToString());
            using var __ = new Sandbox().Env("CLEARCOTE_NO_WARN", "1");
            sw.GetStringBuilder().Clear();
            LaunchWarnings.Emit(ws, quiet: false);
            Assert.Equal(0, Count());
        }
        finally
        {
            Console.SetError(saved);
        }
    }
}
