using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Clearcote;

/// Geo for an egress IP.
public sealed record GeoInfo(string? Ip, string? Country, string? Timezone, string? AcceptLanguage, string? Location);

/// Outcome of a geo resolution: the geo, or why there is none.
public sealed record GeoResult(GeoInfo? Geo, string? Reason, long ElapsedMs);

/// Thrown by a launch with <see cref="LaunchOptions.Geoip"/> when the region could not be resolved.
///
/// Failing closed is the point: continuing would launch with the host's clock and a default
/// language — UTC + en-US on most servers — which is exactly the mismatch geoip exists to prevent.
/// Set both <see cref="FingerprintOptions.Timezone"/> and <see cref="FingerprintOptions.AcceptLanguage"/>
/// to launch anyway when the lookup is unavailable.
public sealed class GeoipException : Exception
{
    public string Code => "GEOIP_UNRESOLVED";
    public GeoipException(string message) : base(message) { }
}

/// Region lookup for the connection a launch will use (ports geoip.ts).
///
/// Every lookup goes THROUGH the proxy (HTTP or SOCKS5), never from the host, or the timezone and
/// locale would describe the wrong place. The whole resolution is bounded by
/// CLEARCOTE_GEOIP_TIMEOUT_SECONDS (default 20).
///
/// Unlike the Node/Python SDKs there is no offline GeoIP database here: the geo comes from
/// ip-api.com through the proxy (the Node SDK's fallback path).
public static class GeoIp
{
    internal static string[] IpEchoUrls = { "http://api.ipify.org", "http://ip-api.com/line/?fields=query" };
    internal static string IpApiUrl = "http://ip-api.com/json/?fields=status,message,countryCode,timezone,lat,lon,query";

    private static readonly Regex Ipv4 = new(@"^(?:\d{1,3}\.){3}\d{1,3}$");
    private static readonly Regex Ipv6 = new(@"^[0-9a-fA-F:]+$");

