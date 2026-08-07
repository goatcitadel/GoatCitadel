import { describe, expect, it, vi } from "vitest";
import { RuntimeConfigurationService } from "./runtime-configuration-service.js";

const INSTALLATION_SCOPE_ID = "test-installation-01";
const BRAVE_ACCOUNT = `runtime-configuration:installation:${INSTALLATION_SCOPE_ID}:search.brave`;

function createSecretStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    isAvailable: vi.fn(() => true),
    isWriteCustodySafe: vi.fn(() => true),
    getSecret: vi.fn((account: string) => values.get(account)),
    setSecret: vi.fn((account: string, secret: string) => {
      values.set(account, secret);
    }),
    deleteSecret: vi.fn((account: string) => {
      values.delete(account);
    }),
  };
}

function applyInput(secret = "candidate-secret") {
  return {
    targetId: "search.brave" as const,
    secret,
    requestId: "prompt-1",
    workspaceId: "default",
    sessionId: "session-1",
    turnId: "turn-1",
    actorId: "operator-1",
    expiresAt: "2099-08-07T20:00:00.000Z",
  };
}

describe("RuntimeConfigurationService", () => {
  it("probes before storing and emits only non-secret audit metadata", async () => {
    const secretStore = createSecretStore();
    const order: string[] = [];
    secretStore.setSecret.mockImplementation((account, secret) => {
      order.push("store");
      secretStore.values.set(account, secret);
    });
    const appendAudit = vi.fn(async (payload: Record<string, unknown>) => {
      order.push("audit");
      expect(JSON.stringify(payload)).not.toContain("candidate-secret");
    });
    const service = new RuntimeConfigurationService({
      secretStore,
      installationScopeId: INSTALLATION_SCOPE_ID,
      networkAllowlist: ["api.search.brave.com"],
      probe: vi.fn(async (_provider, secret) => {
        order.push("probe");
        expect(secret).toBe("candidate-secret");
        return { ok: true, status: "succeeded" };
      }),
      appendAudit,
      now: () => new Date("2026-08-07T20:00:00.000Z"),
    });

    const result = await service.configureAndValidate(applyInput());

    expect(result).toMatchObject({
      configured: true,
      validated: true,
      targetId: "search.brave",
      provider: "brave",
      source: "keychain",
    });
    expect(order).toEqual(["probe", "store", "audit"]);
    expect(secretStore.values.get(BRAVE_ACCOUNT)).toBe("candidate-secret");
    expect(appendAudit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ event: "runtime_configuration.verified_pending_settlement" }),
    );
    await service.finalizeConfiguration("prompt-1");
    expect(appendAudit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ event: "runtime_configuration.completed", revision: result.revision }),
    );
  });

  it("keeps the prior credential when the candidate fails its live probe", async () => {
    const secretStore = createSecretStore({ [BRAVE_ACCOUNT]: "working-secret" });
    const service = new RuntimeConfigurationService({
      secretStore,
      installationScopeId: INSTALLATION_SCOPE_ID,
      networkAllowlist: ["api.search.brave.com"],
      probe: async () => ({ ok: false, status: "blocked", httpStatus: 401 }),
    });

    await expect(service.configureAndValidate(applyInput("bad-secret"))).rejects.toMatchObject({
      code: "EXTERNAL_SERVICE_FAILED",
      details: expect.objectContaining({ diagnosticCode: "credential_probe_failed", httpStatus: 401 }),
    });
    expect(secretStore.setSecret).not.toHaveBeenCalled();
    expect(secretStore.values.get(BRAVE_ACCOUNT)).toBe("working-secret");
  });

  it("deduplicates a secure prompt retry without repeating the mutation", async () => {
    const secretStore = createSecretStore();
    const probe = vi.fn(async () => ({ ok: true, status: "succeeded" }));
    const service = new RuntimeConfigurationService({
      secretStore,
      installationScopeId: INSTALLATION_SCOPE_ID,
      networkAllowlist: ["api.search.brave.com"],
      probe,
    });

    const [left, right] = await Promise.all([
      service.configureAndValidate(applyInput()),
      service.configureAndValidate(applyInput()),
    ]);

    expect(left).toEqual(right);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(secretStore.setSecret).toHaveBeenCalledTimes(1);
  });

  it("rolls back the prior credential if durable audit persistence fails", async () => {
    const secretStore = createSecretStore({ [BRAVE_ACCOUNT]: "working-secret" });
    const service = new RuntimeConfigurationService({
      secretStore,
      installationScopeId: INSTALLATION_SCOPE_ID,
      networkAllowlist: ["api.search.brave.com"],
      probe: async () => ({ ok: true, status: "succeeded" }),
      appendAudit: async () => {
        throw new Error("audit unavailable");
      },
    });

    await expect(service.configureAndValidate(applyInput())).rejects.toMatchObject({
      code: "EXTERNAL_SERVICE_FAILED",
      details: expect.objectContaining({ diagnosticCode: "audit_failed_rolled_back" }),
    });
    expect(secretStore.values.get(BRAVE_ACCOUNT)).toBe("working-secret");
  });

  it("fails before probing when the OS keychain is unavailable", async () => {
    const secretStore = createSecretStore();
    secretStore.isAvailable.mockReturnValue(false);
    const probe = vi.fn(async () => ({ ok: true, status: "succeeded" }));
    const service = new RuntimeConfigurationService({
      secretStore,
      installationScopeId: INSTALLATION_SCOPE_ID,
      networkAllowlist: ["api.search.brave.com"],
      probe,
    });

    await expect(service.configureAndValidate(applyInput())).rejects.toMatchObject({
      code: "EXTERNAL_SERVICE_FAILED",
      details: expect.objectContaining({ diagnosticCode: "keychain_unavailable" }),
    });
    expect(probe).not.toHaveBeenCalled();
    expect(secretStore.setSecret).not.toHaveBeenCalled();
  });

  it("does not solicit or probe a credential when the fixed provider host is not allowlisted", async () => {
    const secretStore = createSecretStore();
    const probe = vi.fn(async () => ({ ok: true, status: "succeeded" }));
    const service = new RuntimeConfigurationService({
      secretStore,
      installationScopeId: INSTALLATION_SCOPE_ID,
      networkAllowlist: [],
      probe,
    });

    expect(() => service.assertConfigurationAvailable("search.brave")).toThrowError(
      expect.objectContaining({
        code: "POLICY_BLOCKED",
        details: expect.objectContaining({
          endpointHost: "api.search.brave.com",
          diagnosticCode: "runtime_configuration_network_prerequisite",
        }),
      }),
    );
    await expect(service.configureAndValidate(applyInput())).rejects.toMatchObject({
      code: "POLICY_BLOCKED",
      details: expect.objectContaining({ diagnosticCode: "runtime_configuration_network_prerequisite" }),
    });
    expect(probe).not.toHaveBeenCalled();
    expect(secretStore.setSecret).not.toHaveBeenCalled();
  });

  it("fails before probing when the keychain writer would expose the credential to a child process", async () => {
    const secretStore = createSecretStore();
    secretStore.isWriteCustodySafe.mockReturnValue(false);
    const probe = vi.fn(async () => ({ ok: true, status: "succeeded" }));
    const service = new RuntimeConfigurationService({
      secretStore,
      installationScopeId: INSTALLATION_SCOPE_ID,
      networkAllowlist: ["api.search.brave.com"],
      probe,
    });

    await expect(service.configureAndValidate(applyInput())).rejects.toMatchObject({
      code: "EXTERNAL_SERVICE_FAILED",
      details: expect.objectContaining({ diagnosticCode: "keychain_write_custody_unsafe" }),
    });
    expect(probe).not.toHaveBeenCalled();
    expect(secretStore.setSecret).not.toHaveBeenCalled();
  });

  it("refuses installation-wide Chat configuration in remote_hardened deployments", async () => {
    const secretStore = createSecretStore();
    const probe = vi.fn(async () => ({ ok: true, status: "succeeded" }));
    const service = new RuntimeConfigurationService({
      secretStore,
      installationScopeId: INSTALLATION_SCOPE_ID,
      networkAllowlist: ["api.search.brave.com"],
      deploymentProfile: "remote_hardened",
      probe,
    });

    await expect(service.configureAndValidate(applyInput())).rejects.toMatchObject({
      code: "POLICY_BLOCKED",
      details: expect.objectContaining({ diagnosticCode: "installation_scope_remote_blocked" }),
    });
    expect(probe).not.toHaveBeenCalled();
    expect(secretStore.setSecret).not.toHaveBeenCalled();
  });

  it("restores the prior credential when a keychain write mutates and then throws", async () => {
    const account = BRAVE_ACCOUNT;
    const secretStore = createSecretStore({ [account]: "working-secret" });
    secretStore.setSecret
      .mockImplementationOnce((candidateAccount, secret) => {
        secretStore.values.set(candidateAccount, secret);
        throw Object.assign(new Error("keychain transport failed"), { code: "KEYCHAIN_WRITE_FAILED" });
      })
      .mockImplementation((candidateAccount, secret) => {
        secretStore.values.set(candidateAccount, secret);
      });
    const service = new RuntimeConfigurationService({
      secretStore,
      installationScopeId: INSTALLATION_SCOPE_ID,
      networkAllowlist: ["api.search.brave.com"],
      probe: async () => ({ ok: true, status: "succeeded" }),
    });

    await expect(service.configureAndValidate(applyInput())).rejects.toMatchObject({
      code: "EXTERNAL_SERVICE_FAILED",
      details: expect.objectContaining({ diagnosticCode: "keychain_write_failed_rolled_back" }),
    });
    expect(secretStore.values.get(account)).toBe("working-secret");
  });

  it("resolves keychain credentials before environment aliases", async () => {
    const secretStore = createSecretStore({ [BRAVE_ACCOUNT]: "keychain-secret" });
    const service = new RuntimeConfigurationService({
      secretStore,
      installationScopeId: INSTALLATION_SCOPE_ID,
      networkAllowlist: [],
      env: { BRAVE_SEARCH_API_KEY: "environment-secret" },
    });

    await expect(service.resolveOfficialSearchCredential("brave")).resolves.toBe("keychain-secret");
    secretStore.values.clear();
    await expect(service.resolveOfficialSearchCredential("brave")).resolves.toBe("environment-secret");
  });

  it("fails credential resolution closed for durable, restart-surviving target quarantine", async () => {
    const secretStore = createSecretStore({ [BRAVE_ACCOUNT]: "possibly-uncommitted-secret" });
    const hasBlockingDurableReservation = vi.fn(async () => true);
    const service = new RuntimeConfigurationService({
      secretStore,
      installationScopeId: INSTALLATION_SCOPE_ID,
      networkAllowlist: ["api.search.brave.com"],
      hasBlockingDurableReservation,
    });

    await expect(service.resolveOfficialSearchCredential("brave")).resolves.toBeUndefined();
    expect(hasBlockingDurableReservation).toHaveBeenCalledWith("search.brave", INSTALLATION_SCOPE_ID);
    expect(secretStore.getSecret).not.toHaveBeenCalled();
  });

  it("rechecks durable quarantine after keychain resolution and fails closed when storage is unavailable", async () => {
    const secretStore = createSecretStore({ [BRAVE_ACCOUNT]: "possibly-uncommitted-secret" });
    const raceCheck = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const racedService = new RuntimeConfigurationService({
      secretStore,
      installationScopeId: INSTALLATION_SCOPE_ID,
      networkAllowlist: ["api.search.brave.com"],
      hasBlockingDurableReservation: raceCheck,
    });

    await expect(racedService.resolveOfficialSearchCredential("brave")).resolves.toBeUndefined();
    expect(raceCheck).toHaveBeenCalledTimes(2);

    const unavailableService = new RuntimeConfigurationService({
      secretStore,
      installationScopeId: INSTALLATION_SCOPE_ID,
      networkAllowlist: ["api.search.brave.com"],
      hasBlockingDurableReservation: async () => {
        throw new Error("reservation storage unavailable");
      },
    });
    await expect(unavailableService.resolveOfficialSearchCredential("brave")).resolves.toBeUndefined();
  });

  it("rechecks secret-free policy authority before probing and immediately before storing", async () => {
    const secretStore = createSecretStore();
    const probe = vi.fn(async () => ({ ok: true, status: "succeeded" }));
    const assertAuthorized = vi.fn(async (input: Record<string, unknown>) => {
      expect(JSON.stringify(input)).not.toContain("candidate-secret");
    });
    const service = new RuntimeConfigurationService({
      secretStore,
      installationScopeId: INSTALLATION_SCOPE_ID,
      networkAllowlist: ["api.search.brave.com"],
      probe,
      assertAuthorized,
    });

    await service.configureAndValidate(applyInput());

    expect(assertAuthorized).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(secretStore.setSecret).toHaveBeenCalledTimes(1);
  });

  it("fails before the probe when current policy rejects the secret-free request", async () => {
    const secretStore = createSecretStore();
    const probe = vi.fn(async () => ({ ok: true, status: "succeeded" }));
    const assertAuthorized = vi.fn(async (input: Record<string, unknown>) => {
      expect(JSON.stringify(input)).not.toContain("candidate-secret");
      throw new Error("policy changed");
    });
    const service = new RuntimeConfigurationService({
      secretStore,
      installationScopeId: INSTALLATION_SCOPE_ID,
      networkAllowlist: ["api.search.brave.com"],
      probe,
      assertAuthorized,
    });

    await expect(service.configureAndValidate(applyInput())).rejects.toThrow("policy changed");
    expect(probe).not.toHaveBeenCalled();
    expect(secretStore.setSecret).not.toHaveBeenCalled();
  });

  it("rechecks deployment profile after the live probe and refuses a newly hardened host", async () => {
    const secretStore = createSecretStore();
    let profile: "local_dev" | "remote_hardened" = "local_dev";
    const service = new RuntimeConfigurationService({
      secretStore,
      installationScopeId: INSTALLATION_SCOPE_ID,
      networkAllowlist: ["api.search.brave.com"],
      getDeploymentProfile: () => profile,
      probe: async () => {
        profile = "remote_hardened";
        return { ok: true, status: "succeeded" };
      },
    });

    await expect(service.configureAndValidate(applyInput())).rejects.toMatchObject({
      code: "POLICY_BLOCKED",
      details: expect.objectContaining({ diagnosticCode: "installation_scope_remote_blocked" }),
    });
    expect(secretStore.setSecret).not.toHaveBeenCalled();
  });

  it("rechecks prompt expiry after the live probe and fails before keychain persistence", async () => {
    const secretStore = createSecretStore();
    let currentTime = Date.parse("2026-08-07T19:59:59.000Z");
    const service = new RuntimeConfigurationService({
      secretStore,
      installationScopeId: INSTALLATION_SCOPE_ID,
      networkAllowlist: ["api.search.brave.com"],
      now: () => new Date(currentTime),
      probe: async () => {
        currentTime = Date.parse("2099-08-07T20:00:00.001Z");
        return { ok: true, status: "succeeded" };
      },
    });

    await expect(service.configureAndValidate(applyInput())).rejects.toMatchObject({
      code: "FIELD_INVALID",
      message: expect.stringContaining("expired"),
    });
    expect(secretStore.setSecret).not.toHaveBeenCalled();
  });

  it("serializes one installation target through durable finalize before a later overwrite", async () => {
    const secretStore = createSecretStore();
    const probe = vi.fn(async () => ({ ok: true, status: "succeeded" }));
    const service = new RuntimeConfigurationService({
      secretStore,
      installationScopeId: INSTALLATION_SCOPE_ID,
      networkAllowlist: ["api.search.brave.com"],
      probe,
    });

    await service.configureAndValidate(applyInput("first-secret"));
    const second = service.configureAndValidate({
      ...applyInput("second-secret"),
      requestId: "prompt-2",
    });
    await Promise.resolve();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(secretStore.values.get(BRAVE_ACCOUNT)).toBe("first-secret");

    await service.finalizeConfiguration("prompt-1");
    await second;
    expect(probe).toHaveBeenCalledTimes(2);
    expect(secretStore.values.get(BRAVE_ACCOUNT)).toBe("second-secret");
    await service.finalizeConfiguration("prompt-2");
  });

  it("restores the prior key and releases the target when durable settlement rolls back", async () => {
    const secretStore = createSecretStore({ [BRAVE_ACCOUNT]: "working-secret" });
    const service = new RuntimeConfigurationService({
      secretStore,
      installationScopeId: INSTALLATION_SCOPE_ID,
      networkAllowlist: ["api.search.brave.com"],
      probe: async () => ({ ok: true, status: "succeeded" }),
    });

    await service.configureAndValidate(applyInput("candidate-secret"));
    await service.rollbackConfiguration("prompt-1");
    expect(secretStore.values.get(BRAVE_ACCOUNT)).toBe("working-secret");

    await service.configureAndValidate({ ...applyInput("next-secret"), requestId: "prompt-2" });
    expect(secretStore.values.get(BRAVE_ACCOUNT)).toBe("next-secret");
    await service.finalizeConfiguration("prompt-2");
  });

  it("blocks activation and later writes when keychain rollback requires manual reconciliation", async () => {
    const secretStore = createSecretStore({ [BRAVE_ACCOUNT]: "working-secret" });
    secretStore.setSecret
      .mockImplementationOnce((account, secret) => {
        secretStore.values.set(account, secret);
      })
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("keychain rollback failed"), { code: "KEYCHAIN_ROLLBACK_FAILED" });
      });
    const appendAudit = vi.fn(async () => undefined);
    const probe = vi.fn(async () => ({ ok: true, status: "succeeded" }));
    const service = new RuntimeConfigurationService({
      secretStore,
      installationScopeId: INSTALLATION_SCOPE_ID,
      networkAllowlist: ["api.search.brave.com"],
      probe,
      appendAudit,
    });

    await service.configureAndValidate(applyInput("candidate-secret"));
    await expect(service.rollbackConfiguration("prompt-1")).rejects.toMatchObject({
      code: "EXTERNAL_SERVICE_FAILED",
      details: expect.objectContaining({ manualReconciliationRequired: true }),
    });
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "runtime_configuration.rollback_failed",
        manualReconciliationRequired: true,
        failureCode: "KEYCHAIN_ROLLBACK_FAILED",
      }),
    );
    await expect(service.resolveOfficialSearchCredential("brave")).resolves.toBeUndefined();
    await expect(
      service.configureAndValidate({ ...applyInput("other-secret"), requestId: "prompt-other" }),
    ).rejects.toMatchObject({
      code: "EXTERNAL_SERVICE_FAILED",
      details: expect.objectContaining({ diagnosticCode: "runtime_configuration_manual_reconciliation_required" }),
    });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("masks a newly written key while completion audit and durable settlement are still pending", async () => {
    const secretStore = createSecretStore();
    let releaseAudit!: () => void;
    const auditGate = new Promise<void>((resolve) => {
      releaseAudit = resolve;
    });
    const appendAudit = vi.fn(async (payload: Record<string, unknown>) => {
      if (payload.event === "runtime_configuration.verified_pending_settlement") await auditGate;
    });
    const service = new RuntimeConfigurationService({
      secretStore,
      installationScopeId: INSTALLATION_SCOPE_ID,
      networkAllowlist: ["api.search.brave.com"],
      probe: async () => ({ ok: true, status: "succeeded" }),
      appendAudit,
    });

    const configuring = service.configureAndValidate(applyInput("candidate-secret"));
    await vi.waitFor(() => expect(appendAudit).toHaveBeenCalled());
    expect(secretStore.values.get(BRAVE_ACCOUNT)).toBe("candidate-secret");
    await expect(service.resolveOfficialSearchCredential("brave")).resolves.toBeUndefined();

    releaseAudit();
    await configuring;
    await expect(service.resolveOfficialSearchCredential("brave")).resolves.toBeUndefined();
    await service.finalizeConfiguration("prompt-1");
    await expect(service.resolveOfficialSearchCredential("brave")).resolves.toBe("candidate-secret");
  });

  it("activates a storage-settled credential even when the completed audit projection is temporarily unavailable", async () => {
    const secretStore = createSecretStore();
    const appendAudit = vi.fn(async (payload: Record<string, unknown>) => {
      if (payload.event === "runtime_configuration.completed") throw new Error("audit projection unavailable");
    });
    const service = new RuntimeConfigurationService({
      secretStore,
      installationScopeId: INSTALLATION_SCOPE_ID,
      networkAllowlist: ["api.search.brave.com"],
      probe: async () => ({ ok: true, status: "succeeded" }),
      appendAudit,
    });

    await service.configureAndValidate(applyInput("candidate-secret"));
    await expect(service.finalizeConfiguration("prompt-1")).resolves.toBeUndefined();
    await expect(service.resolveOfficialSearchCredential("brave")).resolves.toBe("candidate-secret");
    expect(appendAudit).toHaveBeenCalledWith(expect.objectContaining({ event: "runtime_configuration.completed" }));
  });

  it("quarantines a candidate when a mutating keychain write and its immediate restore both fail", async () => {
    const secretStore = createSecretStore({ [BRAVE_ACCOUNT]: "working-secret" });
    secretStore.setSecret
      .mockImplementationOnce((account, secret) => {
        secretStore.values.set(account, secret);
        throw Object.assign(new Error("write transport failed"), { code: "KEYCHAIN_WRITE_FAILED" });
      })
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("restore transport failed"), { code: "KEYCHAIN_RESTORE_FAILED" });
      });
    const appendAudit = vi.fn(async () => undefined);
    const service = new RuntimeConfigurationService({
      secretStore,
      installationScopeId: INSTALLATION_SCOPE_ID,
      networkAllowlist: ["api.search.brave.com"],
      probe: async () => ({ ok: true, status: "succeeded" }),
      appendAudit,
    });

    await expect(service.configureAndValidate(applyInput("candidate-secret"))).rejects.toMatchObject({
      code: "EXTERNAL_SERVICE_FAILED",
      details: expect.objectContaining({ manualReconciliationRequired: true }),
    });
    expect(secretStore.values.get(BRAVE_ACCOUNT)).toBe("candidate-secret");
    await expect(service.resolveOfficialSearchCredential("brave")).resolves.toBeUndefined();
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "runtime_configuration.rollback_failed",
        reason: "keychain_write_rollback_failed",
        failureCode: "KEYCHAIN_RESTORE_FAILED",
      }),
    );
  });
});
