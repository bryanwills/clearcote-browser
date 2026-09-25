import { describe, it, expect } from "vitest";
import { acceptLanguageForCountry, resolveGeo } from "../src/geoip.js";

describe("acceptLanguageForCountry", () => {
  it("maps known countries (case-insensitive)", () => {
    expect(acceptLanguageForCountry("US")).toBe("en-US");
    expect(acceptLanguageForCountry("de")).toBe("de-DE");
    expect(acceptLanguageForCountry("BR")).toBe("pt-BR");
    expect(acceptLanguageForCountry("JP")).toBe("ja-JP");
  });

  it("falls back to en-US for unknown / empty", () => {
    expect(acceptLanguageForCountry("ZZ")).toBe("en-US");
    expect(acceptLanguageForCountry("")).toBe("en-US");
    expect(acceptLanguageForCountry(undefined)).toBe("en-US");
  });

  it("never returns ;q= weights (Chromium --accept-lang would DCHECK)", () => {
    for (const cc of ["US", "DE", "FR", "CA", "BR", "JP", "ZZ"]) {
      expect(acceptLanguageForCountry(cc)).not.toContain(";");
    }
  });
});

describe("resolveGeo", () => {
  it("returns null for a dead SOCKS5 proxy, never the local IP's region", async () => {
    // The lookup goes THROUGH the proxy (SOCKS5 included); with the proxy down it must NOT fall
    // back to the local IP (wrong region).
    expect(await resolveGeo({ server: "socks5://127.0.0.1:9050" }, { quiet: true })).toBeNull();
  });
});
