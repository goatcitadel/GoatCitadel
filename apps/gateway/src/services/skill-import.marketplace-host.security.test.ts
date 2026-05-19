import { describe, expect, it } from "vitest";
import { __isMarketplaceListingUrlForTests } from "./skill-import-service.js";

// Regression coverage for CODEX_FINDING #14: `isMarketplaceListingUrl`
// previously used an unanchored regex that matched any input containing a
// marketplace URL anywhere, so `q=http://127.0.0.1:2375/version?x=https://skillsmp.com/`
// returned true and the gateway happily fetched the Docker socket. The fix
// parses the input as a URL and checks the exact host.

describe("isMarketplaceListingUrl (codex #14)", () => {
  it("accepts the canonical marketplace hosts", () => {
    expect(__isMarketplaceListingUrlForTests("https://skillsmp.com/listing/abc")).toBe(true);
    expect(__isMarketplaceListingUrlForTests("https://www.skillsmp.com/listing/abc")).toBe(true);
    expect(__isMarketplaceListingUrlForTests("https://agentskill.sh/x")).toBe(true);
    expect(__isMarketplaceListingUrlForTests("https://clawhub.ai/x")).toBe(true);
  });

  it("rejects substring SSRF attempts via Docker socket", () => {
    expect(__isMarketplaceListingUrlForTests("http://127.0.0.1:2375/version?x=https://skillsmp.com/")).toBe(false);
  });

  it("rejects substring SSRF attempts via metadata endpoint", () => {
    expect(__isMarketplaceListingUrlForTests("http://169.254.169.254/latest/?ref=https://skillsmp.com/")).toBe(false);
  });

  it("rejects URLs that merely embed the marketplace host in path/query/fragment", () => {
    expect(__isMarketplaceListingUrlForTests("https://attacker.example/path/?u=https://skillsmp.com/")).toBe(false);
    expect(__isMarketplaceListingUrlForTests("https://attacker.example/#https://skillsmp.com/")).toBe(false);
  });

  it("rejects subdomain attacks", () => {
    expect(__isMarketplaceListingUrlForTests("https://skillsmp.com.attacker.example/x")).toBe(false);
    expect(__isMarketplaceListingUrlForTests("https://attacker.example/skillsmp.com")).toBe(false);
  });

  it("rejects non-URL input", () => {
    expect(__isMarketplaceListingUrlForTests("not a url")).toBe(false);
    expect(__isMarketplaceListingUrlForTests("")).toBe(false);
  });
});
