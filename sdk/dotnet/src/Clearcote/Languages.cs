using System.Text.RegularExpressions;

namespace Clearcote;

/// Chrome's own language defaults, so a persona's languages look like a fresh Chrome profile.
///
/// <para>Genuine Chrome derives everything from ONE value, the OS locale: it resolves that to a UI
/// locale it ships (de-AT -> <c>de</c>, en-CA -> <c>en-GB</c>, es-MX -> <c>es-419</c>), then
/// <c>navigator.languages</c> and the Accept-Language header are that UI locale's built-in default list
/// (<c>IDS_ACCEPT_LANGUAGES</c>) and <c>Intl</c> uses the UI locale itself. Measured on Chrome 154
/// (Windows) for 67 OS locales; the lists below are the 153 tree's
/// <c>components/strings/components_locale_settings_&lt;ui&gt;.xtb</c> values and match every measurement.</para>
///
/// <para>Mirrors sdk/python/clearcote/_languages.py and sdk/node/src/languages.ts.</para>
public static class Languages
{
    /// Desktop Chrome's UI locales (the .pak set Google Chrome ships on Windows/Linux/macOS).
    public static readonly IReadOnlySet<string> ChromeUiLocales = new HashSet<string>(StringComparer.Ordinal)
    {
        "af", "am", "ar", "bg", "bn", "ca", "cs", "da", "de", "el", "en-GB", "en-US", "es", "es-419",
        "et", "fa", "fi", "fil", "fr", "gu", "he", "hi", "hr", "hu", "id", "it", "ja", "kn", "ko", "lt",
        "lv", "ml", "mr", "ms", "nb", "nl", "pl", "pt-BR", "pt-PT", "ro", "ru", "sk", "sl", "sr", "sv",
        "sw", "ta", "te", "th", "tr", "uk", "ur", "vi", "zh-CN", "zh-TW",
    };

    // IDS_ACCEPT_LANGUAGES per UI locale. A UI locale missing here (af, ms, ur, en-US) has no
    // translation and uses the source default "en-US,en" -- e.g. Malay Chrome sends en-US,en.
    private static readonly Dictionary<string, string> AcceptLanguages = new(StringComparer.Ordinal)
    {
        ["am"] = "am,en-GB,en", ["ar"] = "ar,en-US,en", ["bg"] = "bg-BG,bg", ["bn"] = "bn-IN,bn,en-US,en",
        ["ca"] = "ca-ES,ca", ["cs"] = "cs-CZ,cs", ["da"] = "da-DK,da,en-US,en", ["de"] = "de-DE,de,en-US,en",
        ["el"] = "el-GR,el", ["en-GB"] = "en-GB,en-US,en", ["es"] = "es-ES,es", ["es-419"] = "es-419,es",
        ["et"] = "et-EE,et,en-US,en", ["fa"] = "fa,en-US,en", ["fi"] = "fi-FI,fi,en-US,en",
        ["fil"] = "fil,fil-PH,tl,en-US,en", ["fr"] = "fr-FR,fr,en-US,en", ["gu"] = "gu-IN,gu,hi-IN,hi,en-US,en",
        ["he"] = "he-IL,he,en-US,en", ["hi"] = "hi-IN,hi,en-US,en", ["hr"] = "hr-HR,hr,en-US,en",
        ["hu"] = "hu-HU,hu,en-US,en", ["id"] = "id-ID,id,en-US,en", ["it"] = "it-IT,it,en-US,en",
        ["ja"] = "ja,en-US,en", ["kn"] = "kn-IN,kn,en-US,en", ["ko"] = "ko-KR,ko,en-US,en",
        ["lt"] = "lt,en-US,en,ru,pl", ["lv"] = "lv-LV,lv,en-US,en", ["ml"] = "ml-IN,ml,en-US,en",
        ["mr"] = "mr-IN,mr,hi-IN,hi,en-US,en", ["nb"] = "nb-NO,nb,no,nn,en-US,en", ["nl"] = "nl-NL,nl,en-US,en",
        ["pl"] = "pl-PL,pl,en-US,en", ["pt-BR"] = "pt-BR,pt,en-US,en", ["pt-PT"] = "pt-PT,pt,en-US,en",
        ["ro"] = "ro-RO,ro,en-US,en", ["ru"] = "ru-RU,ru,en-US,en", ["sk"] = "sk-SK,sk,cs,en-US,en",
        ["sl"] = "sl-SI,sl,en-GB,en", ["sr"] = "sr-RS,sr,en-US,en", ["sv"] = "sv-SE,sv,en-US,en",
        ["sw"] = "sw,en-GB,en", ["ta"] = "ta-IN,ta,en-US,en", ["te"] = "te-IN,te,hi-IN,hi,en-US,en",
        ["th"] = "th-TH,th", ["tr"] = "tr-TR,tr,en-US,en", ["uk"] = "uk-UA,uk,en-US,en",
        ["vi"] = "vi-VN,vi,fr-FR,fr,en-US,en", ["zh-CN"] = "zh-CN,zh", ["zh-TW"] = "zh-TW,zh,en-US,en",
    };

