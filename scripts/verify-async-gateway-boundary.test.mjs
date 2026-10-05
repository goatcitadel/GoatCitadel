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

async function writeRoutePortFixture(repoRoot) {
  const gatewayRoot = path.join(repoRoot, "apps", "gateway");
  const servicesDir = path.join(gatewayRoot, "src", "services");
  const routesDir = path.join(gatewayRoot, "src", "routes");
  await Promise.all([mkdir(servicesDir, { recursive: true }), mkdir(routesDir, { recursive: true })]);
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
      include: ["src/**/*.ts"],
    }),
    "utf8",
  );
  await writeFile(
    path.join(servicesDir, "route-service-factory.ts"),
    `
      export type RouteMethod = (...args: any[]) => any;
      export type RoutePort<TMethod extends string> = Record<TMethod, RouteMethod>;
      export type RouteService<TMethod extends string> = Readonly<RoutePort<TMethod>>;
    `,
    "utf8",
  );
  await writeFile(
    path.join(servicesDir, "widgets-route-service.ts"),
    `
      import type { RoutePort, RouteService } from "./route-service-factory.js";

      export interface Widget {
        id: string;
        name: string;
      }
      export interface WidgetsService {
        listWidgets(workspaceId: string): Promise<Widget[]>;
        getWidget(id: string): Promise<Widget | undefined>;
        updateWidget(id: string, patch: object): Promise<Widget>;
        isFeatureEnabled(flag: string): Promise<boolean>;
        listWidgetTemplates(): string[];
        streamWidgetEvents(): AsyncGenerator<string>;
      }
      export const widgetsRouteMethods = [
        "listWidgets",
        "getWidget",
        "updateWidget",
        "isFeatureEnabled",
        "listWidgetTemplates",
        "streamWidgetEvents",
      ] as const;
      export type WidgetsRouteMethod = (typeof widgetsRouteMethods)[number];
      export type WidgetsRoutePort = RoutePort<WidgetsRouteMethod>;
      export type WidgetsRouteService = RouteService<WidgetsRouteMethod>;
      export interface WidgetsRoutePortDependencies {
        widgetsService: WidgetsService;
      }
      export function createWidgetsRoutePort(deps: WidgetsRoutePortDependencies): WidgetsRoutePort {
        return {
          listWidgets: (workspaceId) => deps.widgetsService.listWidgets(workspaceId),
          getWidget: (id) => deps.widgetsService.getWidget(id),
          updateWidget: (id, patch) => deps.widgetsService.updateWidget(id, patch),
          isFeatureEnabled: (flag) => deps.widgetsService.isFeatureEnabled(flag),
          listWidgetTemplates: () => deps.widgetsService.listWidgetTemplates(),
          streamWidgetEvents: () => deps.widgetsService.streamWidgetEvents(),
        };
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(servicesDir, "reports-route-service.ts"),
    `
      export class ReportsRouteService {
        public async exportReport(id: string): Promise<{ id: string }> {
          return { id };
        }
        public buildSummary(id: string): { id: string } {
          return { id };
        }
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(servicesDir, "gateway-route-services.ts"),
    `
      import type { WidgetsRoutePort, WidgetsRouteService } from "./widgets-route-service.js";
      import type { ReportsRouteService } from "./reports-route-service.js";

      export interface GatewayRouteServices {
        widgets: WidgetsRouteService;
        reports: ReportsRouteService;
      }
      export interface GatewayRouteServiceDependencies {
        widgets: WidgetsRoutePort;
      }
    `,
    "utf8",
  );
}

