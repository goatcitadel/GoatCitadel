import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConflictError } from "@goatcitadel/contracts";
import {
  ConfigGenerationApplyError,
  ConfigGenerationService,
  recoverLastGoodConfigGeneration,
  type CompleteUnifiedConfigPayload,
} from "./config-generation-service.js";
import {
  assertProviderSecretEffectsRestored,
  prepareProviderSecretMutation,
  reconcileProviderSecretEffects,
  type PreparedProviderSecretMutation,
  type ProviderSecretStorageTarget,
} from "./provider-secret-persistence.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("provider secret config generation", () => {
  it("serializes two clients so the stale client performs no secret or config mutation", async () => {
    const { root, payload } = await createConfigRoot();
    const env: NodeJS.ProcessEnv = {};
    const owner = new FakeProviderSecretOwner(env, { inline: "legacy-inline" });
    const generation = new ConfigGenerationService(root);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });

    const first = commitSet(generation, payload, owner, root, env, {
      expectedRevision: 1,
      secret: "sk-first-client",
      budgetMode: "saver",
      afterApply: async () => {
        firstEntered();
        await firstGate;
      },
    });
    await firstStarted;
    const stale = commitSet(generation, payload, owner, root, env, {
      expectedRevision: 1,
      secret: "sk-stale-client",
      budgetMode: "power",
    });
    releaseFirst();

    await expect(first).resolves.toMatchObject({ revision: 2 });
    await expect(stale).rejects.toMatchObject({
      name: ConflictError.name,
      details: { expectedRevision: 1, currentRevision: 2 },
    });
    expect(owner.keychain).toBe("sk-first-client");
    expect(owner.inline).toBeUndefined();
    expect(owner.setValues).toEqual(["sk-first-client"]);
    const active = await readActive(root);
    expect((active.budgets as { mode: string }).mode).toBe("saver");
    expect(JSON.stringify(active)).not.toContain("sk-first-client");
    expect(JSON.stringify(active)).not.toContain("sk-stale-client");
  });

  it("captures env ownership only after the expected-revision fence", async () => {
    const { root, payload } = await createConfigRoot();
    await fs.writeFile(path.join(root, ".env"), "", "utf8");
    const env: NodeJS.ProcessEnv = {};
    const owner = new FakeProviderSecretOwner(env, { envVar: "OPENAI_API_KEY" });
    const generation = new ConfigGenerationService(root);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });

    const first = commitSet(generation, payload, owner, root, env, {
      expectedRevision: 1,
      secret: "sk-first-env-client",
      storage: "env",
      budgetMode: "saver",
      afterApply: async () => {
        firstEntered();
        await firstGate;
      },
    });
    await firstStarted;
    const stale = commitSet(generation, payload, owner, root, env, {
      expectedRevision: 1,
      secret: "sk-stale-env-client",
      storage: "env",
      budgetMode: "power",
    });
    releaseFirst();

    await expect(first).resolves.toMatchObject({ revision: 2 });
    await expect(stale).rejects.toMatchObject({
      name: ConflictError.name,
      details: { expectedRevision: 1, currentRevision: 2 },
    });
    expect(owner.envOwnerSnapshotCalls).toBe(3);
    expect(env.OPENAI_API_KEY).toBe("sk-first-env-client");
    expect(await fs.readFile(path.join(root, ".env"), "utf8")).not.toContain("sk-stale-env-client");
  });

  it("does not enter a secret owner when canonical publication fails", async () => {
    const { root, payload, activeRaw } = await createConfigRoot();
    const env: NodeJS.ProcessEnv = {};
    const owner = new FakeProviderSecretOwner(env, { keychain: "sk-prior", inline: "legacy-inline" });
    const generation = new ConfigGenerationService(root, undefined, {
      beforePublish: () => {
        throw new Error("injected canonical publish failure");
      },
    });

    await expect(
      commitSet(generation, payload, owner, root, env, {
        expectedRevision: 1,
        secret: "sk-never-published",
        budgetMode: "saver",
      }),
    ).rejects.toThrow("injected canonical publish failure");

    expect(owner.keychain).toBe("sk-prior");
    expect(owner.inline).toBe("legacy-inline");
    expect(owner.setValues).toEqual([]);
    expect(await fs.readFile(activePath(root), "utf8")).toBe(activeRaw);
  });

  it("restores exact keychain and inline state when a later owner step fails", async () => {
    const { root, payload } = await createConfigRoot();
    const env: NodeJS.ProcessEnv = {};
    const owner = new FakeProviderSecretOwner(env, { keychain: "sk-prior", inline: "legacy-inline" });
    owner.failNextInlineClear = true;
    const generation = new ConfigGenerationService(root);

    await expect(
      commitSet(generation, payload, owner, root, env, {
        expectedRevision: 1,
        secret: "sk-candidate",
        budgetMode: "power",
      }),
    ).rejects.toMatchObject({ name: ConfigGenerationApplyError.name, currentRevision: 3 });

    expect(owner.keychain).toBe("sk-prior");
    expect(owner.inline).toBe("legacy-inline");
    expect(owner.setValues).toEqual(["sk-candidate", "sk-prior"]);
    const active = await readActive(root);
    expect(active.generation?.revision).toBe(3);
    expect((active.budgets as { mode: string }).mode).toBe("balanced");
    expect(JSON.stringify(active)).not.toContain("sk-candidate");
  });

  it("restores the local env owner byte-for-byte after an injected apply failure", async () => {
    const { root, payload } = await createConfigRoot();
    const envPath = path.join(root, ".env");
    const priorRaw = '# keep formatting\nOPENAI_API_KEY="sk-env-prior"\nOTHER=value\n';
    await fs.writeFile(envPath, priorRaw, "utf8");
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "sk-env-prior" };
    const owner = new FakeProviderSecretOwner(env, { envVar: "OPENAI_API_KEY", inline: "legacy-inline" });
    owner.failNextInlineClear = true;
    const generation = new ConfigGenerationService(root);

    await expect(
      commitSet(generation, payload, owner, root, env, {
        expectedRevision: 1,
        secret: "sk-env-candidate",
        storage: "env",
        budgetMode: "saver",
      }),
    ).rejects.toBeInstanceOf(ConfigGenerationApplyError);

    expect(env.OPENAI_API_KEY).toBe("sk-env-prior");
    expect(await fs.readFile(envPath, "utf8")).toBe(priorRaw);
    expect(owner.inline).toBe("legacy-inline");
  });

  it("verifies process and durable env-file owners independently when shell precedence differs", async () => {
    const { root } = await createConfigRoot();
    const envPath = path.join(root, ".env");
    await fs.writeFile(envPath, 'OPENAI_API_KEY="sk-file-prior"\n', "utf8");
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "sk-shell-prior" };
    const owner = new FakeProviderSecretOwner(env, { envVar: "OPENAI_API_KEY" });
    const prepared = prepareProviderSecretMutation({
      operation: "set",
      providerId: "openai",
      apiKey: "sk-candidate",
      storage: "env",
      rootDir: root,
      llmService: owner,
      env,
    });

    prepared.apply();
    expect(env.OPENAI_API_KEY).toBe("sk-candidate");
    expect(await fs.readFile(envPath, "utf8")).toContain("sk-candidate");
    prepared.restore();
    expect(env.OPENAI_API_KEY).toBe("sk-shell-prior");
    expect(await fs.readFile(envPath, "utf8")).toContain("sk-file-prior");
    expect(() =>
      assertProviderSecretEffectsRestored(prepared.effects, { rootDir: root, llmService: owner, env }),
    ).not.toThrow();

    // Matching shell state cannot mask a stale durable file during rollback.
    await fs.writeFile(envPath, 'OPENAI_API_KEY="sk-candidate"\n', "utf8");
    expect(() =>
      assertProviderSecretEffectsRestored(prepared.effects, { rootDir: root, llmService: owner, env }),
    ).toThrow(/manual reconciliation is required/i);

    // Conversely, a correct durable file cannot mask a stale shell override
    // during committed-forward verification.
    expect(() => reconcileProviderSecretEffects(prepared.effects, { rootDir: root, llmService: owner, env })).toThrow(
      /operator re-entry is required/i,
    );
    env.OPENAI_API_KEY = "sk-candidate";
    expect(() =>
      reconcileProviderSecretEffects(prepared.effects, { rootDir: root, llmService: owner, env }),
    ).not.toThrow();
  });

  it.each(["PATH", "NODE_OPTIONS", "GOATCITADEL_AUTH_MODE", "goatcitadel_auth_token"])(
    "rejects the reserved provider env owner %s before writing secret bytes",
    async (envVar) => {
      const { root } = await createConfigRoot();
      await fs.writeFile(path.join(root, ".env"), "", "utf8");
      const env: NodeJS.ProcessEnv = {};
      const owner = new FakeProviderSecretOwner(env, { envVar });

      expect(() =>
        prepareProviderSecretMutation({
          operation: "set",
          providerId: "openai",
          apiKey: "sk-must-not-write",
          storage: "env",
          envVar,
          rootDir: root,
          llmService: owner,
          env,
        }),
      ).toThrow(/reserved/i);

      expect(env[envVar]).toBeUndefined();
      await expect(fs.readFile(path.join(root, ".env"), "utf8")).resolves.toBe("");
    },
  );

  it("rejects an env owner already registered to another provider", async () => {
    const { root } = await createConfigRoot();
    await fs.writeFile(path.join(root, ".env"), "", "utf8");
    const env: NodeJS.ProcessEnv = {};
    const owner = new FakeProviderSecretOwner(env, {
      envVar: "SHARED_API_KEY",
      providerEnvOwners: [
        { providerId: "openai", apiKeyEnv: "SHARED_API_KEY" },
        { providerId: "anthropic", apiKeyEnv: "shared_api_key" },
      ],
    });

    expect(() =>
      prepareProviderSecretMutation({
        operation: "set",
        providerId: "openai",
        apiKey: "sk-must-not-write",
        storage: "env",
        envVar: "SHARED_API_KEY",
        rootDir: root,
        llmService: owner,
        env,
      }),
    ).toThrow(/already registered/i);

    expect(env.SHARED_API_KEY).toBeUndefined();
    await expect(fs.readFile(path.join(root, ".env"), "utf8")).resolves.toBe("");
  });

  it("rejects a requested env owner that is registered to a different provider", async () => {
    const { root } = await createConfigRoot();
    await fs.writeFile(path.join(root, ".env"), "", "utf8");
    const env: NodeJS.ProcessEnv = {};
    const owner = new FakeProviderSecretOwner(env, {
      envVar: "OPENAI_API_KEY",
      providerEnvOwners: [
        { providerId: "openai", apiKeyEnv: "OPENAI_API_KEY" },
        { providerId: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" },
      ],
    });

    expect(() =>
      prepareProviderSecretMutation({
        operation: "set",
        providerId: "openai",
        apiKey: "sk-must-not-write",
        storage: "env",
        envVar: "ANTHROPIC_API_KEY",
        rootDir: root,
        llmService: owner,
        env,
      }),
    ).toThrow(/server-managed/i);

    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    await expect(fs.readFile(path.join(root, ".env"), "utf8")).resolves.toBe("");
  });

  it("fails closed when provider env ownership drifts after preparation", async () => {
    const { root } = await createConfigRoot();
    await fs.writeFile(path.join(root, ".env"), "", "utf8");
    const env: NodeJS.ProcessEnv = {};
    const owner = new FakeProviderSecretOwner(env, { envVar: "OPENAI_API_KEY" });
    const prepared = prepareProviderSecretMutation({
      operation: "set",
      providerId: "openai",
      apiKey: "sk-must-not-write",
      storage: "env",
      envVar: "OPENAI_API_KEY",
      rootDir: root,
      llmService: owner,
      env,
    });

    owner.setProviderEnvOwners([{ providerId: "openai", apiKeyEnv: "OPENAI_ROTATED_API_KEY" }]);

    expect(() => prepared.apply()).toThrow(/changed after validation/i);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENAI_ROTATED_API_KEY).toBeUndefined();
    await expect(fs.readFile(path.join(root, ".env"), "utf8")).resolves.toBe("");
  });

  it("preserves an explicit save to the provider's existing env owner", async () => {
    const { root } = await createConfigRoot();
    await fs.writeFile(path.join(root, ".env"), "", "utf8");
    const env: NodeJS.ProcessEnv = {};
    const owner = new FakeProviderSecretOwner(env, { envVar: "OPENAI_API_KEY" });
    const prepared = prepareProviderSecretMutation({
      operation: "set",
      providerId: "openai",
      apiKey: "sk-existing-owner",
      storage: "env",
      envVar: "OPENAI_API_KEY",
      rootDir: root,
      llmService: owner,
      env,
    });

    expect(prepared.apply()).toEqual({ providerId: "openai", hasSecret: true, source: "env" });
    expect(env.OPENAI_API_KEY).toBe("sk-existing-owner");
    await expect(fs.readFile(path.join(root, ".env"), "utf8")).resolves.toContain('OPENAI_API_KEY="sk-existing-owner"');
  });

  it("recovers forward after process death following a verified owner effect without persisting secret bytes", async () => {
    const { root, payload } = await createConfigRoot();
    const env: NodeJS.ProcessEnv = {};
    const owner = new FakeProviderSecretOwner(env, { inline: "legacy-inline" });
    const generation = new ConfigGenerationService(root, undefined, {
      afterOwnerApply: () => {
        throw new Error("simulated process death after provider owner apply");
      },
    });

    await expect(
      commitSet(generation, payload, owner, root, env, {
        expectedRevision: 1,
        secret: "sk-hard-crash",
        budgetMode: "saver",
      }),
    ).rejects.toThrow("simulated process death after provider owner apply");

    expect(owner.keychain).toBe("sk-hard-crash");
    expect(generation.getHealthSnapshot().transactionState).toBe("committed");
    const markerRaw = await fs.readFile(transactionPath(root), "utf8");
    expect(markerRaw).not.toContain("sk-hard-crash");
    expect(await fs.readFile(activePath(root), "utf8")).not.toContain("sk-hard-crash");

    await expect(recoverLastGoodConfigGeneration(root)).resolves.toMatchObject({ recovered: false, revision: 2 });
    const restarted = new ConfigGenerationService(root);
    const effects = restarted.getRuntimeOwnerRecoveryIntent()?.providerSecretEffects ?? [];
    expect(effects).toHaveLength(1);
    expect(() => reconcileProviderSecretEffects(effects, { rootDir: root, llmService: owner, env })).not.toThrow();
    await restarted.completeRuntimeOwnerReconciliation();
    expect(restarted.getHealthSnapshot().transactionState).toBe("idle");
  });

  it("retains a degraded committed marker when process death precedes a set effect", async () => {
    const { root, payload } = await createConfigRoot();
    const env: NodeJS.ProcessEnv = {};
    const owner = new FakeProviderSecretOwner(env);
    const generation = new ConfigGenerationService(root, undefined, {
      afterCommitMarker: () => {
        throw new Error("simulated process death before provider owner apply");
      },
    });

    await expect(
      commitSet(generation, payload, owner, root, env, {
        expectedRevision: 1,
        secret: "sk-unavailable-after-crash",
        budgetMode: "power",
      }),
    ).rejects.toThrow("simulated process death before provider owner apply");
    expect(owner.keychain).toBeUndefined();

    await recoverLastGoodConfigGeneration(root);
    const restarted = new ConfigGenerationService(root);
    const effects = restarted.getRuntimeOwnerRecoveryIntent()?.providerSecretEffects ?? [];
    expect(() => reconcileProviderSecretEffects(effects, { rootDir: root, llmService: owner, env })).toThrow(
      /operator re-entry is required/i,
    );
    expect(restarted.getHealthSnapshot().transactionState).toBe("committed");
    await expect(fs.stat(transactionPath(root))).resolves.toBeDefined();
  });
});

