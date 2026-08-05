import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  scanGatewaySource,
  verifyAsyncGatewayBoundary,
} from "./verify-async-gateway-boundary.mjs";

const CONSUMER_PATH = "apps/gateway/src/services/example.ts";

test("detects sync-client references and real Atomics.wait calls without matching text decoys", () => {
  const diagnostics = scanGatewaySource({
    filePath: CONSUMER_PATH,
    source: `
      import { PostgresSyncDatabaseClient as SyncClient } from "@goatcitadel/storage";
      type Forbidden = PostgresSyncDatabaseClient;
      const computedReference = storage["PostgresSyncDatabaseClient"];
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      globalThis.Atomics["wait"](new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      (Atomics as typeof Atomics).wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      Atomics.waitAsync(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      const documentation = "PostgresSyncDatabaseClient and Atomics.wait are forbidden";
      // PostgresSyncDatabaseClient and Atomics.wait are only text here.
    `,
  });

  assert.equal(
    diagnostics.filter((diagnostic) => diagnostic.code === "postgres_sync_client_reference").length,
    3,
  );
  assert.equal(diagnostics.filter((diagnostic) => diagnostic.code === "atomics_wait_call").length, 3);
});

test("detects static, dynamic, and CommonJS postgres sync-module imports", () => {
  const diagnostics = scanGatewaySource({
    filePath: CONSUMER_PATH,
    source: `
      import sync from "@goatcitadel/storage/postgres/sync.js";
      const dynamicSync = import("../../../packages/storage/src/postgres/sync.ts");
      const commonJsSync = require("@goatcitadel/storage/postgres-sync");
      const safeStatus = import("./postgres/sync-status.js");
    `,
  });

  assert.equal(diagnostics.filter((diagnostic) => diagnostic.code === "postgres_sync_module_import").length, 3);
});

test("detects PostgreSQL constructors, remote-storage factories, aliases, and explicit-db Storage outside owners", () => {
  const diagnostics = scanGatewaySource({
    filePath: CONSUMER_PATH,
    source: `
      import * as storage from "@goatcitadel/storage";
      import {
        PostgresDatabaseClient as NativePostgres,
        PostgresAsyncDatabaseClient,
        Storage as StorageRoot,
        createPostgresRemoteStorage as createRemoteStorage,
      } from "@goatcitadel/storage";
      const native = new NativePostgres({});
      const promiseDb = new PostgresAsyncDatabaseClient(native);
      const remote = createRemoteStorage({});
      const namespaced = storage.createPostgresRemoteStorage({});
      const root = new StorageRoot({ db: promiseDb });
    `,
  });

  const violations = diagnostics.filter(
    (diagnostic) => diagnostic.code === "postgres_storage_construction_outside_factory",
  );
  assert.equal(violations.length, 5);
  assert.ok(violations.some((diagnostic) => diagnostic.message.includes("NativePostgres")));
  assert.ok(violations.some((diagnostic) => diagnostic.message.includes("createRemoteStorage")));
  assert.ok(violations.some((diagnostic) => diagnostic.message.includes("explicit database client")));
});

test("allows PostgreSQL construction only in its canonical lifecycle and storage owners", () => {
  const asyncFactoryDiagnostics = scanGatewaySource({
    filePath: "apps/gateway/src/async-database-factory.ts",
    source: `
      import { PostgresDatabaseClient, PostgresAsyncDatabaseClient } from "@goatcitadel/storage";
      const native = new PostgresDatabaseClient({});
      export const db = new PostgresAsyncDatabaseClient(native);
    `,
  });
  const storageFactoryDiagnostics = scanGatewaySource({
    filePath: "apps\\gateway\\src\\storage-factory.ts",
    source: `
      import { Storage, createPostgresRemoteStorage } from "@goatcitadel/storage";
      const db = createPostgresRemoteStorage({});
      export const storage = new Storage({ db });
    `,
  });
  const forbiddenEvenInFactory = scanGatewaySource({
    filePath: "apps/gateway/src/storage-factory.ts",
    source: `
      import { PostgresSyncDatabaseClient } from "@goatcitadel/storage";
      export const db = new PostgresSyncDatabaseClient({});
    `,
  });
  const lifecycleOwnerDiagnostics = scanGatewaySource({
    filePath: "apps/gateway/src/bundled-postgres-runtime.ts",
    source: `
      import { PostgresDatabaseClient } from "@goatcitadel/storage";
      export const maintenance = new PostgresDatabaseClient({});
    `,
  });
  const cutoverOwnerDiagnostics = scanGatewaySource({
    filePath: "apps/gateway/src/services/database-cutover-service.ts",
    source: `
      import { PostgresDatabaseClient } from "@goatcitadel/storage";
      export const verifier = new PostgresDatabaseClient({});
    `,
  });

  assert.deepEqual(asyncFactoryDiagnostics, []);
  assert.deepEqual(storageFactoryDiagnostics, []);
  assert.deepEqual(lifecycleOwnerDiagnostics, []);
  assert.deepEqual(cutoverOwnerDiagnostics, []);
  assert.ok(forbiddenEvenInFactory.some((diagnostic) => diagnostic.code === "postgres_sync_client_reference"));
});