test("route-port scan flags the e881ce811 regression shapes against any-typed service ports", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-async-gateway-route-ports-"));
  try {
    await writeRoutePortFixture(repoRoot);
    await writeFile(
      path.join(repoRoot, "apps", "gateway", "src", "routes", "widgets.ts"),
      `
        import type { GatewayRouteServices } from "../services/gateway-route-services.js";

        interface Reply {
          send(payload: unknown): Reply;
          code(status: number): Reply;
        }
        declare const fastify: { services: GatewayRouteServices };
        declare const reply: Reply;
        declare function sendRouteError(target: Reply, error: unknown): void;

        export async function itemsNesting(): Promise<void> {
          reply.send({ items: fastify.services.widgets.listWidgets("ws") });
        }
        export async function returnNesting(): Promise<{ items: unknown }> {
          return { items: fastify.services.widgets.listWidgets("ws") };
        }
        export async function promiseTruthyGate(id: string): Promise<void> {
          if (!fastify.services.widgets.getWidget(id)) {
            reply.code(404).send({ error: "not_found" });
          }
          const enabled = fastify.services.widgets.isFeatureEnabled("computer-use");
          if (enabled) {
            reply.code(403).send({ error: "forbidden" });
          }
        }
        export async function projectionOverPromise(id: string): Promise<void> {
          const name = fastify.services.widgets.getWidget(id).name;
          reply.send({ name });
        }
        export async function catchBypassSend(id: string): Promise<void> {
          try {
            reply.send(fastify.services.widgets.getWidget(id));
          } catch (error) {
            sendRouteError(reply, error);
          }
        }
        export function fireAndForget(id: string): void {
          fastify.services.widgets.updateWidget(id, {});
        }
        export async function aliasAssignment(): Promise<void> {
          const { widgets } = fastify.services;
          const rows = widgets.listWidgets("ws");
          reply.send({ rows });
        }
        export async function destructuredMethod(): Promise<void> {
          const { listWidgets } = fastify.services.widgets;
          reply.send({ items: listWidgets("ws") });
        }
        export async function classServiceNesting(id: string): Promise<void> {
          reply.send({ report: fastify.services.reports.exportReport(id) });
        }
        export function classFloating(id: string): void {
          fastify.services.reports.exportReport(id);
        }
        export function floatingAdoption(id: string): void {
          Promise.resolve(fastify.services.widgets.updateWidget(id, {}));
        }
      `,
      "utf8",
    );

    const result = await verifyAsyncGatewayBoundary({ repoRoot });
    const routePortDiagnostics = result.diagnostics.filter(
      (diagnostic) => diagnostic.code === "unawaited_route_service_call",
    );
    assert.equal(routePortDiagnostics.length, 10);
    assert.ok(routePortDiagnostics.every((diagnostic) => diagnostic.filePath.endsWith("routes/widgets.ts")));
    assert.ok(routePortDiagnostics.some((diagnostic) => diagnostic.message.includes("widgets.listWidgets")));
    assert.ok(routePortDiagnostics.some((diagnostic) => diagnostic.message.includes("widgets.isFeatureEnabled")));
    assert.ok(routePortDiagnostics.some((diagnostic) => diagnostic.message.includes("reports.exportReport")));

    // classFloating is reported by the floating rule directly; floatingAdoption
    // is reported once at the un-owned Promise.resolve result.
    const floatingDiagnostics = result.diagnostics.filter(
      (diagnostic) => diagnostic.code === "floating_gateway_promise",
    );
    assert.equal(floatingDiagnostics.length, 2);
    const floatingLines = new Set(floatingDiagnostics.map((diagnostic) => diagnostic.line));
    assert.ok(
      routePortDiagnostics.every((diagnostic) => !floatingLines.has(diagnostic.line)),
      "statement-position promises already reported as floating must not be double-flagged",
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("route-port scan allows awaited, combinator, chained, thunked, streamed, owned, and sync-port shapes", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-async-gateway-route-ports-ok-"));
  try {
    await writeRoutePortFixture(repoRoot);
    await writeFile(
      path.join(repoRoot, "apps", "gateway", "src", "routes", "widgets-ok.ts"),
      `
        import type { GatewayRouteServices } from "../services/gateway-route-services.js";
        import type { WidgetsRouteService } from "../services/widgets-route-service.js";

        interface Reply {
          send(payload: unknown): Reply;
        }
        declare const fastify: { services: GatewayRouteServices };
        declare const reply: Reply;
        declare const backgroundTasks: Set<Promise<unknown>>;
        declare function trackBackgroundTask(tasks: Set<Promise<unknown>>, task: Promise<unknown>): void;
        declare function streamSse(target: Reply, handler: () => Promise<unknown>): Promise<void>;

        export async function awaited(): Promise<void> {
          const rows = await fastify.services.widgets.listWidgets("ws");
          reply.send({ rows });
        }
        export function returned(): Promise<unknown> {
          return fastify.services.widgets.listWidgets("ws");
        }
        export async function combinators(id: string): Promise<void> {
          const [rows, widget] = await Promise.all([
            fastify.services.widgets.listWidgets("ws"),
            fastify.services.widgets.getWidget(id),
          ]);
          const settled = await Promise.allSettled([fastify.services.widgets.updateWidget(id, {})]);
          reply.send({ rows, widget, settled });
        }
        export async function chained(id: string): Promise<void> {
          fastify.services.widgets.updateWidget(id, {}).catch(() => undefined);
          await fastify.services.widgets.getWidget(id).then((widget) => reply.send({ widget }));
        }
        export async function thunked(): Promise<void> {
          await streamSse(reply, () => fastify.services.widgets.listWidgets("ws"));
        }
        export function tracked(id: string): void {
          trackBackgroundTask(backgroundTasks, fastify.services.widgets.updateWidget(id, {}));
        }
        export async function adoptedResolve(id: string): Promise<void> {
          reply.send(await Promise.resolve(fastify.services.widgets.getWidget(id)));
        }
        export function handledAdoption(id: string): void {
          void Promise.resolve(fastify.services.widgets.updateWidget(id, {})).catch(() => undefined);
        }
        export async function deferredOwnedUse(id: string): Promise<void> {
          const pending = fastify.services.widgets.getWidget(id);
          reply.send({ widget: await pending });
        }
        export async function streamed(): Promise<void> {
          for await (const event of fastify.services.widgets.streamWidgetEvents()) {
            reply.send({ event });
          }
        }
        export function syncPortUse(): void {
          const templates = fastify.services.widgets.listWidgetTemplates();
          reply.send({ templates });
        }
        export function syncClassUse(id: string): void {
          reply.send({ summary: fastify.services.reports.buildSummary(id) });
        }
        export async function helperIdentified(services: GatewayRouteServices, id: string): Promise<void> {
          const service: WidgetsRouteService = services.widgets;
          const widget = await service.getWidget(id);
          reply.send({ widget });
        }
      `,
      "utf8",
    );

    const result = await verifyAsyncGatewayBoundary({ repoRoot });
    assert.deepEqual(
      result.diagnostics.filter((diagnostic) => diagnostic.code === "unawaited_route_service_call"),
      [],
    );
    assert.deepEqual(result.diagnostics, []);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

const REPLY_SEND_FIXTURE_PRELUDE = `
  import type { GatewayRouteServices } from "../services/gateway-route-services.js";

  interface FastifyReply<TPayload = unknown> {
    send(payload?: TPayload): FastifyReply<TPayload>;
    code(statusCode: number): FastifyReply<TPayload>;
    status(statusCode: number): FastifyReply<TPayload>;
    header(name: string, value: string): FastifyReply<TPayload>;
  }
  interface Learning {
    id: string;
  }
  interface EngineeringLearningService {
    get(id: string): Promise<Learning>;
    findOverlaps(id: string): Promise<Learning[]>;
    list(): Promise<Learning[]>;
    refreshAll(): Promise<number>;
    describe(id: string): Learning;
  }
  declare const fastify: {
    gatewayRuntime: { engineeringLearningService: EngineeringLearningService };
    services: GatewayRouteServices;
  };
  declare const reply: FastifyReply;
  declare const service: EngineeringLearningService;
`;

test("reply-send scan flags Promise payloads passed directly or nested in Fastify reply.send", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-async-gateway-reply-send-"));
  try {
    await writeRoutePortFixture(repoRoot);
    await writeFile(
      path.join(repoRoot, "apps", "gateway", "src", "routes", "learnings.ts"),
      `
        ${REPLY_SEND_FIXTURE_PRELUDE}

        export async function directRuntimeRead(id: string): Promise<unknown> {
          return reply.send(fastify.gatewayRuntime.engineeringLearningService.get(id));
        }
        export async function nestedItems(id: string): Promise<unknown> {
          return reply.send({ items: service.findOverlaps(id) });
        }
        export async function codeChained(): Promise<unknown> {
          return reply.code(201).send(service.list());
        }
        export async function longChainNested(): Promise<unknown> {
          return reply.status(200).header("cache-control", "no-store").send({ staleCount: service.refreshAll() });
        }
        export async function statementSend(id: string): Promise<void> {
          reply.send(service.get(id));
        }
        export async function pendingVariable(id: string): Promise<unknown> {
          const pending = service.get(id);
          return reply.send(pending);
        }
        export async function shorthandProperty(): Promise<unknown> {
          const items = service.list();
          return reply.send({ items });
        }
        export async function deeplyNested(id: string): Promise<unknown> {
          return reply.send({ data: { learning: service.get(id) }, items: [service.get(id)] });
        }
        export async function conditionalPayload(id: string, enabled: boolean): Promise<unknown> {
          return reply.send(enabled ? service.get(id) : undefined);
        }
        export async function selectedLiteralPayloads(
          id: string,
          enabled: boolean,
          cached: { learning: Learning } | undefined,
        ): Promise<unknown> {
          reply.send(enabled ? { items: service.list() } : { items: [] });
          return reply.send(cached ?? { learning: service.get(id) });
        }
        export async function castHidesPromise(id: string): Promise<unknown> {
          reply.send(service.get(id) as unknown as Learning);
          return reply.send({ learning: (service.get(id) as unknown) as Learning });
        }
        export async function helperReply(target: FastifyReply, id: string): Promise<unknown> {
          return target.code(200).send({ learning: (service.get(id)) as Promise<Learning> });
        }
        export async function routePortAlreadyFlagged(id: string): Promise<unknown> {
          return reply.send({ report: fastify.services.reports.exportReport(id) });
        }
      `,
      "utf8",
    );

    const result = await verifyAsyncGatewayBoundary({ repoRoot });
    const replySendDiagnostics = result.diagnostics.filter(
      (diagnostic) => diagnostic.code === "promise_sent_to_fastify_reply",
    );
    assert.equal(replySendDiagnostics.length, 15);
    assert.ok(replySendDiagnostics.every((diagnostic) => diagnostic.filePath.endsWith("routes/learnings.ts")));
    assert.ok(replySendDiagnostics.some((diagnostic) => diagnostic.message.includes("serializes")));

    // The class-typed route-service call is owned by the route-port rule; the
    // reply-send rule must not report the same Promise a second time.
    const routePortDiagnostics = result.diagnostics.filter(
      (diagnostic) => diagnostic.code === "unawaited_route_service_call",
    );
    assert.equal(routePortDiagnostics.length, 1);
    assert.ok(routePortDiagnostics[0]?.message.includes("reports.exportReport"));
    assert.ok(
      replySendDiagnostics.every((diagnostic) => diagnostic.line !== routePortDiagnostics[0]?.line),
      "a route-port finding must not be double-reported as a reply-send finding",
    );
    assert.equal(result.diagnostics.length, 16);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("reply-send scan allows awaited, resolved, synchronous, and non-reply payload shapes", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-async-gateway-reply-send-ok-"));
  try {
    await writeRoutePortFixture(repoRoot);
    await writeFile(
      path.join(repoRoot, "apps", "gateway", "src", "routes", "learnings-ok.ts"),
      `
        ${REPLY_SEND_FIXTURE_PRELUDE}

        export async function awaitedDirect(id: string): Promise<unknown> {
          return reply.send(await fastify.gatewayRuntime.engineeringLearningService.get(id));
        }
        export async function awaitedNested(id: string): Promise<unknown> {
          return reply.send({ items: await service.findOverlaps(id) });
        }
        export async function awaitedCodeChained(): Promise<unknown> {
          return reply.code(201).send(await service.list());
        }
        export async function awaitedVariable(id: string): Promise<unknown> {
          const learning = await service.get(id);
          return reply.send({ learning });
        }
        export async function awaitedDeferredPending(id: string): Promise<unknown> {
          const pending = service.get(id);
          return reply.send({ learning: await pending });
        }
        export async function awaitedCombinator(id: string): Promise<unknown> {
          const [learning, items] = await Promise.all([service.get(id), service.list()]);
          return reply.send({ learning, items, count: (await service.refreshAll()) + 1 });
        }
        export async function sendInsideThen(id: string): Promise<unknown> {
          return service.get(id).then((learning) => reply.send({ learning }));
        }
        export async function returnedPromise(id: string): Promise<Learning> {
          return service.get(id);
        }
        export async function awaitedSelectedLiteralPayloads(
          id: string,
          enabled: boolean,
          cached: { learning: Learning } | undefined,
        ): Promise<unknown> {
          reply.send(enabled ? { items: await service.list() } : { items: [] });
          return reply.send(cached ?? { learning: await service.get(id) });
        }
        export async function awaitedThenCast(id: string): Promise<unknown> {
          reply.send((await service.get(id)) as unknown as { id: string });
          return reply.send({ learning: (await service.get(id))! as Learning });
        }
        export function synchronousPayload(id: string): unknown {
          return reply.send({ learning: service.describe(id), items: [service.describe(id)] });
        }
        export function emptyAndLiteralPayloads(): unknown {
          reply.code(204).send();
          return reply.send({ ok: true, nested: { values: [1, 2, 3] } });
        }
      `,
      "utf8",
    );

    const result = await verifyAsyncGatewayBoundary({ repoRoot });
    assert.deepEqual(result.diagnostics, []);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("route-port scan fails loud when an any-typed port method has no scanner-visible builder", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-async-gateway-route-ports-unmapped-"));
  const gatewayRoot = path.join(repoRoot, "apps", "gateway");
  const servicesDir = path.join(gatewayRoot, "src", "services");
  const routesDir = path.join(gatewayRoot, "src", "routes");
  try {
    await Promise.all([mkdir(servicesDir, { recursive: true }), mkdir(routesDir, { recursive: true })]);
    await writeFile(
      path.join(servicesDir, "route-service-factory.ts"),
      `
        export type RouteMethod = (...args: any[]) => any;
        export type RoutePort<TMethod extends string> = Record<TMethod, RouteMethod>;
        export type RouteService<TMethod extends string> = Readonly<RoutePort<TMethod>>;
      `,
      "utf8",
    );
    await writeFile(
      path.join(servicesDir, "gateway-route-services.ts"),
      `
        import type { RouteService } from "./route-service-factory.js";

        export type GizmosRouteService = RouteService<"listGizmos">;
        export interface GatewayRouteServices {
          gizmos: GizmosRouteService;
        }
        export interface GatewayRouteServiceDependencies {
          gizmos: GizmosRouteService;
        }
      `,
      "utf8",
    );
    await writeFile(path.join(routesDir, "gizmos.ts"), "export const routes = true;\n", "utf8");

    await assert.rejects(
      () => verifyAsyncGatewayBoundary({ repoRoot }),
      (error) => error instanceof Error && /gizmos\.listGizmos/u.test(error.message),
    );
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