    // Legacy / macro codes Chrome's matcher folds into a shipped locale.
    private static readonly Dictionary<string, string> LanguageAliases = new(StringComparer.Ordinal)
    {
        ["iw"] = "he", ["in"] = "id", ["tl"] = "fil", ["no"] = "nb", ["nn"] = "nb",
    };
    // English regions Chrome resolves to en-US (en-PH measured); every other region gets en-GB
    // (en-CA/AU/NZ/IE/IN/ZA/SG measured).
    private static readonly HashSet<string> EnUsRegions = new(StringComparer.Ordinal)
        { "", "US", "PH", "AS", "GU", "MH", "MP", "PR", "UM", "VI" };
    // Spanish regions that stay "es"; the rest of the Spanish-speaking world gets es-419 (es-MX/AR/CL/
    // CO/US measured).
    private static readonly HashSet<string> EsEsRegions = new(StringComparer.Ordinal) { "", "ES", "EA", "IC", "GQ" };

    private static (string Lang, string Script, string Region) SplitTag(string tag)
    {
        var parts = Regex.Split(tag.Trim(), "[-_]").Where(p => p.Length > 0).ToArray();
        if (parts.Length == 0) return ("", "", "");
        string script = "", region = "";
        foreach (var part in parts.Skip(1))
        {
            if (Regex.IsMatch(part, "^[A-Za-z]{4}$"))
                script = char.ToUpperInvariant(part[0]) + part[1..].ToLowerInvariant();
            else if (Regex.IsMatch(part, "^[A-Za-z]{2}$") || Regex.IsMatch(part, "^[0-9]{3}$"))
                region = part.ToUpperInvariant();
        }
        var lang = parts[0].ToLowerInvariant();
        return (LanguageAliases.TryGetValue(lang, out var alias) ? alias : lang, script, region);
    }

    /// The UI locale Chrome picks for an OS locale <paramref name="tag"/> (<c>de-AT</c> -> <c>de</c>), or
    /// null when Chrome ships no UI in that language (it would fall back to the OS's other languages / en-US).
    public static string? ChromeUiLocale(string tag)
    {
        var (lang, script, region) = SplitTag(tag ?? "");
        if (lang.Length == 0) return null;
        switch (lang)
        {
            case "en": return EnUsRegions.Contains(region) ? "en-US" : "en-GB";
            case "es": return EsEsRegions.Contains(region) ? "es" : "es-419";
            case "pt": return region is "" or "BR" ? "pt-BR" : "pt-PT";
            case "zh":
                var traditional = script == "Hant" || (script != "Hans" && region is "TW" or "HK" or "MO");
                return traditional ? "zh-TW" : "zh-CN";
        }
        return ChromeUiLocales.Contains(lang) ? lang : null;
    }

