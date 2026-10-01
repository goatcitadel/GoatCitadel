import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createSqliteAsyncStorage, Storage, type AsyncStorage } from "@goatcitadel/storage";
import { ValidationError } from "@goatcitadel/contracts";
import { CapabilityScopeRepository } from "../../../../packages/storage/src/capability-scope-repo.js";
import { CapabilityScopeRouteService } from "../services/capability-scope-route-service.js";
import { CapabilityScopeResolver } from "../services/capability-scope-resolver.js";
import { authPlugin } from "../plugins/auth.js";
import { idempotencyHeaderPlugin } from "../plugins/idempotency.js";
import { installRouteAccessTracking } from "./route-access.js";
import { capabilityScopeRoutes } from "./capability-scope-routes.js";

let local: Storage, storage: AsyncStorage, repo: CapabilityScopeRepository, temp: string, serial = 0;
const apps: FastifyInstance[] = [];
beforeAll(() => {
  temp = mkdtempSync(path.join(os.tmpdir(), "gc-scope-routes-"));
  local = new Storage({ dbPath: ":memory:", transcriptsDir: path.join(temp, "transcripts"), auditDir: path.join(temp, "audit") });
  storage = createSqliteAsyncStorage(local); repo = new CapabilityScopeRepository(local.db);
}, 60_000);
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.restoreAllMocks(); });
afterAll(async () => {
  await storage?.close();
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir())); assert.ok(path.basename(temp).startsWith("gc-scope-routes-"));
  rmSync(temp, { recursive: true, force: true });
});
async function fixture() {
  const citadel = local.citadels.createRecord({ name: `Scope route ${++serial}` });
  const workspace = local.workspaces.create({ name: `Scope workspace ${serial}`, citadelId: citadel.citadelId });
  const listRegistry = vi.fn(async () => [{ ref: "one", label: "One" }, { ref: "two", label: "Two" }]);
  const resolver = new CapabilityScopeResolver({ listAssignmentsForScope: (kind, id) => repo.listForScope(kind, id),
    listAllSkillIds: () => ["one", "two"], listAllIntegrationIds: () => [], listAllMcpServerIds: () => [], isDisabled: () => false });
  const service = new CapabilityScopeRouteService({ repo: {
    list: async (...args) => repo.list(...args), clear: async (...args) => repo.clear(...args),
    replaceSet: async (...args) => repo.replaceSet(...args), getSelectionReview: async (...args) => repo.getSelectionReview(...args),
    replaceReviewed: async (...args) => repo.replaceReviewed(...args),
  }, resolver, listRegistry, resolveCitadelId: async id => local.workspaces.get(id).citadelId });
  const app = Fastify(); apps.push(app);
  app.decorate("gatewayConfig", { assistant: { auth: { mode: "token", allowLoopbackBypass: false, token: { value: "synthetic-operator", queryParam: "access_token" }, basic: { username: "", password: "" } } } } as never);
  app.decorate("gatewayAuth", { getOnboardingStartupState: () => ({ completed: true }), validateDeviceAccessToken: () => undefined, validateCompanionAccessToken: () => undefined } as never);
  app.decorate("services", { capabilityScope: service } as never);
  installRouteAccessTracking(app); await app.register(authPlugin);
  await app.register(idempotencyHeaderPlugin, { mutationStore: storage.mutationIdempotency });
  await app.register(capabilityScopeRoutes);
  const headers = () => ({ authorization: "Bearer synthetic-operator", "Idempotency-Key": `scope-${++serial}` });
  const base = `/api/v1/workspaces/${workspace.workspaceId}/capabilities`;
  const read = () => repo.getSelectionReview("workspace", workspace.workspaceId, "skill")!;
  return { app, headers, base, read, citadel, workspace, service, listRegistry };
}