interface CommitSetOptions {
  expectedRevision: number;
  secret: string;
  budgetMode: "saver" | "balanced" | "power";
  storage?: ProviderSecretStorageTarget;
  afterApply?: () => void | Promise<void>;
}

function commitSet(
  generation: ConfigGenerationService,
  payload: CompleteUnifiedConfigPayload,
  owner: FakeProviderSecretOwner,
  root: string,
  env: NodeJS.ProcessEnv,
  options: CommitSetOptions,
) {
  type Runtime = { prepared?: PreparedProviderSecretMutation };
  let prepared: PreparedProviderSecretMutation | undefined;
  return generation.commit<Runtime>({
    expectedRevision: options.expectedRevision,
    requireExpectedRevision: true,
    previousRuntime: {},
    buildCandidate: () => {
      prepared = prepareProviderSecretMutation({
        operation: "set",
        providerId: "openai",
        apiKey: options.secret,
        storage: options.storage,
        rootDir: root,
        llmService: owner,
        env,
      });
      const candidate = structuredClone(payload);
      (candidate.budgets as { mode: string }).mode = options.budgetMode;
      return { payload: candidate, runtime: { prepared } };
    },
    captureRuntimeOwnerRecoveryIntent: (runtime) => ({
      version: 1,
      providerSecretEffects: runtime.prepared?.effects ?? [],
    }),
    apply: async (runtime) => {
      runtime.prepared?.apply();
      await options.afterApply?.();
    },
    restore: async () => {
      prepared?.restore();
    },
  });
}

