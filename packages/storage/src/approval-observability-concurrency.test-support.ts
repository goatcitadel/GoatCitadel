import { Worker } from "node:worker_threads";

export interface ConcurrentObservabilityWorkerInput {
  kind: "sqlite" | "postgres";
  workerOptions: Record<string, unknown>;
  approvalId: string;
  countPerWorker: number;
}

export async function runConcurrentObservabilityWorkers(input: ConcurrentObservabilityWorkerInput): Promise<void> {
  const startGate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const runtimeModuleExtension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const workers = ["left", "right"].map(
    (prefix) =>
      new Worker(CONCURRENT_OBSERVABILITY_WORKER_SOURCE, {
        eval: true,
        workerData: {
          ...input,
          prefix,
          startGate,
          repoModuleUrl: new URL(`./approval-effect-repo${runtimeModuleExtension}`, import.meta.url).href,
          sqliteModuleUrl: new URL(`./sqlite${runtimeModuleExtension}`, import.meta.url).href,
          postgresModuleUrl: new URL(`./postgres/sync${runtimeModuleExtension}`, import.meta.url).href,
          tsxApiUrl: import.meta.resolve("tsx/esm/api"),
        },
      }),
  );
  await Promise.all(workers.map((worker) => waitForWorkerReady(worker)));
  Atomics.store(new Int32Array(startGate), 0, 1);
  Atomics.notify(new Int32Array(startGate), 0);
  await Promise.all(workers.map((worker) => waitForWorkerCompletion(worker)));
}

export function assertSingleObservabilityChain(
  effects: readonly { payload: Record<string, unknown>; createdAt: string }[],
  expectedCount: number,
): void {
  const entries = effects
    .filter((effect) => effect.payload.schemaVersion === "approval_observability.v1")
    .sort((left, right) => Number(left.payload.orderIndex) - Number(right.payload.orderIndex));
  if (entries.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} observability envelopes, received ${entries.length}.`);
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const envelope = entry?.payload;
    if (Number(envelope?.orderIndex) !== index + 1) {
      throw new Error(`Observability order index ${String(envelope?.orderIndex)} did not match ${index + 1}.`);
    }
    if (index > 0 && envelope?.predecessorDeliveryId !== entries[index - 1]?.payload.deliveryId) {
      throw new Error(`Observability predecessor chain broke at order index ${index + 1}.`);
    }
    if (index > 0 && entry!.createdAt <= entries[index - 1]!.createdAt) {
      throw new Error(`Observability creation order did not advance at order index ${index + 1}.`);
    }
  }
}

function waitForWorkerReady(worker: Worker): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown) => {
      if (isWorkerMessage(message, "ready")) {
        cleanup();
        resolve();
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
  });
}

function waitForWorkerCompletion(worker: Worker): Promise<void> {
  return new Promise((resolve, reject) => {
    worker.on("message", (message: unknown) => {
      if (isWorkerMessage(message, "done")) {
        resolve();
      } else if (isWorkerMessage(message, "error")) {
        reject(new Error(String((message as { error?: unknown }).error ?? "Concurrent observability worker failed.")));
      }
    });
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Concurrent observability worker exited with code ${code}.`));
      }
    });
  });
}

function isWorkerMessage(value: unknown, type: string): boolean {
  return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === type);
}

const CONCURRENT_OBSERVABILITY_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");

  void (async () => {
    const { tsImport } = await import(workerData.tsxApiUrl);
    const { ApprovalEffectRepository } = await tsImport(workerData.repoModuleUrl, workerData.repoModuleUrl);
    let db;
    if (workerData.kind === "sqlite") {
      const { createDatabase } = await tsImport(workerData.sqliteModuleUrl, workerData.repoModuleUrl);
      db = createDatabase(workerData.workerOptions);
    } else {
      const { PostgresSyncDatabaseClient } = await tsImport(workerData.postgresModuleUrl, workerData.repoModuleUrl);
      db = new PostgresSyncDatabaseClient(workerData.workerOptions);
    }
    const repo = new ApprovalEffectRepository(db);
    parentPort.postMessage({ type: "ready" });
    Atomics.wait(new Int32Array(workerData.startGate), 0, 0);
    try {
      for (let index = 0; index < workerData.countPerWorker; index += 1) {
        repo.upsertObservabilityBatch({
          approvalId: workerData.approvalId,
          occurredAt: "2026-03-21T10:00:00.000Z",
          attribution: { actorId: "operator-" + workerData.prefix },
          items: [
            {
              operationId: workerData.prefix + "-" + index,
              delivery: {
                kind: "audit",
                stream: "approvals",
                payload: { action: "approval.concurrent", index },
              },
            },
          ],
        });
      }
      parentPort.postMessage({ type: "done" });
    } catch (error) {
      parentPort.postMessage({
        type: "error",
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      });
    } finally {
      db.close();
    }
  })();
`;
