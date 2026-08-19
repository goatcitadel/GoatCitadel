import { describe, expect, it } from "vitest";
import { ProviderSecretStaging, type ProviderSecretStagingStore } from "./provider-secret-staging.js";

class FakeStore implements ProviderSecretStagingStore {
  public readonly secrets = new Map<string, string>();
  public constructor(private readonly available: boolean) {}
  public isAvailable(): boolean {
    return this.available;
  }
  public setSecret(account: string, secret: string): void {
    if (!this.available) {
      throw new Error("OS keychain backend is unavailable on this host");
    }
    this.secrets.set(account, secret);
  }
  public getSecret(account: string): string | undefined {
    if (!this.available) {
      throw new Error("OS keychain backend is unavailable on this host");
    }
    return this.secrets.get(account);
  }
  public deleteSecret(account: string): void {
    if (!this.available) {
      throw new Error("OS keychain backend is unavailable on this host");
    }
    this.secrets.delete(account);
  }
}

describe("ProviderSecretStaging", () => {
  it("stages an env-destined credential on a host with no OS keychain", () => {
    const store = new FakeStore(false);
    const staging = new ProviderSecretStaging(store);

    staging.stage("plan-1:openai", "sk-install-smoke-value", "env");

    expect(staging.read("plan-1:openai")).toBe("sk-install-smoke-value");
  });

  it("keeps using the OS keychain when the host has one", () => {
    const store = new FakeStore(true);
    const staging = new ProviderSecretStaging(store);

    staging.stage("plan-1:openai", "sk-live", "env");

    expect(store.secrets.get("plan-1:openai")).toBe("sk-live");
    expect(staging.read("plan-1:openai")).toBe("sk-live");
  });

  it("fails closed for a keychain-destined credential when the host has no keychain", () => {
    const staging = new ProviderSecretStaging(new FakeStore(false));

    expect(() => staging.stage("plan-1:openai", "sk-live", "keychain")).toThrow(/OS keychain backend is unavailable/);
  });

  it("releases a process-held credential on clear", () => {
    const staging = new ProviderSecretStaging(new FakeStore(false));
    staging.stage("plan-1:openai", "sk-install-smoke-value", "env");

    staging.clear("plan-1:openai");

    expect(staging.read("plan-1:openai")).toBeUndefined();
  });

  it("isolates held credentials per plan", () => {
    const staging = new ProviderSecretStaging(new FakeStore(false));
    staging.stage("plan-1:openai", "sk-one", "env");
    staging.stage("plan-2:openai", "sk-two", "env");

    staging.clear("plan-1:openai");

    expect(staging.read("plan-2:openai")).toBe("sk-two");
  });
});