class FakeProviderSecretOwner {
  public keychain: string | undefined;
  public inline: string | undefined;
  public readonly setValues: string[] = [];
  public envOwnerSnapshotCalls = 0;
  public failNextInlineClear = false;
  private readonly envVar: string;
  private providerEnvOwners: Array<{ providerId: string; apiKeyEnv?: string }>;

  public constructor(
    private readonly env: NodeJS.ProcessEnv,
    options: {
      keychain?: string;
      inline?: string;
      envVar?: string;
      providerEnvOwners?: Array<{ providerId: string; apiKeyEnv?: string }>;
    } = {},
  ) {
    this.keychain = options.keychain;
    this.inline = options.inline;
    this.envVar = options.envVar ?? "OPENAI_API_KEY";
    this.providerEnvOwners = options.providerEnvOwners ?? [{ providerId: "openai", apiKeyEnv: this.envVar }];
  }

  public isProviderKeychainAvailable(): boolean {
    return true;
  }

  public readProviderKeychainApiKeyForPersistence(providerId: string): string | undefined {
    this.assertProvider(providerId);
    return this.keychain;
  }

  public setProviderApiKey(providerId: string, apiKey: string): void {
    this.assertProvider(providerId);
    this.setValues.push(apiKey);
    this.keychain = apiKey;
  }

