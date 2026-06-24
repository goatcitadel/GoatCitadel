import { describe, it, expect } from "vitest";
import { DeviceTokenVault } from "./device-token-vault.js";

describe("DeviceTokenVault", () => {
  it("delivers a stored token exactly once (single-use)", () => {
    const vault = new DeviceTokenVault();
    vault.store("req-1", "secret-token", new Date(Date.now() + 60_000).toISOString());

    expect(vault.has("req-1")).toBe(true);
    const first = vault.claim("req-1");
    expect(first?.token).toBe("secret-token");
    expect(first?.deviceTokenExpiresAt).toBeDefined();

    // Consumed: second claim yields nothing.
    expect(vault.claim("req-1")).toBeUndefined();
    expect(vault.has("req-1")).toBe(false);
  });

  it("returns undefined for an unknown request id", () => {
    const vault = new DeviceTokenVault();
    expect(vault.claim("missing")).toBeUndefined();
    expect(vault.has("missing")).toBe(false);
  });

  it("does not deliver an expired entry and drops it", () => {
    let now = 1_000_000;
    const vault = new DeviceTokenVault({ now: () => now });
    vault.store("req-2", "token", new Date(now + 5_000).toISOString());

    now += 10_000; // advance past expiry
    expect(vault.has("req-2")).toBe(false);
    expect(vault.claim("req-2")).toBeUndefined();
    expect(vault.size).toBe(0);
  });

  it("sweeps expired entries while preserving live ones", () => {
    let now = 0;
    const vault = new DeviceTokenVault({ now: () => now });
    vault.store("old", "a", new Date(now + 1_000).toISOString());
    vault.store("new", "b", new Date(now + 100_000).toISOString());

    now = 5_000;
    vault.sweep();
    expect(vault.has("old")).toBe(false);
    expect(vault.has("new")).toBe(true);
    expect(vault.claim("new")?.token).toBe("b");
  });

  it("delete removes an entry without delivering it", () => {
    const vault = new DeviceTokenVault();
    vault.store("req-3", "token", new Date(Date.now() + 60_000).toISOString());
    vault.delete("req-3");
    expect(vault.claim("req-3")).toBeUndefined();
  });

  it("a later store overwrites a prior entry for the same request id", () => {
    const vault = new DeviceTokenVault();
    vault.store("req-4", "first", new Date(Date.now() + 60_000).toISOString());
    vault.store("req-4", "second", new Date(Date.now() + 60_000).toISOString());
    expect(vault.claim("req-4")?.token).toBe("second");
  });

  it("treats a missing/invalid expiry as non-self-expiring (claim still bounds it)", () => {
    const vault = new DeviceTokenVault({ now: () => Number.MAX_SAFE_INTEGER });
    vault.store("req-5", "token");
    expect(vault.has("req-5")).toBe(true);
    expect(vault.claim("req-5")?.token).toBe("token");
    expect(vault.claim("req-5")).toBeUndefined();
  });
});