    /// Whole-resolution budget in ms: CLEARCOTE_GEOIP_TIMEOUT_SECONDS (seconds, &gt; 0), default 20s.
    public static int TimeoutMs(string? envValue = null)
    {
        var raw = (envValue ?? Environment.GetEnvironmentVariable("CLEARCOTE_GEOIP_TIMEOUT_SECONDS") ?? "").Trim();
        return raw.Length > 0 && double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var n)
               && double.IsFinite(n) && n > 0
            ? (int)Math.Round(n * 1000)
            : 20_000;
    }

    private static bool LooksLikeIp(string s) => Ipv4.IsMatch(s) || (s.Contains(':') && Ipv6.IsMatch(s));

    private static async Task<string> GetTextAsync(HttpClient client, string url, int timeoutMs)
    {
        using var cts = new CancellationTokenSource(Math.Max(1, timeoutMs));
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.UserAgent.ParseAdd("clearcote-sdk");
        using var res = await client.SendAsync(req, cts.Token).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode) throw new HttpRequestException($"HTTP {(int)res.StatusCode}");
        return (await res.Content.ReadAsStringAsync(cts.Token).ConfigureAwait(false)).Trim();
    }

    private static async Task<string?> ExitIpAsync(HttpClient client, Stopwatch sw, int budget)
    {
        foreach (var url in IpEchoUrls)
        {
            var left = budget - (int)sw.ElapsedMilliseconds;
            if (left <= 0) break;
            try
            {
                var ip = (await GetTextAsync(client, url, Math.Min(left, 8000)).ConfigureAwait(false)).Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? "";
                if (LooksLikeIp(ip)) return ip;
            }
            catch { /* try next */ }
        }
        return null;
    }

    private static async Task<GeoInfo?> IpApiAsync(HttpClient client, Stopwatch sw, int budget)
    {
        var left = budget - (int)sw.ElapsedMilliseconds;
        if (left <= 0) return null;
        try
        {
            using var doc = JsonDocument.Parse(await GetTextAsync(client, IpApiUrl, Math.Min(left, 8000)).ConfigureAwait(false));
            var r = doc.RootElement;
            string? S(string k) => r.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            if (S("status") != "success") return null;
            var cc = S("countryCode");
            string? loc = r.TryGetProperty("lat", out var lat) && lat.ValueKind == JsonValueKind.Number
                          && r.TryGetProperty("lon", out var lon) && lon.ValueKind == JsonValueKind.Number
                ? $"{lat.GetDouble().ToString(CultureInfo.InvariantCulture)},{lon.GetDouble().ToString(CultureInfo.InvariantCulture)}"
                : null;
            return new GeoInfo(S("query"), cc, S("timezone"), AcceptLanguageForCountry(cc), loc);
        }
        catch { return null; }
    }

    /// Resolve geo for the egress (through <paramref name="proxy"/> if given — HTTP or SOCKS5 — else
    /// direct), reporting why it failed. Never throws. Bounded by <paramref name="timeoutMs"/>
    /// (default <see cref="TimeoutMs"/>).
    public static async Task<GeoResult> ResolveDetailedAsync(ProxyOptions? proxy = null, bool quiet = false, int? timeoutMs = null)
    {
        var sw = Stopwatch.StartNew();
        var budget = timeoutMs ?? TimeoutMs();
        ProxySpec? spec;
        try { spec = ProxySpec.From(proxy); }
        catch (Exception e) { return new GeoResult(null, $"invalid proxy ({e.Message})", sw.ElapsedMilliseconds); }

        using var client = ProxiedHttp.Create(spec);
        // ip-api answers with the exit IP AND its geo in one round-trip through the proxy.
        var geo = await IpApiAsync(client, sw, budget).ConfigureAwait(false);
        if (geo is { Timezone.Length: > 0 })
        {
            if (!quiet) Console.Error.WriteLine($"[clearcote] geoip: {geo.Ip} -> {geo.Country} tz={geo.Timezone} lang={geo.AcceptLanguage}");
            return new GeoResult(geo, null, sw.ElapsedMilliseconds);
        }
        // Failed: find out whether the proxy works at all, for an actionable reason.
        var ip = sw.ElapsedMilliseconds < budget ? await ExitIpAsync(client, sw, budget).ConfigureAwait(false) : null;
        var reason = sw.ElapsedMilliseconds >= budget
            ? $"timed out after {Math.Round(budget / 1000.0)}s (CLEARCOTE_GEOIP_TIMEOUT_SECONDS)"
            : ip is null
                ? $"could not determine the exit IP{(spec is not null ? " through the proxy" : "")}"
                : geo is not null
                    ? $"no timezone for exit IP {ip}"
                    : $"no geo data for exit IP {ip}";
        return new GeoResult(geo, reason, sw.ElapsedMilliseconds);
    }

    /// Resolve geo for the egress. Never throws — returns null on failure.
    public static async Task<GeoInfo?> ResolveAsync(ProxyOptions? proxy = null, bool quiet = false, int? timeoutMs = null)
        => (await ResolveDetailedAsync(proxy, quiet, timeoutMs).ConfigureAwait(false)).Geo;

    /// Fill unset Timezone/AcceptLanguage/Location/WebrtcIp on <paramref name="fp"/> from the exit-IP geo.
    ///
    /// FAILS CLOSED: throws <see cref="GeoipException"/> when the region cannot be resolved, unless the
    /// caller set BOTH Timezone and AcceptLanguage explicitly (then it warns and returns).
    public static async Task ApplyAsync(FingerprintOptions fp, ProxyOptions? proxy, bool quiet = false, int? timeoutMs = null)
    {
        var result = await ResolveDetailedAsync(proxy, quiet, timeoutMs).ConfigureAwait(false);
        var geo = result.Geo;
        if (geo is null || string.IsNullOrEmpty(geo.Timezone))
        {
            if (!string.IsNullOrEmpty(fp.Timezone) && !string.IsNullOrEmpty(fp.AcceptLanguage))
            {
                if (!quiet) Console.Error.WriteLine($"clearcote: geoip could not resolve the region ({result.Reason}); using the explicit timezone and acceptLanguage.");
                return;
            }
            var whose = string.IsNullOrEmpty(proxy?.Server) ? "connection's" : "proxy's";
            throw new GeoipException(
                $"geoip: could not resolve the {whose} region ({result.Reason}). " +
                "Launching anyway would use this machine's clock and a default language. Fix the proxy, raise " +
                "CLEARCOTE_GEOIP_TIMEOUT_SECONDS, or pass Timezone and AcceptLanguage explicitly.");
        }
        if (string.IsNullOrEmpty(fp.Timezone)) fp.Timezone = geo.Timezone;
        if (string.IsNullOrEmpty(fp.AcceptLanguage) && !string.IsNullOrEmpty(geo.AcceptLanguage)) fp.AcceptLanguage = geo.AcceptLanguage;
        if (string.IsNullOrEmpty(fp.Location) && !string.IsNullOrEmpty(geo.Location)) fp.Location = geo.Location;
        if (string.IsNullOrEmpty(fp.WebrtcIp) && !string.IsNullOrEmpty(geo.Ip)) fp.WebrtcIp = geo.Ip;
    }

    // country (ISO-3166 alpha-2) -> Accept-Language. Plain comma list (Chromium adds ;q= weights).
    private static readonly Dictionary<string, string> CountryLang = new()
    {
        ["US"] = "en-US,en", ["GB"] = "en-GB,en", ["CA"] = "en-CA,en,fr-CA", ["AU"] = "en-AU,en", ["NZ"] = "en-NZ,en",
        ["IE"] = "en-IE,en", ["IN"] = "en-IN,en,hi", ["ZA"] = "en-ZA,en", ["SG"] = "en-SG,en",
        ["DE"] = "de-DE,de,en", ["AT"] = "de-AT,de,en", ["CH"] = "de-CH,de,fr,en",
        ["FR"] = "fr-FR,fr,en", ["BE"] = "nl-BE,nl,fr,en", ["NL"] = "nl-NL,nl,en",
        ["ES"] = "es-ES,es,en", ["MX"] = "es-MX,es,en", ["AR"] = "es-AR,es,en", ["CL"] = "es-CL,es,en",
        ["CO"] = "es-CO,es,en", ["PT"] = "pt-PT,pt,en", ["BR"] = "pt-BR,pt,en",
        ["IT"] = "it-IT,it,en", ["PL"] = "pl-PL,pl,en", ["RU"] = "ru-RU,ru,en", ["UA"] = "uk-UA,uk,ru,en",
        ["SE"] = "sv-SE,sv,en", ["NO"] = "nb-NO,no,en", ["DK"] = "da-DK,da,en", ["FI"] = "fi-FI,fi,en",
        ["CZ"] = "cs-CZ,cs,en", ["RO"] = "ro-RO,ro,en", ["HU"] = "hu-HU,hu,en", ["GR"] = "el-GR,el,en",
        ["TR"] = "tr-TR,tr,en", ["IL"] = "he-IL,he,en", ["SA"] = "ar-SA,ar,en", ["AE"] = "ar-AE,ar,en",
        ["EG"] = "ar-EG,ar,en", ["JP"] = "ja-JP,ja,en", ["KR"] = "ko-KR,ko,en",
        ["CN"] = "zh-CN,zh,en", ["HK"] = "zh-HK,zh,en", ["TW"] = "zh-TW,zh,en",
        ["TH"] = "th-TH,th,en", ["VN"] = "vi-VN,vi,en", ["ID"] = "id-ID,id,en",
        ["MY"] = "ms-MY,ms,en", ["PH"] = "en-PH,en,fil",
    };

    /// Accept-Language for an ISO country code (en-US,en when unknown).
    public static string AcceptLanguageForCountry(string? cc)
        => cc is { Length: > 0 } && CountryLang.TryGetValue(cc.ToUpperInvariant(), out var v) ? v : "en-US,en";
}
