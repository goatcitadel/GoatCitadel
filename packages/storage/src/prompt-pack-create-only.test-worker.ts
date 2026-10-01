import { parentPort, workerData } from "node:worker_threads";
import type { DatabaseClient } from "./db.js";

const input = workerData as {
  dbPath?: string;
  connectionString?: string;
  label: string;
  gate: SharedArrayBuffer;
  tsxApiUrl: string;
  repositoryUrl: string;
  sqliteUrl: string;
  postgresUrl: string;
};
const { tsImport } = (await import(input.tsxApiUrl)) as { tsImport(url: string, parent: string): Promise<unknown> };
const { PromptPackRepository } = (await tsImport(
  input.repositoryUrl,
  import.meta.url,
)) as typeof import("./prompt-pack-repo.js");
let db: DatabaseClient | undefined;
try {
  if (input.dbPath) {
    const { createDatabase } = (await tsImport(input.sqliteUrl, import.meta.url)) as typeof import("./sqlite.js");
    db = createDatabase({ dbPath: input.dbPath });
  } else {
    const { PostgresSyncDatabaseClient } = (await tsImport(
      input.postgresUrl,
      import.meta.url,
    )) as typeof import("./postgres/sync.js");
    db = new PostgresSyncDatabaseClient({
      connectionString: input.connectionString!,
      database: "postgres",
      applicationName: "prompt-pack-create-race",
      pool: { max: 1 },
    });
  }
  const repo = new PromptPackRepository(db);
  parentPort!.postMessage({ ready: true });
  if (Atomics.wait(new Int32Array(input.gate), 0, 0, 20_000) === "timed-out")
    throw new Error("Import race gate timed out");
  const created = repo.createPackWithTestsIfAbsent({
    packId: "create-only-race",
    name: input.label,
    tests: [{ code: "TEST-1", title: input.label, prompt: "No execution", orderIndex: 0 }],
  });
  parentPort!.postMessage({ created });
} catch (error) {
  const failure = error as { code?: string; details?: { reason?: string }; message?: string };
  parentPort!.postMessage({ code: failure.code, reason: failure.details?.reason, error: failure.message });
} finally {
  db?.close();
}
