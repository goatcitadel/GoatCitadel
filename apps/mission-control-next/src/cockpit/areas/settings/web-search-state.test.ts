import { describe, expect, it } from "vitest";
import { firecrawlAllowlistGap, firecrawlUrlProblem, isBaseUrlAllowlisted } from "./web-search-state";

describe("firecrawlUrlProblem", () => {
  it("accepts plain http for loopback and private LAN IPv4 Firecrawl hosts", () => {
    for (const url of [
      "http://127.0.0.1:3002",
      "http://localhost:3002",
      "http://192.168.0.199:3002",
      "http://10.0.0.5:3002",
      "http://172.20.1.2:3002",
      "http://100.101.102.103:3002",
    ]) {
      expect(firecrawlUrlProblem(url), url).toBeUndefined();
    }
  });

  it("still asks for https for a public or named remote host", () => {
    for (const url of [
      "http://api.firecrawl.dev",
      "http://8.8.8.8:3002",
      "http://firecrawl.lan:3002",
      "http://100.100.100.200:3002",
    ]) {
      expect(firecrawlUrlProblem(url), url).toBe("Use https for a remote Firecrawl.");
    }
    expect(firecrawlUrlProblem("https://api.firecrawl.dev")).toBeUndefined();
  });

  it("rejects non-http schemes and unparseable input", () => {
    expect(firecrawlUrlProblem("ftp://192.168.0.199")).toBe("Use an http or https URL.");
    expect(firecrawlUrlProblem("192.168.0.199:3002")).toBeDefined();
  });
});

describe("allowlist preview matches the Gateway", () => {
  it("needs host and port for a LAN address", () => {
    expect(isBaseUrlAllowlisted("http://192.168.0.199:3002", ["192.168.0.199"])).toBe(false);
    expect(isBaseUrlAllowlisted("http://192.168.0.199:3002", ["192.168.0.199:3002"])).toBe(true);
    expect(isBaseUrlAllowlisted("http://127.0.0.1:3002", [])).toBe(true);
    expect(isBaseUrlAllowlisted("http://localhost:3002", [])).toBe(true);
  });
  it("refuses loopback on another port and reserved addresses even when listed, as the Gateway does", () => {
    expect(isBaseUrlAllowlisted("http://127.0.0.1:9", ["127.0.0.1:9"])).toBe(false);
    expect(isBaseUrlAllowlisted("http://localhost:9", ["localhost:9", "localhost"])).toBe(false);
    expect(isBaseUrlAllowlisted("http://[::1]:3002", ["[::1]:3002"])).toBe(false);
    expect(isBaseUrlAllowlisted("http://printer.local:3002", ["printer.local:3002", "*.local"])).toBe(false);
    expect(isBaseUrlAllowlisted("http://169.254.1.1:3002", ["169.254.1.1:3002"])).toBe(false);
    expect(isBaseUrlAllowlisted("http://100.100.100.200:80", ["100.100.100.200:80"])).toBe(false);
  });
  it("keeps the channel check's looser reading of host-only entries", () => {
    const options = { hostOnlyEntriesCoverPrivate: true };
    expect(isBaseUrlAllowlisted("https://127.0.0.1:9/", ["127.0.0.1"], options)).toBe(true);
  });
  it("keeps hostname and wildcard entries for public hosts", () => {
    expect(isBaseUrlAllowlisted("https://api.firecrawl.dev", ["api.firecrawl.dev"])).toBe(true);
    expect(isBaseUrlAllowlisted("https://api.firecrawl.dev", ["*.firecrawl.dev"])).toBe(true);
  });
});

