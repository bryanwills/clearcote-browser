namespace Clearcote;

/// Automation-hygiene warnings for launch and serve (mirrors the automation-hygiene part of the
/// Python clearcote/_warnings.py and Node warnings.ts). Never blocks a launch; printed to stderr
/// unless <see cref="LaunchOptions.Quiet"/> or CLEARCOTE_NO_WARN is set.
public static class LaunchWarnings
{
    /// One warning: a stable <c>Code</c> plus the message printed to stderr.
    public sealed record Warning(string Code, string Message);

    /// Warnings for the caller's own browser <paramref name="userArgs"/>.
    public static List<Warning> ForArgs(IEnumerable<string>? userArgs)
    {
        var args = (userArgs ?? Array.Empty<string>()).Where(a => a is not null).ToArray();
        var outList = new List<Warning>();
        if (args.Any(a => a.Contains("--enable-automation", StringComparison.Ordinal) ||
                          a.StartsWith("--remote-debugging-port", StringComparison.Ordinal)))
            outList.Add(new("automation-arg",
                "your args re-introduce an automation flag (--enable-automation / --remote-debugging-port) the SDK " +
                "strips by default - a strong webdriver/CDP tell."));
        if (args.Any(a => a.StartsWith("--auto-open-devtools-for-tabs", StringComparison.Ordinal)))
            outList.Add(new("devtools-open",
                "DevTools is set to open (--auto-open-devtools-for-tabs). Pages can detect an open DevTools " +
                "(debugger and console timing probes; a docked panel also makes innerWidth/innerHeight disagree " +
                "with outerWidth/outerHeight). Leave it closed for real runs."));
        if (args.Any(a => a.StartsWith("--user-agent=", StringComparison.Ordinal)))
            outList.Add(new("custom-user-agent",
                "a custom user agent (--user-agent / a context UserAgent) replaces only the User-Agent string: " +
                "navigator.userAgentData, the Sec-CH-UA headers, navigator.platform and the rest of the persona " +
                "keep describing the persona, so a different OS or version in the string is a one-line mismatch. " +
                "Use Platform, Brand and BrandVersion to change what the browser claims."));
        outList.AddRange(CdpExposure(SwitchValue(args, "--remote-debugging-address"),
                                     SwitchValue(args, "--remote-allow-origins")));
        return outList;
    }

    /// The cdp-public-bind / cdp-any-origin warnings for serve's bind address and origin list.
    public static List<Warning> ForServe(string host, string allowOrigins) => CdpExposure(host, allowOrigins);

    /// Print <paramref name="warnings"/> to stderr unless <paramref name="quiet"/> or CLEARCOTE_NO_WARN.
    public static void Emit(IEnumerable<Warning> warnings, bool quiet)
    {
        if (quiet || !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("CLEARCOTE_NO_WARN"))) return;
        foreach (var w in warnings) Console.Error.WriteLine($"clearcote: warning: {w.Message}");
    }

    // The value of the LAST name=value in args (Chromium keeps the last), else null.
    private static string? SwitchValue(IEnumerable<string> args, string name)
    {
        string? value = null;
        foreach (var a in args)
            if (a.StartsWith(name + "=", StringComparison.Ordinal)) value = a[(name.Length + 1)..];
        return value;
    }

    private static bool IsLoopback(string host)
    {
        var h = host.Trim().Trim('[', ']').ToLowerInvariant();
        return h == "localhost" || h == "::1" || h.StartsWith("127.", StringComparison.Ordinal);
    }

    private static List<Warning> CdpExposure(string? bindAddress, string? allowOrigins)
    {
        var outList = new List<Warning>();
        if (bindAddress is not null && !IsLoopback(bindAddress))
            outList.Add(new("cdp-public-bind",
                $"the DevTools endpoint is bound to {bindAddress}, not loopback: anyone who can reach that port can " +
                "drive the browser, read its cookies and run code in its pages. Keep it on 127.0.0.1 and tunnel to " +
                "it if you need remote access."));
        if (allowOrigins is not null && allowOrigins.Split(',').Any(o => o.Trim() == "*"))
            outList.Add(new("cdp-any-origin",
                "--remote-allow-origins=* lets any web page this browser (or any browser on this machine) opens " +
                "connect to the DevTools endpoint and take it over. List the origins you need instead."));
        return outList;
    }
}
