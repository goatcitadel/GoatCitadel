import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { RealtimeEventService } from "./services/realtime-event-service.js";

/**
 * Rule 1 of the cockpit live-data contract: reading never announces. Every registered GET route is
 * read twice on a fresh runtime, and no read may publish a realtime event. A publish here makes every
 * open window re-read, which is how a status read turned into a refetch loop (GL-01).
 *
 * Routes that change state only on a persisted transition (improvement activation settling, Code Mode
 * run expiry on read, hooks secret migration) have nothing to transition on a fresh runtime. If one
 * publishes anyway, the failure names it and the fix belongs in that service, not in an allowlist.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MISSING_PARAM = "w1-sweep-missing";
const REQUEST_TIMEOUT_MS = 5_000;

/** Not plain reads: each holds a connection open or completes a flow begun elsewhere. */
const SKIPPED_ROUTES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /stream/, reason: "server-sent event streams hold the connection open" },
  { pattern: /\/oauth\/callback/, reason: "OAuth callback completes a flow begun by the operator" },
  { pattern: /\/callback(\/|$)/, reason: "provider callback completes a flow begun by the operator" },
];

const ENV: Record<string, string> = {
  GATEWAY_HOST: "127.0.0.1",
  GOATCITADEL_ALLOWED_ORIGINS: "http://localhost:5173",
  GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS: "false",
  GOATCITADEL_AUTH_MODE: "none",
  GOATCITADEL_BUNDLED_POSTGRES_AUTOSTART: "false",
  GOATCITADEL_BUNDLED_POSTGRES_ENABLED: "false",
  GOATCITADEL_DATABASE_DRIVER: "sqlite",
  GOATCITADEL_DISABLE_SECRET_STORE: "true",
  GOATCITADEL_I_UNDERSTAND_THIS_IS_INSECURE_LOCAL_ONLY: "true",
  GOATCITADEL_LLAMACPP_AUTOSTART: "false",
  GOATCITADEL_LLAMACPP_ENABLED: "false",
  GOATCITADEL_NPU_AUTOSTART: "false",
  GOATCITADEL_NPU_ENABLED: "false",
  GOATCITADEL_RATE_LIMIT_ENABLED: "false",
};

/**
 * Pre-existing reads that reject outside their handler for a missing id (found by this sweep on
 * 2026-10-05, reported for a separate fix). They publish nothing; they are listed so a new one fails.
 */
const KNOWN_UNHANDLED_READS: string[] = [
  // listChatThreadKnowledgeAttachments does not await its session existence check.
  "/api/v1/chat/sessions/:sessionId/knowledge-attachments:",
  // The route does not await findOverlaps (nor get on the sibling read), so its 404 path never runs.
  "/api/v1/engineering-learnings/:learningId/overlaps:",
];

function concreteUrl(url: string): string {
  return url.replace(/:[A-Za-z0-9_]+(\([^)]*\))?/g, MISSING_PARAM).replace(/\*/g, MISSING_PARAM);
}

describe("GET routes never publish realtime events", { timeout: 600_000 }, () => {
  const originalEnv = new Map<string, string | undefined>();
  let root = "";
  let app: FastifyInstance | undefined;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-get-sweep-"));
    fs.cpSync(path.join(REPO_ROOT, "config"), path.join(root, "config"), { recursive: true });
    for (const [key, value] of Object.entries({ ...ENV, GOATCITADEL_ROOT_DIR: root })) {
      originalEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
    app = await buildApp();
    await app.ready();
  }, 300_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  });

  it("reads every GET route twice without a publish", async () => {
    const instance = app!;
    const reading = new AsyncLocalStorage<string>();
    const published: string[] = [];
    const original = RealtimeEventService.prototype.publishRealtime;
    vi.spyOn(RealtimeEventService.prototype, "publishRealtime").mockImplementation(function (
      this: RealtimeEventService,
      ...args: Parameters<RealtimeEventService["publishRealtime"]>
    ) {
      // Only publishes caused by a read count; startup and timer work runs outside the read context.
      const route = reading.getStore();
      if (route) published.push(`${route} -> ${args[1]}:${args[0]}`);
      return original.apply(this, args);
    });

    const routes = [
      ...new Set(
        instance.routeAccessManifest
          .filter((entry) => entry.method === "GET")
          .map((entry) => entry.url)
          .filter((url) => !SKIPPED_ROUTES.some((skip) => skip.pattern.test(url))),
      ),
    ].sort();
    expect(routes.length).toBeGreaterThan(100);

    // A read that rejects outside its handler is a Gateway bug, not a publish. Attribute each one to the
    // read just made so it is named, and keep the runner's own handlers out of the way meanwhile.
    const unhandledReads = new Set<string>();
    let currentRoute = "";
    const runnerHandlers = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    const onUnhandled = (reason: unknown) => {
      unhandledReads.add(`${currentRoute}: ${reason instanceof Error ? reason.message : String(reason)}`);
    };
    process.on("unhandledRejection", onUnhandled);
    const timedOut: string[] = [];
    try {
      for (let pass = 0; pass < 2; pass += 1) {
        for (const route of routes) {
          currentRoute = route;
          await reading.run(route, async () => {
            const outcome = await Promise.race([
              instance.inject({ method: "GET", url: concreteUrl(route) }).then(() => "done" as const),
              new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), REQUEST_TIMEOUT_MS)),
            ]);
            if (outcome === "timeout" && pass === 0) timedOut.push(route);
          });
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    } finally {
      process.off("unhandledRejection", onUnhandled);
      for (const handler of runnerHandlers) process.on("unhandledRejection", handler);
    }

    // A read that has not answered within the timeout may publish later; name those reads too.
    expect(published, `reads that did not answer within 5 s: ${timedOut.join(", ") || "none"}`).toEqual([]);
    expect(
      [...unhandledReads].filter((entry) => !KNOWN_UNHANDLED_READS.some((known) => entry.startsWith(known))),
    ).toEqual([]);
  });
});