test("ignores comments, strings, lookalike APIs, type-only remote-storage references, and SQLite Storage", () => {
  const diagnostics = scanGatewaySource({
    filePath: CONSUMER_PATH,
    source: `
      import { Storage, type PostgresRemoteStorage } from "@goatcitadel/storage";
      type Remote = PostgresRemoteStorage;
      const notes = "new PostgresDatabaseClient(); createPostgresRemoteStorage(); Atomics.wait();";
      // new PostgresDatabaseClient(); createPostgresRemoteStorage(); Atomics.wait();
      Atomics.waitAsync(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      custom.Atomics.wait();
      new PostgresDatabaseClientFactory();
      createPostgresRemoteStorageOptions();
      new Storage({ dbPath: "gateway.db" });
      import("./postgres/sync-status.js");
    `,
  });

  assert.deepEqual(diagnostics, []);
});

test("type-aware scan rejects floating Promises and casted storage calls without flagging owned work or Fastify thenables", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-async-gateway-promises-"));
  const gatewayRoot = path.join(repoRoot, "apps", "gateway");
  const gatewaySource = path.join(gatewayRoot, "src");
  const storageSource = path.join(repoRoot, "packages", "storage", "src");
  try {
    await Promise.all([
      mkdir(gatewaySource, { recursive: true }),
      mkdir(storageSource, { recursive: true }),
    ]);
    await writeFile(
      path.join(gatewayRoot, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        // The boundary walk, not tsconfig inclusion, owns the production-file
        // coverage. This deliberately excludes the Gateway fixture.
        include: ["../../packages/storage/src/**/*.ts"],
      }),
      "utf8",
    );
    await writeFile(
      path.join(storageSource, "fixture-storage.ts"),
      `
        export interface FixtureStatement {
          get(id: string): Promise<{ content: string } | undefined>;
        }
        export interface FixtureStorage {
          write(): Promise<void>;
          prepare(): Promise<FixtureStatement>;
        }
      `,
      "utf8",
    );
    await writeFile(
      path.join(gatewaySource, "promise-boundary.ts"),
      `
        import type { FixtureStorage } from "../../../packages/storage/src/fixture-storage.js";

        declare const storage: FixtureStorage;
        declare const backgroundTasks: Set<Promise<void>>;
        declare function guard(): Promise<void>;
        declare function publishRealtime(): Promise<void>;
        declare function trackBackgroundTask(tasks: Set<Promise<void>>, task: Promise<void>): void;

        interface FastifyReply {
          then(
            onFulfilled: (value: FastifyReply) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ): PromiseLike<unknown>;
          header(name: string, value: string): FastifyReply;
          hijack(): FastifyReply;
        }
        declare const reply: FastifyReply;
        interface CallbackParser {
          (body: string, done: (error: Error | null, value?: unknown) => void): void;
          (body: string): Promise<unknown>;
        }
        declare const callbackParser: CallbackParser;

        async function allowedAwait(): Promise<void> {
          await storage.write();
        }
        function allowedReturn(): Promise<void> {
          return storage.write();
        }
        async function allowedAll(): Promise<void> {
          await Promise.all([storage.write()]);
        }
        function allowedTracked(): void {
          trackBackgroundTask(backgroundTasks, storage.write());
        }
        function allowedTrackedVariable(): void {
          const task = storage.write();
          trackBackgroundTask(backgroundTasks, task);
        }
        function allowedHandledBackground(): void {
          void storage.write().catch(() => undefined);
        }
        function allowedFastify(): void {
          reply.header("cache-control", "no-store");
          reply.hijack();
        }
        function allowedCallbackOverload(): void {
          callbackParser("{}", () => undefined);
        }

        function blockedNaked(): void {
          storage.write();
          guard();
          publishRealtime();
          void guard();
        }
        async function blockedStorageCast(): Promise<{ content: string } | undefined> {
          const statement = await storage.prepare();
          const row = statement.get("message") as unknown as { content: string } | undefined;
          return row;
        }
      `,
      "utf8",
    );

    const result = await verifyAsyncGatewayBoundary({ repoRoot });
    assert.equal(result.filesScanned, 1);
    assert.equal(
      result.diagnostics.filter((diagnostic) => diagnostic.code === "floating_gateway_promise").length,
      4,
    );
    assert.equal(
      result.diagnostics.filter((diagnostic) => diagnostic.code === "unconsumed_async_storage_call").length,
      1,
    );
    assert.equal(result.diagnostics.length, 5);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.includes("storage work")));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("repository scanner includes production TypeScript and excludes test and spec files", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-async-gateway-boundary-"));
  const gatewaySource = path.join(repoRoot, "apps", "gateway", "src");
  try {
    await mkdir(path.join(gatewaySource, "nested"), { recursive: true });
    await Promise.all([
      writeFile(path.join(gatewaySource, "safe.ts"), "export const safe = true;\n", "utf8"),
      writeFile(path.join(gatewaySource, "view.tsx"), "export const view = <div />;\n", "utf8"),
      writeFile(path.join(gatewaySource, "ignored.test.ts"), "Atomics.wait(buffer, 0, 0);\n", "utf8"),
      writeFile(path.join(gatewaySource, "nested", "ignored.spec.tsx"), "Atomics.wait(buffer, 0, 0);\n", "utf8"),
    ]);

    const clean = await verifyAsyncGatewayBoundary({ repoRoot });
    assert.equal(clean.filesScanned, 2);
    assert.deepEqual(clean.diagnostics, []);

    await writeFile(
      path.join(gatewaySource, "nested", "blocked.mts"),
      "globalThis.Atomics.wait(buffer, 0, 0);\n",
      "utf8",
    );
    const blocked = await verifyAsyncGatewayBoundary({ repoRoot });
    assert.equal(blocked.filesScanned, 3);
    assert.equal(blocked.diagnostics.length, 1);
    assert.equal(blocked.diagnostics[0]?.code, "atomics_wait_call");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
