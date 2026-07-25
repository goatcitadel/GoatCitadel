import type { LookupAddress, LookupOptions } from "node:dns";
import { describe, expect, it } from "vitest";
import {
  WorkerCellEgressDeniedError,
  assertWorkerCellDirectSocketBypassImpossible,
  assertWorkerCellEgressAllowed,
  evaluateWorkerCellEgressAuthority,
  parseWorkerCellEgressAuthority,
  resolveAndPinWorkerCellEgressTarget,
  workerCellEgressAllowlistsAdmit,
  type WorkerCellEgressConfig,
} from "./worker-cell-egress-proxy.js";

function config(overrides: Partial<WorkerCellEgressConfig> = {}): WorkerCellEgressConfig {
  return {
    allowlists: [["api.example.com:443"]],
    maxConnections: 8,
    connectDeadlineMs: 10_000,
    maxBytesPerConnection: 1_048_576,
    directSocketBypassProven: true,
    ...overrides,
  };
}

function stubLookup(map: Record<string, LookupAddress[]>) {
  return (
    host: string,
    _options: LookupOptions,
    callback: (err: NodeJS.ErrnoException | null, address: LookupAddress[]) => void,
  ) => {
    const entry = map[host];
    if (!entry) {
      callback(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }) as NodeJS.ErrnoException, []);
      return;
    }
    callback(null, entry);
  };
}

describe("HX-505 worker cell egress proxy — authority canonicalization", () => {
  it("accepts an exact host/IP plus port authority", () => {
    expect(parseWorkerCellEgressAuthority("api.example.com:443")?.host).toBe("api.example.com");
    expect(parseWorkerCellEgressAuthority("93.184.216.34:443")?.family).toBe(4);
    expect(parseWorkerCellEgressAuthority("[2606:2800:220:1:248:1893:25c8:1946]:443")?.family).toBe(6);
  });

  it("rejects wildcard, userinfo, encoded, scheme, path, and noncanonical authorities", () => {
    for (const bad of [
      "*.example.com:443",
      "example.com:443/path",
      "user@example.com:443",
      "https://example.com:443",
      "example.com:443?q=1",
      "example%2ecom:443",
      "example.com:443 ",
      "example.com:0",
      "example.com:99999",
      "example.com",
      "EXAMPLE.com:443",
      "01.2.3.4:443",
      "2606:2800:220:1:248:1893:25c8:1946:443",
      "example.com:443\\x",
      "exam ple.com:443",
    ]) {
      expect(parseWorkerCellEgressAuthority(bad), bad).toBeUndefined();
    }
  });
});

describe("HX-505 worker cell egress proxy — SSRF and private-host denial", () => {
  it("blocks loopback, link-local, metadata, private, multicast, and reserved destinations", () => {
    for (const target of [
      "127.0.0.1:443",
      "localhost:443",
      "169.254.169.254:80",
      "metadata.google.internal:80",
      "10.0.0.5:443",
      "192.168.1.10:443",
      "172.16.0.9:443",
      "100.100.100.200:80",
      "[::1]:443",
      "[fd00::1]:443",
      "[fe80::1]:443",
      "224.0.0.1:443",
      "[::ffff:169.254.169.254]:80",
    ]) {
      const evaluation = evaluateWorkerCellEgressAuthority(target, config({ allowlists: [[target]] }));
      expect(evaluation.allowed, target).toBe(false);
    }
  });

  it("admits a public target only when every allowlist admits it (conjunctive)", () => {
    const admit = evaluateWorkerCellEgressAuthority("api.example.com:443", config());
    expect(admit.allowed).toBe(true);

    const conjunctive = config({
      allowlists: [["api.example.com:443", "cdn.example.com:443"], ["api.example.com:443"]],
    });
    expect(evaluateWorkerCellEgressAuthority("cdn.example.com:443", conjunctive).allowed).toBe(false);
    expect(evaluateWorkerCellEgressAuthority("api.example.com:443", conjunctive).allowed).toBe(true);
    const authority = parseWorkerCellEgressAuthority("api.example.com:443")!;
    expect(workerCellEgressAllowlistsAdmit(authority, [[], []])).toBe(false);
  });

  it("never redacts leaks the raw target host into the denial reason", () => {
    const evaluation = evaluateWorkerCellEgressAuthority("secret-host.example.com:443/leak?token=abc", config());
    expect(evaluation.allowed).toBe(false);
    if (!evaluation.allowed) {
      expect(evaluation.reason).not.toContain("token=abc");
    }
  });
});

describe("HX-505 worker cell egress proxy — fail-closed and bounds", () => {
  it("fails closed on nonempty egress without a proven direct-socket bypass", () => {
    expect(() => assertWorkerCellDirectSocketBypassImpossible(config({ directSocketBypassProven: false }))).toThrow(
      WorkerCellEgressDeniedError,
    );
    // A deny-all posture (no allowlists) is inert and does not require the attestation.
    expect(() =>
      assertWorkerCellDirectSocketBypassImpossible(config({ allowlists: [], directSocketBypassProven: false })),
    ).not.toThrow();
    expect(
      evaluateWorkerCellEgressAuthority("api.example.com:443", config({ directSocketBypassProven: false })).allowed,
    ).toBe(false);
  });

  it("rejects invalid connection/deadline/byte bounds", () => {
    for (const bounds of [
      { maxConnections: 0 },
      { maxConnections: 100_000 },
      { connectDeadlineMs: 0 },
      { connectDeadlineMs: 10_000_000 },
      { maxBytesPerConnection: 0 },
    ]) {
      expect(evaluateWorkerCellEgressAuthority("api.example.com:443", config(bounds)).allowed).toBe(false);
    }
  });
});

describe("HX-505 worker cell egress proxy — pinned resolution and DNS rebinding", () => {
  it("pins a literal IP without a second resolution", async () => {
    const pinned = await resolveAndPinWorkerCellEgressTarget(
      "93.184.216.34:443",
      config({ allowlists: [["93.184.216.34:443"]] }),
    );
    expect(pinned.address).toBe("93.184.216.34");
    expect(pinned.family).toBe(4);
  });

  it("resolves and pins a public answer once", async () => {
    const pinned = await resolveAndPinWorkerCellEgressTarget(
      "api.example.com:443",
      config(),
      stubLookup({ "api.example.com": [{ address: "93.184.216.34", family: 4 }] }),
    );
    expect(pinned.address).toBe("93.184.216.34");
    expect(pinned.host).toBe("api.example.com");
  });

  it("rejects a DNS answer that rebinds to or mixes a private address", async () => {
    await expect(
      resolveAndPinWorkerCellEgressTarget(
        "api.example.com:443",
        config(),
        stubLookup({ "api.example.com": [{ address: "169.254.169.254", family: 4 }] }),
      ),
    ).rejects.toThrow(/private, metadata, or reserved/u);

    await expect(
      resolveAndPinWorkerCellEgressTarget(
        "api.example.com:443",
        config(),
        stubLookup({
          "api.example.com": [
            { address: "93.184.216.34", family: 4 },
            { address: "10.0.0.9", family: 4 },
          ],
        }),
      ),
    ).rejects.toThrow(/private, metadata, or reserved/u);
  });

  it("rejects a resolution error and a target that resolves to nothing", async () => {
    await expect(resolveAndPinWorkerCellEgressTarget("api.example.com:443", config(), stubLookup({}))).rejects.toThrow(
      WorkerCellEgressDeniedError,
    );
  });

  it("throws when a target is not admitted at all", () => {
    expect(() => assertWorkerCellEgressAllowed("evil.example.com:443", config())).toThrow(WorkerCellEgressDeniedError);
  });
});