  public deleteProviderApiKey(providerId: string): void {
    this.assertProvider(providerId);
    this.keychain = undefined;
  }

  public readInlineProviderApiKeyForPersistence(providerId: string): string | undefined {
    this.assertProvider(providerId);
    return this.inline;
  }

  public restoreInlineProviderApiKeyForPersistence(providerId: string, apiKey: string | undefined): void {
    this.assertProvider(providerId);
    this.inline = apiKey;
  }

  public clearInlineProviderApiKey(providerId: string): void {
    this.assertProvider(providerId);
    if (this.failNextInlineClear) {
      this.failNextInlineClear = false;
      throw new Error("injected inline owner failure");
    }
    this.inline = undefined;
  }

  public invalidateProviderSecretStatus(providerId: string): void {
    this.assertProvider(providerId);
  }

  public getProviderSecretStatus(providerId: string) {
    this.assertProvider(providerId);
    if (this.keychain) {
      return { providerId, hasApiKey: true, apiKeySource: "keychain" as const };
    }
    if (this.env[this.envVar]) {
      return { providerId, hasApiKey: true, apiKeySource: "env" as const };
    }
    if (this.inline) {
      return { providerId, hasApiKey: true, apiKeySource: "inline" as const };
    }
    return { providerId, hasApiKey: false, apiKeySource: "none" as const };
  }