    /// Chrome's default navigator.languages for a UI locale, as a comma list (<c>de</c> -> <c>de-DE,de,en-US,en</c>).
    public static string ChromeAcceptLanguages(string uiLocale)
        => AcceptLanguages.TryGetValue(uiLocale, out var v) ? v : "en-US,en";

    /// Map a cleaned Accept-Language value to (acceptLang, langSwitch) for the engine.
    /// <list type="bullet">
    /// <item>ONE tag (<c>de-AT</c>) is read as the OS locale: the result is exactly what a fresh Chrome
    /// profile on that OS shows -- ("de-DE,de,en-US,en", "de").</item>
    /// <item>A LIST (<c>de-AT,de,en</c>) is the caller's own language list and is kept verbatim; only the
    /// UI locale (<c>--lang</c>, which drives Intl and the browser UI) is resolved from its first tag.</item>
    /// <item>A tag Chrome has no UI for (<c>is-IS</c>) is passed through unchanged, as before.</item>
    /// </list>
    public static (string AcceptLang, string? LangSwitch) ResolveLanguages(string clean)
    {
        var tags = clean.Split(',').Where(t => t.Length > 0).ToArray();
        if (tags.Length == 0) return (clean, null);
        var ui = ChromeUiLocale(tags[0]);
        if (tags.Length == 1 && ui is not null) return (ChromeAcceptLanguages(ui), ui);
        return (clean, ui ?? tags[0]);
    }

    /// <c>LANGUAGE=&lt;ui locale&gt;</c> on Linux when <paramref name="args"/> pin a UI locale with
    /// <c>--lang</c>, else null.
    ///
    /// <para>Chrome on Linux takes its UI locale (browser strings such as a form's validationMessage, and
    /// before r29 also Intl) from the environment -- LANGUAGE, LC_ALL, LC_MESSAGES, LANG, in GLib's order --
    /// and engines before 153 r29 ignore <c>--lang</c> there, so a German persona on a Linux host still
    /// spoke English. LANGUAGE is read first and only steers message catalogues, so it fixes that without
    /// touching the C library locale (LANG/LC_* would also change number parsing and fontconfig's default
    /// language). <c>de</c> -> <c>de</c>, <c>en-GB</c> -> <c>en_GB</c>.</para>
    public static string? LinuxLanguageEnv(IEnumerable<string>? args, bool? isLinux = null)
    {
        if (!(isLinux ?? OperatingSystem.IsLinux())) return null;
        string? lang = null;
        foreach (var arg in args ?? Array.Empty<string>())
            if (arg is not null && arg.StartsWith("--lang=", StringComparison.Ordinal))
                lang = arg["--lang=".Length..].Trim(); // the last one wins, as in Chromium
        return string.IsNullOrEmpty(lang) ? null : lang.Replace('-', '_');
    }

    /// Add <see cref="LinuxLanguageEnv"/> to the browser env. The caller's own LANGUAGE always wins;
    /// otherwise the persona's value replaces the host's. Playwright REPLACES the child env when Env is
    /// set, so without a caller env the parent environment comes along (as ShaderDialect.Apply does).
    internal static IDictionary<string, string>? ApplyLinuxLanguage(IEnumerable<string>? args,
        IDictionary<string, string>? callerEnv, bool? isLinux = null)
    {
        var lang = LinuxLanguageEnv(args, isLinux);
        if (lang is null || (callerEnv is not null && callerEnv.ContainsKey("LANGUAGE"))) return callerEnv;
        var outEnv = new Dictionary<string, string>();
        if (callerEnv is not null)
        {
            foreach (var (k, v) in callerEnv) if (v is not null) outEnv[k] = v;
        }
        else
        {
            foreach (System.Collections.DictionaryEntry e in Environment.GetEnvironmentVariables())
                if (e.Value is string sv) outEnv[(string)e.Key] = sv;
        }
        outEnv["LANGUAGE"] = lang;
        return outEnv;
    }
}