describe("reserved addresses the page refuses like the Gateway", () => {
  it.each([
    "http://192.0.2.5:3002",
    "http://192.88.99.1:3002",
    "http://198.51.100.7:3002",
    "http://203.0.113.9:3002",
    "http://metadata.google.internal",
    "http://[fec0::1]:3002",
    "http://[2001:db8::1]:3002",
    "http://[ff02::1]:3002",
  ])("refuses %s even when listed", (url) => {
    const host = new URL(url).host;
    expect(isBaseUrlAllowlisted(url, [host, new URL(url).hostname])).toBe(false);
  });
  it("judges an IPv4-mapped address by its IPv4 part", () => {
    const publicMapped = new URL("http://[::ffff:8.8.8.8]:8080");
    expect(isBaseUrlAllowlisted(publicMapped.href, [publicMapped.host])).toBe(true);
    expect(isBaseUrlAllowlisted("http://[::ffff:127.0.0.1]:8080", ["[::ffff:7f00:1]:8080"])).toBe(false);
    expect(isBaseUrlAllowlisted("http://[::ffff:10.0.0.1]:8080", ["[::ffff:a00:1]:8080"])).toBe(false);
  });
});

describe("firecrawlAllowlistGap", () => {
  const lan = {
    enabled: true,
    baseUrl: "http://192.168.0.199:3002",
    defaultReadBackend: "native",
    fallbackToNative: true,
    timeoutMs: 20_000,
  } as const;
  const loopback = { ...lan, baseUrl: "http://127.0.0.1:9" } as const;
  it("offers the saved host when the Gateway refuses it and it is not listed", () => {
    expect(
      firecrawlAllowlistGap({
        draft: lan,
        draftDirty: false,
        allowlist: [],
        saved: { enabled: true, baseUrl: lan.baseUrl, baseUrlAllowlisted: false },
      }),
    ).toEqual({ host: "192.168.0.199:3002", source: "gateway", cause: "not_listed" });
  });
  it("offers it after a blocked test even when the settings read says allowed", () => {
    expect(
      firecrawlAllowlistGap({
        draft: lan,
        draftDirty: false,
        allowlist: [],
        lastCheck: "blocked",
        saved: { enabled: true, baseUrl: lan.baseUrl, baseUrlAllowlisted: true },
      })?.source,
    ).toBe("gateway");
  });
  it("is silent after the host was added and no new test says otherwise", () => {
    expect(
      firecrawlAllowlistGap({
        draft: lan,
        draftDirty: false,
        allowlist: ["192.168.0.199:3002"],
        saved: { enabled: true, baseUrl: lan.baseUrl, baseUrlAllowlisted: true },
      }),
    ).toBeUndefined();
  });
  it("offers no add for a host that is already listed but refused as private or reserved", () => {
    expect(
      firecrawlAllowlistGap({
        draft: loopback,
        draftDirty: false,
        allowlist: ["127.0.0.1:9"],
        saved: { enabled: true, baseUrl: loopback.baseUrl, baseUrlAllowlisted: false },
      }),
    ).toEqual({ host: "127.0.0.1:9", source: "gateway", cause: "reserved" });
    expect(firecrawlAllowlistGap({ draft: loopback, draftDirty: true, allowlist: ["127.0.0.1:9"] })).toEqual({
      host: "127.0.0.1:9",
      source: "draft",
      cause: "reserved",
    });
  });
  it("says only refused for a listed public host the Gateway still refuses", () => {
    const hosted = { ...lan, baseUrl: "https://api.firecrawl.dev" } as const;
    expect(
      firecrawlAllowlistGap({
        draft: hosted,
        draftDirty: false,
        allowlist: ["api.firecrawl.dev"],
        lastCheck: "blocked",
        saved: { enabled: true, baseUrl: hosted.baseUrl, baseUrlAllowlisted: true },
      }),
    ).toEqual({ host: "api.firecrawl.dev", source: "gateway", cause: "refused" });
  });
  it("uses the draft preview while the form has unsaved edits", () => {
    expect(firecrawlAllowlistGap({ draft: lan, draftDirty: true, allowlist: ["192.168.0.199"] })).toEqual({
      host: "192.168.0.199:3002",
      source: "draft",
      cause: "not_listed",
    });
  });
  it("is silent when Firecrawl is off", () => {
    expect(
      firecrawlAllowlistGap({ draft: { ...lan, enabled: false }, draftDirty: true, allowlist: [] }),
    ).toBeUndefined();
  });
});
