using System.Net;

namespace Clearcote;

/// A proxy normalised for SDK-side HTTP calls: the proxy URI (scheme, host, port) plus optional
/// credentials, split out of the URL userinfo when they were given inline.
public sealed record ProxySpec(Uri Server, string? Username = null, string? Password = null)
{
    /// Normalise a proxy given as a URL string (credentials inline) or a <see cref="ProxyOptions"/>.
    /// Returns null when there is no proxy. A bare "host:port" is treated as http://.
    public static ProxySpec? From(string? proxy) => proxy is null ? null : From(new ProxyOptions { Server = proxy });

    /// <inheritdoc cref="From(string?)"/>
    public static ProxySpec? From(ProxyOptions? proxy)
    {
        var raw = proxy?.Server?.Trim();
        if (string.IsNullOrEmpty(raw)) return null;
        if (!raw.Contains("://")) raw = "http://" + raw;
        var u = new Uri(raw);
        var scheme = u.Scheme.ToLowerInvariant();
        // .NET speaks socks5 with hostname (ATYP 3) resolution on the proxy already; socks5h and a
        // bare socks:// mean the same thing to the caller.
        if (scheme is "socks5h" or "socks") scheme = "socks5";
        var port = u.IsDefaultPort || u.Port <= 0 ? DefaultPort(scheme) : u.Port;
        string? user = null, pass = null;
        if (!string.IsNullOrEmpty(u.UserInfo))
        {
            var i = u.UserInfo.IndexOf(':');
            user = Uri.UnescapeDataString(i < 0 ? u.UserInfo : u.UserInfo[..i]);
            pass = i < 0 ? null : Uri.UnescapeDataString(u.UserInfo[(i + 1)..]);
        }
        if (!string.IsNullOrEmpty(proxy!.Username)) user = proxy.Username;
        if (!string.IsNullOrEmpty(proxy.Password)) pass = proxy.Password;
        // Uri.Host keeps IPv6 brackets; UriBuilder adds its own, so strip them to avoid "[[::1]]".
        var host = u.HostNameType == UriHostNameType.IPv6 ? u.Host.Trim('[', ']') : u.Host;
        var server = new UriBuilder(scheme, host, port).Uri;
        return new ProxySpec(server, string.IsNullOrEmpty(user) ? null : user, string.IsNullOrEmpty(pass) ? null : pass);
    }

    private static int DefaultPort(string scheme) => scheme switch
    {
        "socks5" or "socks4" or "socks4a" => 1080,
        "https" => 443,
        _ => 80,
    };

    /// "scheme://host:port" with no credentials — safe to log and to key caches by.
    /// The port is always explicit; an IPv6 host keeps its (single) brackets.
    public string ServerString => $"{Server.Scheme}://{Server.Host}:{Server.Port}";
}

/// An <see cref="IWebProxy"/> that routes EVERY request through one proxy. <see cref="WebProxy"/>
/// silently bypasses loopback targets, which would make a proxied SDK call go direct.
internal sealed class FixedProxy : IWebProxy
{
    private readonly Uri _server;
    public FixedProxy(ProxySpec spec)
    {
        _server = spec.Server;
        if (spec.Username is not null || spec.Password is not null)
            Credentials = new NetworkCredential(spec.Username ?? "", spec.Password ?? "");
    }
    public ICredentials? Credentials { get; set; }
    public Uri GetProxy(Uri destination) => _server;
    public bool IsBypassed(Uri host) => false;
}

internal static class ProxiedHttp
{
    /// An HttpClient that goes through <paramref name="proxy"/> (HTTP CONNECT / absolute-form, or
    /// SOCKS5 with RFC 1929 credentials — both native to SocketsHttpHandler), or direct when null.
    /// No client-level timeout: callers bound each request with a CancellationToken.
    public static HttpClient Create(ProxySpec? proxy)
    {
        if (SdkHttp.HandlerOverride is not null || proxy is null)
        {
            var c = SdkHttp.Create();
            c.Timeout = Timeout.InfiniteTimeSpan;
            return c;
        }
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = true,
            UseProxy = true,
            Proxy = new FixedProxy(proxy),
            PooledConnectionLifetime = TimeSpan.Zero,
        };
        return new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
    }
}
