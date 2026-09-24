import { describe, it, expect } from "vitest";
import { acceptLanguageForCountry, resolveGeo } from "../src/geoip.js";

describe("acceptLanguageForCountry", () => {
  it("maps known countries (case-insensitive)", () => {
    expect(acceptLanguageForCountry("US")).toBe("en-US,en");
    expect(acceptLanguageForCountry("de")).toBe("de-DE,de,en");
    expect(acceptLanguageForCountry("BR")).toBe("pt-BR,pt,en");
    expect(acceptLanguageForCountry("JP")).toBe("ja-JP,ja,en");
  });

  it("falls back to en-US,en for unknown / empty", () => {
    expect(acceptLanguageForCountry("ZZ")).toBe("en-US,en");
    expect(acceptLanguageForCountry("")).toBe("en-US,en");
    expect(acceptLanguageForCountry(undefined)).toBe("en-US,en");
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