  public getRuntimeConfig() {
    return { providers: [{ providerId: "openai", apiKeyRef: this.envVar }] };
  }

  public snapshotRuntimeConfigForPersistence() {
    this.envOwnerSnapshotCalls += 1;
    return { providers: this.providerEnvOwners.map((provider) => ({ ...provider })) };
  }

  public setProviderEnvOwners(providers: Array<{ providerId: string; apiKeyEnv?: string }>): void {
    this.providerEnvOwners = providers.map((provider) => ({ ...provider }));
  }

  private assertProvider(providerId: string): void {
    if (providerId !== "openai") {
      throw new Error(`Unknown LLM provider: ${providerId}`);
    }
  }
}

async function createConfigRoot(): Promise<{
  root: string;
  payload: CompleteUnifiedConfigPayload;
  activeRaw: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-provider-secret-generation-"));
  roots.push(root);
  const payload = JSON.parse(
    await fs.readFile(path.resolve(process.cwd(), "../../config/goatcitadel.example.json"), "utf8"),
  ) as CompleteUnifiedConfigPayload;
  const activeRaw = `${JSON.stringify(payload, null, 2)}\n`;
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.writeFile(activePath(root), activeRaw, "utf8");
  return { root, payload, activeRaw };
}

function activePath(root: string): string {
  return path.join(root, "config", "goatcitadel.json");
}

function transactionPath(root: string): string {
  return path.join(root, "config", ".generations", "transaction.json");
}

async function readActive(root: string): Promise<CompleteUnifiedConfigPayload> {
  return JSON.parse(await fs.readFile(activePath(root), "utf8")) as CompleteUnifiedConfigPayload;
}
