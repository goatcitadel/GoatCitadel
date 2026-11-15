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
  it("needs host and port for a loopback or LAN address", () => {
    expect(isBaseUrlAllowlisted("http://127.0.0.1:9", ["127.0.0.1"])).toBe(false);
    expect(isBaseUrlAllowlisted("http://127.0.0.1:9", ["127.0.0.1:9"])).toBe(true);
    expect(isBaseUrlAllowlisted("http://192.168.0.199:3002", ["192.168.0.199"])).toBe(false);
    expect(isBaseUrlAllowlisted("http://192.168.0.199:3002", ["192.168.0.199:3002"])).toBe(true);
    expect(isBaseUrlAllowlisted("http://127.0.0.1:3002", [])).toBe(true);
  });
  it("keeps hostname and wildcard entries for public hosts", () => {
    expect(isBaseUrlAllowlisted("https://api.firecrawl.dev", ["api.firecrawl.dev"])).toBe(true);
    expect(isBaseUrlAllowlisted("https://api.firecrawl.dev", ["*.firecrawl.dev"])).toBe(true);
  });
});

describe("firecrawlAllowlistGap", () => {
  const draft = {
    enabled: true,
    baseUrl: "http://127.0.0.1:9",
    defaultReadBackend: "native",
    fallbackToNative: true,
    timeoutMs: 20_000,
  } as const;
  it("offers the saved host when the Gateway refuses it", () => {
    expect(
      firecrawlAllowlistGap({
        draft,
        draftDirty: false,
        allowlist: ["127.0.0.1:9"],
        saved: { enabled: true, baseUrl: "http://127.0.0.1:9", baseUrlAllowlisted: false },
      }),
    ).toEqual({ host: "127.0.0.1:9", source: "gateway" });
  });
  it("offers it after a blocked test even when the settings read says allowed", () => {
    expect(
      firecrawlAllowlistGap({
        draft,
        draftDirty: false,
        allowlist: ["127.0.0.1:9"],
        lastCheck: "blocked",
        saved: { enabled: true, baseUrl: "http://127.0.0.1:9", baseUrlAllowlisted: true },
      })?.source,
    ).toBe("gateway");
  });
  it("uses the draft preview while the form has unsaved edits", () => {
    expect(firecrawlAllowlistGap({ draft, draftDirty: true, allowlist: ["127.0.0.1"] })).toEqual({
      host: "127.0.0.1:9",
      source: "draft",
    });
  });
  it("is silent when everything is allowed or Firecrawl is off", () => {
    expect(
      firecrawlAllowlistGap({ draft: { ...draft, enabled: false }, draftDirty: true, allowlist: [] }),
    ).toBeUndefined();
    expect(
      firecrawlAllowlistGap({
        draft,
        draftDirty: false,
        allowlist: ["127.0.0.1:9"],
        saved: { enabled: true, baseUrl: "http://127.0.0.1:9", baseUrlAllowlisted: true },
      }),
    ).toBeUndefined();
  });
});
