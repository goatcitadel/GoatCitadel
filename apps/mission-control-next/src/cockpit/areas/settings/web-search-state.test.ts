import { describe, expect, it } from "vitest";
import { firecrawlUrlProblem } from "./web-search-state";

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
