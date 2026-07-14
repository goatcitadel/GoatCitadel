import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayService } from "./gateway-service.js";
import {
  ConfigGenerationApplyError,
  ConfigGenerationService,
  recoverLastGoodConfigGeneration,
  type CompleteUnifiedConfigPayload,
  type ConfigGenerationServiceHooks,
} from "./config-generation-service.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Gateway database driver config generation", () => {
  it("commits Postgres once and advances the canonical revision once", async () => {
    const { runtime, generation, readLiveDriver } = await buildHarness();

    await expect(
      GatewayService.prototype.commitDatabaseDriver.call(runtime as GatewayService, {
        driver: "postgres",
        expectedRevision: 1,
      }),
    ).resolves.toEqual({ revision: 2 });

    expect(readLiveDriver()).toBe("postgres");
    expect(readCanonicalDriver(generation)).toBe("postgres");
    expect(generation.getHealthSnapshot()).toMatchObject({ revision: 2, transactionState: "idle" });
  });

  it("leaves SQLite runtime/canonical and retains SQLite last-good when canonical publication fails", async () => {
    const { runtime, generation, root, readLiveDriver } = await buildHarness({
      beforePublish: () => {
        throw new Error("injected canonical publication failure");
      },
    });

    await expect(
      GatewayService.prototype.commitDatabaseDriver.call(runtime as GatewayService, {
        driver: "postgres",
        expectedRevision: 1,
      }),
    ).rejects.toThrow("injected canonical publication failure");

    expect(readLiveDriver()).toBe("sqlite");
    expect(readCanonicalDriver(generation)).toBe("sqlite");
    expect(generation.getHealthSnapshot()).toMatchObject({ revision: 1, transactionState: "idle" });
    expect(await readLastGoodDriver(root)).toBe("sqlite");
  });

  it("compensates an owner failure and publishes only a monotonic SQLite rollback", async () => {
    const { runtime, generation, root, readLiveDriver } = await buildHarness({}, { failOwnerApply: true });

    await expect(
      GatewayService.prototype.commitDatabaseDriver.call(runtime as GatewayService, {
        driver: "postgres",
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(ConfigGenerationApplyError);

    expect(readLiveDriver()).toBe("sqlite");
    expect(readCanonicalDriver(generation)).toBe("sqlite");
    expect(generation.getHealthSnapshot()).toMatchObject({ revision: 3, transactionState: "idle" });
    expect(await readLastGoodDriver(root)).toBe("sqlite");
  });

  it("keeps a durable Postgres decision after a hard-crash window so restart recovers forward", async () => {
    const { runtime, generation, root, readLiveDriver } = await buildHarness({
      afterCommitMarker: () => {
        throw new Error("simulated process death after database-driver decision");
      },
    });

    await expect(
      GatewayService.prototype.commitDatabaseDriver.call(runtime as GatewayService, {
        driver: "postgres",
        expectedRevision: 1,
      }),
    ).rejects.toThrow("simulated process death after database-driver decision");

    expect(readLiveDriver()).toBe("sqlite");
    expect(readCanonicalDriver(generation)).toBe("postgres");
    expect(generation.getHealthSnapshot()).toMatchObject({ revision: 2, transactionState: "committed" });

    await expect(recoverLastGoodConfigGeneration(root)).resolves.toMatchObject({
      recovered: false,
      revision: 2,
    });
    const restarted = new ConfigGenerationService(root);
    expect(restarted.isRuntimeOwnerReconciliationPending()).toBe(true);
    expect(readCanonicalDriver(restarted)).toBe("postgres");
    await restarted.completeRuntimeOwnerReconciliation();
    expect(restarted.getHealthSnapshot().transactionState).toBe("idle");
  });
});

async function buildHarness(
  hooks: ConfigGenerationServiceHooks = {},
  options: { failOwnerApply?: boolean } = {},
): Promise<{
  root: string;
  runtime: any;
  generation: ConfigGenerationService;
  readLiveDriver(): "sqlite" | "postgres";
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-database-driver-generation-"));
  tempRoots.push(root);
  const payload = JSON.parse(
    await fs.readFile(path.resolve(process.cwd(), "../../config/goatcitadel.example.json"), "utf8"),
  ) as CompleteUnifiedConfigPayload;
  payload.assistant.database.driver = "sqlite";
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.writeFile(path.join(root, "config", "goatcitadel.json"), `${JSON.stringify(payload, null, 2)}\n`);

  const generation = new ConfigGenerationService(root, undefined, hooks);
  const config = {
    rootDir: root,
    assistant: structuredClone(payload.assistant),
    toolPolicy: structuredClone(payload.toolPolicy),
    budgets: structuredClone(payload.budgets),
    llm: structuredClone(payload.llm),
  };
  let liveDriver: "sqlite" | "postgres" = "sqlite";
  let ownerFailureInjected = false;
  Object.defineProperty(config.assistant.database, "driver", {
    configurable: true,
    enumerable: true,
    get: () => liveDriver,
    set: (driver: "sqlite" | "postgres") => {
      liveDriver = driver;
      if (options.failOwnerApply && driver === "postgres" && !ownerFailureInjected) {
        ownerFailureInjected = true;
        throw new Error("injected database driver owner failure");
      }
    },
  });

  const runtime: any = {
    config,
    configGenerationService: generation,
    llmService: { exportConfigFile: () => structuredClone(payload.llm) },
    readFeatureFlags: () => structuredClone(config.assistant.features),
  };
  runtime.readSettingsRevision = () => GatewayService.prototype.readSettingsRevision.call(runtime as GatewayService);
  runtime.buildUnifiedConfigPayloadForRuntime = (
    candidateConfig: typeof config,
    candidateLlm: CompleteUnifiedConfigPayload["llm"],
    candidateFeatures: CompleteUnifiedConfigPayload["assistant"]["features"],
  ) => {
    const candidate = structuredClone(payload);
    candidate.assistant.database = structuredClone(candidateConfig.assistant.database);
    candidate.assistant.features = structuredClone(candidateFeatures);
    candidate.llm = structuredClone(candidateLlm);
    return candidate;
  };

  return {
    root,
    runtime,
    generation,
    readLiveDriver: () => liveDriver,
  };
}

function readCanonicalDriver(service: ConfigGenerationService): "sqlite" | "postgres" {
  return service.getActivePayload().assistant.database.driver;
}

async function readLastGoodDriver(root: string): Promise<"sqlite" | "postgres"> {
  const payload = JSON.parse(
    await fs.readFile(path.join(root, "config", ".generations", "last-good.json"), "utf8"),
  ) as CompleteUnifiedConfigPayload;
  return payload.assistant.database.driver;
}
