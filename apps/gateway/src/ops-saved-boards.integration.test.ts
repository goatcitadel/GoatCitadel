import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

const TOKEN = "ops-board-smoke-token-1234567890";
const ENV_KEYS = [
  "GATEWAY_HOST",
  "GOATCITADEL_ALLOWED_ORIGINS",
  "GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS",
  "GOATCITADEL_AUTH_MODE",
  "GOATCITADEL_AUTH_TOKEN",
  "GOATCITADEL_DATABASE_DRIVER",
  "GOATCITADEL_RATE_LIMIT_ENABLED",
  "GOATCITADEL_ROOT_DIR",
] as const;
const originalEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
const tempRoots: string[] = [];

describe("ops saved boards production composition", { timeout: 90_000 }, () => {
  afterEach(async () => {
    for (const key of ENV_KEYS) {
      const original = originalEnv.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
    for (const root of tempRoots.splice(0)) {
      await fs.promises.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("composes the canonical repository with authenticated, workspace-bound CAS routes", async () => {
    configureGateway();
    const app = await buildApp();
    try {
      const unauthorized = await app.inject({
        method: "GET",
        url: "/api/v1/ops/boards?workspaceId=default",
      });
      expect(unauthorized.statusCode).toBe(401);

      const authorized = await app.inject({
        method: "GET",
        url: "/api/v1/ops/boards?workspaceId=default",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(authorized.statusCode).toBe(200);
      expect(authorized.json()).toEqual({ workspaceId: "default", items: [] });
      expect(authorized.headers["cache-control"]).toBe("no-store");
      expect(authorized.headers.pragma).toBe("no-cache");
      expect(authorized.headers["x-goatcitadel-execution-authority"]).toBe("none");

      const otherWorkspace = (await app.services.workspaces.createWorkspace({ name: "Other Ops Workspace" })) as {
        workspaceId: string;
      };
      const createPayload = {
        workspaceId: "default",
        name: "Operations",
        placements: [{ widgetId: "runtime", kind: "runtime_truth_summary", x: 0, y: 0, width: 6, height: 4 }],
        idempotencyKey: "ops-board-domain-create-1",
      };

      const spoofedActor = await app.inject({
        method: "POST",
        url: "/api/v1/ops/boards",
        headers: mutationHeaders("transport-spoof-actor"),
        payload: { ...createPayload, actorId: "attacker" },
      });
      expect(spoofedActor.statusCode).toBe(400);

      const createdResponse = await app.inject({
        method: "POST",
        url: "/api/v1/ops/boards",
        headers: mutationHeaders("transport-create-1"),
        payload: createPayload,
      });
      expect(createdResponse.statusCode).toBe(201);
      expect(createdResponse.headers["cache-control"]).toBe("no-store");
      const created = createdResponse.json() as {
        boardId: string;
        workspaceId: string;
        revision: number;
        status: string;
        createdByActorId: string;
        requestSha256: string;
      };
      expect(created).toMatchObject({ workspaceId: "default", revision: 1, status: "active" });
      expect(created.createdByActorId).toMatch(/^token:/u);
      expect(created.requestSha256).toMatch(/^[a-f0-9]{64}$/u);

      const replayResponse = await app.inject({
        method: "POST",
        url: "/api/v1/ops/boards",
        headers: mutationHeaders("transport-create-replay"),
        payload: createPayload,
      });
      expect(replayResponse.statusCode).toBe(201);
      expect(replayResponse.json()).toMatchObject({
        boardId: created.boardId,
        requestSha256: created.requestSha256,
        revision: 1,
      });

      const replayConflict = await app.inject({
        method: "POST",
        url: "/api/v1/ops/boards",
        headers: mutationHeaders("transport-create-conflict"),
        payload: { ...createPayload, name: "Different bytes" },
      });
      expect(replayConflict.statusCode).toBe(409);

      const foreignList = await app.inject({
        method: "GET",
        url: `/api/v1/ops/boards?workspaceId=${encodeURIComponent(otherWorkspace.workspaceId)}`,
        headers: operatorHeaders(),
      });
      expect(foreignList.statusCode).toBe(200);
      expect(foreignList.json()).toEqual({ workspaceId: otherWorkspace.workspaceId, items: [] });

      const foreignGet = await app.inject({
        method: "GET",
        url: `/api/v1/ops/boards/${encodeURIComponent(created.boardId)}?workspaceId=${encodeURIComponent(otherWorkspace.workspaceId)}`,
        headers: operatorHeaders(),
      });
      expect(foreignGet.statusCode).toBe(404);

      const foreignUpdate = await app.inject({
        method: "PATCH",
        url: `/api/v1/ops/boards/${encodeURIComponent(created.boardId)}`,
        headers: mutationHeaders("transport-foreign-update"),
        payload: { workspaceId: otherWorkspace.workspaceId, name: "Foreign", expectedRevision: 1 },
      });
      expect(foreignUpdate.statusCode).toBe(404);

      const updateResponse = await app.inject({
        method: "PATCH",
        url: `/api/v1/ops/boards/${encodeURIComponent(created.boardId)}`,
        headers: mutationHeaders("transport-update-1"),
        payload: { workspaceId: "default", name: "Updated Operations", expectedRevision: 1 },
      });
      expect(updateResponse.statusCode).toBe(200);
      expect(updateResponse.json()).toMatchObject({
        boardId: created.boardId,
        workspaceId: "default",
        name: "Updated Operations",
        status: "active",
        revision: 2,
      });

      const staleUpdate = await app.inject({
        method: "PATCH",
        url: `/api/v1/ops/boards/${encodeURIComponent(created.boardId)}`,
        headers: mutationHeaders("transport-update-stale"),
        payload: { workspaceId: "default", name: "Stale", expectedRevision: 1 },
      });
      expect(staleUpdate.statusCode).toBe(409);

      const foreignArchive = await app.inject({
        method: "POST",
        url: `/api/v1/ops/boards/${encodeURIComponent(created.boardId)}/archive`,
        headers: mutationHeaders("transport-foreign-archive"),
        payload: { workspaceId: otherWorkspace.workspaceId, expectedRevision: 2 },
      });
      expect(foreignArchive.statusCode).toBe(404);

      const archivedResponse = await app.inject({
        method: "POST",
        url: `/api/v1/ops/boards/${encodeURIComponent(created.boardId)}/archive`,
        headers: mutationHeaders("transport-archive-1"),
        payload: { workspaceId: "default", expectedRevision: 2 },
      });
      expect(archivedResponse.statusCode).toBe(200);
      expect(archivedResponse.json()).toMatchObject({ status: "archived", revision: 3 });

      const archivedUpdate = await app.inject({
        method: "PATCH",
        url: `/api/v1/ops/boards/${encodeURIComponent(created.boardId)}`,
        headers: mutationHeaders("transport-update-archived"),
        payload: { workspaceId: "default", name: "Blocked", expectedRevision: 3 },
      });
      expect(archivedUpdate.statusCode).toBe(409);

      const foreignRestore = await app.inject({
        method: "POST",
        url: `/api/v1/ops/boards/${encodeURIComponent(created.boardId)}/restore`,
        headers: mutationHeaders("transport-foreign-restore"),
        payload: { workspaceId: otherWorkspace.workspaceId, expectedRevision: 3 },
      });
      expect(foreignRestore.statusCode).toBe(404);

      const restoredResponse = await app.inject({
        method: "POST",
        url: `/api/v1/ops/boards/${encodeURIComponent(created.boardId)}/restore`,
        headers: mutationHeaders("transport-restore-1"),
        payload: { workspaceId: "default", expectedRevision: 3 },
      });
      expect(restoredResponse.statusCode).toBe(200);
      expect(restoredResponse.json()).toMatchObject({ status: "active", revision: 4 });

      const boardEvents = (await app.services.realtimeEvents.listRealtimeEvents(100))
        .filter((event) => event.eventType === "ops_saved_board_changed" && event.source === "ops_saved_boards")
        .sort((left, right) => left.sequence - right.sequence);
      const epoch = boardEvents[0]?.payload.epoch;
      expect(epoch).toEqual(expect.stringMatching(/\S/u));
      expect(boardEvents.map((event) => event.payload)).toEqual([
        { workspaceId: "default", boardId: created.boardId, revision: 1, epoch, operation: "create" },
        { workspaceId: "default", boardId: created.boardId, revision: 2, epoch, operation: "update" },
        { workspaceId: "default", boardId: created.boardId, revision: 3, epoch, operation: "archive" },
        { workspaceId: "default", boardId: created.boardId, revision: 4, epoch, operation: "restore" },
      ]);
      expect(boardEvents.every((event) => event.eventAuthority === "retained_stream")).toBe(true);
      expect(boardEvents.every((event) => event.eventClass === "operational_signal")).toBe(true);
      expect(boardEvents.map((event) => event.links)).toEqual(
        Array.from({ length: 4 }, () => ({ workspaceId: "default" })),
      );
    } finally {
      await app.close();
    }
  });
});

function configureGateway(): void {
  process.env.GATEWAY_HOST = "127.0.0.1";
  process.env.GOATCITADEL_ALLOWED_ORIGINS = "http://localhost:5173";
  process.env.GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS = "false";
  process.env.GOATCITADEL_AUTH_MODE = "token";
  process.env.GOATCITADEL_AUTH_TOKEN = TOKEN;
  process.env.GOATCITADEL_DATABASE_DRIVER = "sqlite";
  process.env.GOATCITADEL_RATE_LIMIT_ENABLED = "false";
  process.env.GOATCITADEL_ROOT_DIR = createIsolatedConfigRoot();
}

function operatorHeaders(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}` };
}

function mutationHeaders(idempotencyKey: string): Record<string, string> {
  return { ...operatorHeaders(), "idempotency-key": idempotencyKey };
}

function createIsolatedConfigRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-ops-boards-"));
  fs.cpSync(path.join(findRepoRoot(), "config"), path.join(root, "config"), { recursive: true });
  tempRoots.push(root);
  return root;
}

function findRepoRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (fs.existsSync(path.join(current, "config", "goatcitadel.example.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Unable to locate GoatCitadel repository root.");
    current = parent;
  }
}
