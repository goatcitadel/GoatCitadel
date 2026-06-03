import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fetchAllowlisted } from "./network-guard.js";

// Regression coverage for CODEX_FINDING #11 (Firecrawl redirect bypass) and
// #14 (skill-lookup SSRF). The fix consolidates outbound HTTP through
// `fetchAllowlisted`, which:
//   1. validates the requested host against the allowlist,
//   2. follows redirects manually and re-validates each hop, and
//   3. caps the redirect chain length.

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

beforeEach(() => {
  // Tests stub global fetch per scenario.
});

describe("fetchAllowlisted (codex #11, #14)", () => {
  it("blocks the request when the initial host is not in the allowlist", async () => {
    const stub = vi.fn(async () => new Response("ok"));
    global.fetch = stub as unknown as typeof global.fetch;
    await expect(fetchAllowlisted("http://127.0.0.1:2375/version", { allowlist: ["skillsmp.com"] })).rejects.toThrow(
      /blocked|allowlisted/,
    );
    expect(stub).not.toHaveBeenCalled();
  });

  it("blocks the redirect destination when the second hop is private", async () => {
    const stub = vi.fn(async (url: string) => {
      if (url === "https://skillsmp.com/listing/x") {
        return new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/latest/" } });
      }
      return new Response("metadata", { status: 200 });
    });
    global.fetch = stub as unknown as typeof global.fetch;
    await expect(fetchAllowlisted("https://skillsmp.com/listing/x", { allowlist: ["skillsmp.com"] })).rejects.toThrow(
      /Private/,
    );
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("blocks allowlisted public hostnames that resolve to private addresses", async () => {
    let hit = false;
    const server = createServer((_request, response) => {
      hit = true;
      response.end("metadata");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(
        fetchAllowlisted(`http://public.example:${port}/metadata`, {
          allowlist: [`public.example:${port}`],
          dnsLookup: (_hostname, _options, callback) => callback(null, "127.0.0.1", 4),
        }),
      ).rejects.toThrow(/resolved address is blocked/i);
      expect(hit).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("blocks allowlisted hosts when any DNS result resolves to link-local private space", async () => {
    let hit = false;
    const server = createServer((_request, response) => {
      hit = true;
      response.end("metadata");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(
        fetchAllowlisted(`http://bundle.example:${port}/skill-bundle.tgz`, {
          allowlist: [`bundle.example:${port}`],
          dnsLookup: (_hostname, _options, callback) =>
            callback(null, [
              { address: "203.0.113.10", family: 4 },
              { address: "169.254.169.254", family: 4 },
            ]),
        }),
      ).rejects.toThrow(/resolved address is blocked/i);
      expect(hit).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("still allows explicitly allowlisted loopback hostnames to resolve to loopback", async () => {
    const server = createServer((_request, response) => {
      response.end("local-ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const response = await fetchAllowlisted(`http://localhost:${port}/health`, {
        allowlist: [`localhost:${port}`],
        dnsLookup: (_hostname, _options, callback) => callback(null, "127.0.0.1", 4),
      });
      expect(await response.text()).toBe("local-ok");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("follows allowlisted redirects up to the cap", async () => {
    const stub = vi.fn(async (url: string) => {
      if (url === "https://skillsmp.com/a") {
        return new Response(null, { status: 302, headers: { Location: "https://skillsmp.com/b" } });
      }
      if (url === "https://skillsmp.com/b") {
        return new Response("final", { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    });
    global.fetch = stub as unknown as typeof global.fetch;
    const response = await fetchAllowlisted("https://skillsmp.com/a", { allowlist: ["skillsmp.com"] });
    expect(await response.text()).toBe("final");
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("aborts when redirect chain exceeds the cap", async () => {
    const stub = vi.fn(
      async () => new Response(null, { status: 302, headers: { Location: "https://skillsmp.com/loop" } }),
    );
    global.fetch = stub as unknown as typeof global.fetch;
    await expect(
      fetchAllowlisted("https://skillsmp.com/loop", { allowlist: ["skillsmp.com"], maxRedirects: 3 }),
    ).rejects.toThrow(/too many redirects/);
    expect(stub).toHaveBeenCalledTimes(4);
  });

  it("never includes the source URL in too-many-redirects errors", async () => {
    const stub = vi.fn(
      async () => new Response(null, { status: 302, headers: { Location: "https://skillsmp.com/?secret=value" } }),
    );
    global.fetch = stub as unknown as typeof global.fetch;
    let captured: unknown;
    try {
      await fetchAllowlisted("https://skillsmp.com/start?password=hunter2", {
        allowlist: ["skillsmp.com"],
        maxRedirects: 2,
      });
    } catch (error) {
      captured = (error as Error).message;
    }
    expect(typeof captured).toBe("string");
    expect(captured as string).not.toContain("hunter2");
    expect(captured as string).not.toContain("password");
    expect(captured as string).not.toContain("?secret=");
  });
});