it("advertises exact selection authority and accepts a guarded receipt independently of live registry projections", async () => {
  const f = await fixture();
  const view = await f.app.inject({ method: "GET", url: `${f.base}?type=skill`, headers: f.headers() });
  expect(view.statusCode).toBe(200); expect(view.json().selectionReview).toEqual(f.read());
  const before = f.read(), assignments = [{ resourceRef: "two", enabled: false }, { resourceRef: "one", enabled: true }];
  f.listRegistry.mockRejectedValueOnce(new Error("Live registry unavailable after review"));
  const request = { method: "PATCH" as const, url: `${f.base}/reviewed`, headers: f.headers(), payload: { resourceType: "skill", expectedRevision: before.revision, assignments } };
  const response = await f.app.inject(request);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ version: "capability_scope_receipt.v1", previousRevision: before.revision, selectionReview: f.read() });
  expect(f.read().assignments).toEqual([...assignments].reverse());
  expect((await f.app.inject(request)).statusCode).toBe(409);
});
it("requires operator auth, exact bounded input and current same-scope revision before any write", async () => {
  const f = await fixture(), before = f.read(), payload = { resourceType: "skill", expectedRevision: before.revision, assignments: [] };
  expect((await f.app.inject({ method: "PATCH", url: `${f.base}/reviewed`, payload })).statusCode).toBe(401);
  for (const body of [{ ...payload, expectedRevision: "bad" }, { ...payload, extra: true }, { ...payload, assignments: [{ resourceRef: "one", enabled: true }, { resourceRef: "one", enabled: false }] }]) {
    expect((await f.app.inject({ method: "PATCH", url: `${f.base}/reviewed`, headers: f.headers(), payload: body })).statusCode).toBe(400);
    expect(f.read()).toEqual(before);
  }
  repo.setEnabled("citadel", f.citadel.citadelId, "skill", "one", false);
  const current = f.read();
  const stale = await f.app.inject({ method: "DELETE", url: `${f.base}/reviewed`, headers: f.headers(), payload: { resourceType: "skill", expectedRevision: before.revision } });
  expect(stale.statusCode).toBe(409); expect(stale.json()).toMatchObject({ code: "WRITE_CONFLICT", details: { reason: "CAPABILITY_SCOPE_REVISION_CONFLICT" } });
  expect(f.read()).toEqual(current);
});
it("preserves explicit legacy writes and gives reviewed reset a new inheritance receipt", async () => {
  const f = await fixture();
  expect((await f.app.inject({ method: "PATCH", url: f.base, headers: f.headers(), payload: { resourceType: "skill", assignments: [{ resourceRef: "one", enabled: false }] } })).statusCode).toBe(200);
  const before = f.read();
  const reset = await f.app.inject({ method: "DELETE", url: `${f.base}/reviewed`, headers: f.headers(), payload: { resourceType: "skill", expectedRevision: before.revision } });
  expect(reset.statusCode).toBe(200); expect(reset.json().selectionReview.assignments).toEqual([]); expect(f.read().revision).not.toBe(before.revision);
});
it("retains committed wire truth when durable HTTP acknowledgement fails with a typed error", async () => {
  const f = await fixture(), before = f.read();
  vi.spyOn(local.mutationIdempotency, "markCompleted").mockImplementationOnce(() => { throw new ValidationError({ message: "Private follow-up failure" }); });
  const request = { method: "PATCH" as const, url: `${f.base}/reviewed`, headers: f.headers(), payload: { resourceType: "skill", expectedRevision: before.revision, assignments: [{ resourceRef: "one", enabled: false }] } };
  const response = await f.app.inject(request);
  expect(response.statusCode).toBe(500); expect(response.json()).toEqual({ error: "The capability selection was committed, but its response could not be completed.", mutationCommitted: true });
  expect(f.read().assignments).toEqual(request.payload.assignments);
  expect((await f.app.inject(request)).statusCode).toBe(409);
});
it("withholds a review if a parent selection changes during the live availability read", async () => {
  const f = await fixture();
  f.listRegistry.mockImplementationOnce(async () => { repo.setEnabled("citadel", f.citadel.citadelId, "skill", "one", false); return []; });
  const view = await f.service.getView("workspace", f.workspace.workspaceId, "skill");
  expect(view.selectionReview).toBeUndefined();
});
