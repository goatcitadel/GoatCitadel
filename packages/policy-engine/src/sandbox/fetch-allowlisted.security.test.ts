import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fetchAllowlisted, fetchAllowlistedOnce } from "./network-guard.js";

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

  describe("cross-origin redirect authority (FR-101)", () => {
    const sourceUrl = "https://source.example/start";
    const destinationUrl = "https://destination.example/finish";
    const allowlist = ["source.example", "destination.example"];
    const sensitiveRedirects: Array<{ name: string; init: RequestInit }> = [
      {
        name: "Authorization headers",
        init: { headers: { Authorization: "Bearer fixture-token" } },
      },
      {
        name: "Cookie headers",
        init: { headers: { Cookie: "fixture-session=value" } },
      },
      {
        name: "X-API-Key headers",
        init: { headers: { "X-API-Key": "fixture-api-key" } },
      },
      {
        name: "POST request bodies",
        init: { method: "POST", body: "fixture-body" },
      },
      {
        name: "included credentials",
        init: { credentials: "include" },
      },
      {
        name: "explicit referrer authority",
        init: {
          referrer: "https://source.example/path?token=fixture-secret",
          referrerPolicy: "unsafe-url",
        },
      },
    ];

    it.each(sensitiveRedirects)("blocks cross-origin redirects carrying $name before contact", async ({ init }) => {
      const contactedUrls: string[] = [];
      const stub = vi.fn(async (url: string) => {
        contactedUrls.push(url);
        if (url === sourceUrl) {
          return new Response(null, { status: 302, headers: { Location: destinationUrl } });
        }
        return new Response("destination-contacted", { status: 200 });
      });
      global.fetch = stub as unknown as typeof global.fetch;

      await expect(fetchAllowlisted(sourceUrl, { allowlist, init })).rejects.toThrow(/cross-origin|blocked/i);
      expect(contactedUrls).toEqual([sourceUrl]);
      expect(stub).toHaveBeenCalledTimes(1);
    });

    it("preserves authentication across same-origin redirects", async () => {
      const redirectedUrl = "https://source.example/finish";
      const calls: Array<{ url: string; authorization: string | null }> = [];
      const stub = vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          url,
          authorization: new Headers(init?.headers).get("authorization"),
        });
        if (url === sourceUrl) {
          return new Response(null, { status: 302, headers: { Location: redirectedUrl } });
        }
        return new Response("same-origin-ok", { status: 200 });
      });
      global.fetch = stub as unknown as typeof global.fetch;

      const response = await fetchAllowlisted(sourceUrl, {
        allowlist,
        init: { headers: { Authorization: "Bearer fixture-token" } },
      });

      expect(await response.text()).toBe("same-origin-ok");
      expect(calls).toEqual([
        { url: sourceUrl, authorization: "Bearer fixture-token" },
        { url: redirectedUrl, authorization: "Bearer fixture-token" },
      ]);
    });

    it("allows anonymous GET redirects across allowlisted origins", async () => {
      const contactedUrls: string[] = [];
      const stub = vi.fn(async (url: string, init?: RequestInit) => {
        contactedUrls.push(url);
        expect(init?.method).toBeUndefined();
        expect(new Headers(init?.headers).get("authorization")).toBeNull();
        expect(new Headers(init?.headers).get("cookie")).toBeNull();
        expect(new Headers(init?.headers).get("x-api-key")).toBeNull();
        expect(init?.body).toBeUndefined();
        expect(init?.credentials).toBeUndefined();
        if (url === sourceUrl) {
          return new Response(null, { status: 302, headers: { Location: destinationUrl } });
        }
        return new Response("cross-origin-ok", { status: 200 });
      });
      global.fetch = stub as unknown as typeof global.fetch;

      const response = await fetchAllowlisted(sourceUrl, { allowlist });

      expect(await response.text()).toBe("cross-origin-ok");
      expect(contactedUrls).toEqual([sourceUrl, destinationUrl]);
    });

    it("forces one-shot fetches to remain manual when a caller requests automatic redirect following", async () => {
      const contactedUrls: string[] = [];
      const stub = vi.fn(async (url: string, init?: RequestInit) => {
        contactedUrls.push(url);
        expect(init?.redirect).toBe("manual");
        return new Response(null, { status: 302, headers: { Location: destinationUrl } });
      });
      global.fetch = stub as unknown as typeof global.fetch;

      const response = await fetchAllowlistedOnce(sourceUrl, {
        allowlist,
        init: {
          redirect: "follow",
          headers: { "X-API-Key": "fixture-api-key" },
        },
      });

      expect(response.status).toBe(302);
      expect(contactedUrls).toEqual([sourceUrl]);
      expect(stub).toHaveBeenCalledTimes(1);
    });

    it("enforces additional allowlists before a one-shot fetch", async () => {
      const stub = vi.fn(async () => new Response("must-not-contact", { status: 200 }));
      global.fetch = stub as unknown as typeof global.fetch;

      await expect(
        fetchAllowlistedOnce(sourceUrl, {
          allowlist,
          additionalAllowlists: [["different.example"]],
        }),
      ).rejects.toThrow(/allowlist|allowlisted/i);
      expect(stub).not.toHaveBeenCalled();
    });
  });

  it("bounds response text reads from allowlisted fetches", async () => {
    const stub = vi.fn(async () => new Response("secret-free-but-too-large"));
    global.fetch = stub as unknown as typeof global.fetch;

    const response = await fetchAllowlisted("https://skillsmp.com/large", {
      allowlist: ["skillsmp.com"],
      maxResponseBytes: 8,
    });

    await expect(response.text()).rejects.toThrow(/response body exceeded 8 bytes/);
  });

  it("bounds response JSON reads from allowlisted fetches", async () => {
    const stub = vi.fn(async () => new Response('{"message":"large-enough-to-trip-the-cap"}'));
    global.fetch = stub as unknown as typeof global.fetch;

    const response = await fetchAllowlisted("https://skillsmp.com/large-json", {
      allowlist: ["skillsmp.com"],
      maxResponseBytes: 16,
    });

    await expect(response.json()).rejects.toThrow(/response body exceeded 16 bytes/);
  });

  it("bounds binary response reads from allowlisted fetches", async () => {
    const stub = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4, 5, 6])));
    global.fetch = stub as unknown as typeof global.fetch;

    const response = await fetchAllowlisted("https://skillsmp.com/blob", {
      allowlist: ["skillsmp.com"],
      maxResponseBytes: 4,
    });

    await expect(response.arrayBuffer()).rejects.toThrow(/response body exceeded 4 bytes/);
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
