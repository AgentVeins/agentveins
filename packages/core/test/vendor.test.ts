import { describe, expect, it } from "vitest";
import { normalizeVendor } from "../src/vendor.js";

describe("normalizeVendor", () => {
  it("reduces URLs to their lowercased hostname", () => {
    expect(normalizeVendor("https://api.weather.com/forecast?q=1")).toBe("api.weather.com");
    expect(normalizeVendor("HTTPS://API.WEATHER.COM/forecast")).toBe("api.weather.com");
    expect(normalizeVendor("http://localhost:3001/forecast")).toBe("localhost");
  });

  it("passes bare hostnames through unchanged", () => {
    expect(normalizeVendor("api.weather.com")).toBe("api.weather.com");
  });

  it("preserves the case of base58 addresses", () => {
    const address = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    expect(normalizeVendor(address)).toBe(address);
  });

  it("rejects empty vendors", () => {
    expect(() => normalizeVendor("   ")).toThrow(RangeError);
  });

  it("rejects malformed URLs", () => {
    expect(() => normalizeVendor("https://")).toThrow(RangeError);
  });

  it("resolves a special-scheme URL missing the double slash to its hostname", () => {
    expect(normalizeVendor("https:evil.com")).toBe("evil.com");
  });

  it("passes a non-http scheme through unchanged", () => {
    expect(normalizeVendor("solana:abc")).toBe("solana:abc");
  });
});
