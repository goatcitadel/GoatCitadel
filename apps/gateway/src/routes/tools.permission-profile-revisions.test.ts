import Fastify, { type FastifyInstance } from "fastify";
import { ConflictError } from "@goatcitadel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toolsRoutes } from "./tools.js";

const reviewedRevision = "a".repeat(64);
const currentRevision = "b".repeat(64);
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function buildApp(owner = "operator-test") {
  const profile = { profileId: "profile-1", label: "Current profile", builtin: false, status: "active",
    scope: "operator", scopeRef: owner, createdBy: owner, revision: currentRevision };
  const tools = {
    listPermissionProfiles: vi.fn(() => [profile]),
    updatePermissionProfile: vi.fn(() => profile),
    archivePermissionProfile: vi.fn(() => true),
    activatePermissionProfile: vi.fn((input) => ({ ...input, activationId: "activation-1" })),
    reviewPermissionProfileSelection: vi.fn((input) => ({ revision: "c".repeat(64), input, target: {}, activeProfiles: [] })),
  };
  const app = Fastify();
  apps.push(app);
  app.decorateRequest("authActorId", "operator-test");
  app.decorateRequest("authActorSource", "loopback");
  app.decorate("requireOperatorAuth", vi.fn(async () => undefined) as never);
  app.decorate("services", { tools } as never);
  const committed: boolean[] = [];
  app.addHook("onSend", async (request, _reply, payload) => {
    committed.push(request.mutationCommitted === true);
    return payload;
  });
  await app.register(toolsRoutes);
  return { app, tools, profile, committed };
}

describe.each([
  { action: "save", method: "PATCH" as const, suffix: "" },
  { action: "archive", method: "POST" as const, suffix: "/archive" },
])("permission profile $action revisions", ({ method, suffix }) => {
  it.each([undefined, null, "", "short", "z".repeat(64), 123])("rejects invalid revision %s before invoking an owner", async (expectedRevision) => {
    const { app, tools, committed } = await buildApp();
    const response = await app.inject({ method, url: `/api/v1/tools/permission-profiles/profile-1${suffix}`,
      payload: { expectedRevision, label: "Draft" } });
    expect(response.statusCode).toBe(400);
    expect(tools.listPermissionProfiles).not.toHaveBeenCalled();
    expect(tools.updatePermissionProfile).not.toHaveBeenCalled();
    expect(tools.archivePermissionProfile).not.toHaveBeenCalled();
    expect(committed).toEqual([false]);
  });

  it("forwards the reviewed token unchanged instead of replacing it with the latest list revision", async () => {
    const { app, tools, committed } = await buildApp();
    const response = await app.inject({ method, url: `/api/v1/tools/permission-profiles/profile-1${suffix}`,
      payload: { expectedRevision: reviewedRevision, label: "Draft", updatedBy: "spoofed-actor" } });
    expect(response.statusCode).toBe(200);
    if (method === "PATCH") {
      expect(tools.updatePermissionProfile).toHaveBeenCalledExactlyOnceWith("profile-1", {
        expectedRevision: reviewedRevision, label: "Draft", updatedBy: "operator-test",
      });
    } else {
      expect(tools.archivePermissionProfile).toHaveBeenCalledExactlyOnceWith("profile-1", "operator-test", reviewedRevision);
    }
    expect(committed).toEqual([true]);
  });

  it("returns the owner conflict as 409 without recording a successful mutation", async () => {
    const { app, tools, committed } = await buildApp();
    const conflict = () => { throw new ConflictError({ code: "WRITE_CONFLICT",
      message: "Review the latest permission profile.", details: { reason: "PERMISSION_PROFILE_REVISION_CONFLICT" } }); };
    tools.updatePermissionProfile.mockImplementation(conflict);
    tools.archivePermissionProfile.mockImplementation(conflict);
    const response = await app.inject({ method, url: `/api/v1/tools/permission-profiles/profile-1${suffix}`,
      payload: { expectedRevision: reviewedRevision, label: "Draft" } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "WRITE_CONFLICT", details: { reason: "PERMISSION_PROFILE_REVISION_CONFLICT" } });
    expect(committed).toEqual([false]);
  });

  it("does not let a valid revision bypass profile ownership", async () => {
    const { app, tools, committed } = await buildApp("another-operator");
    const response = await app.inject({ method, url: `/api/v1/tools/permission-profiles/profile-1${suffix}`,
      payload: { expectedRevision: currentRevision, label: "Draft" } });
    expect(response.statusCode).toBe(403);
    expect(tools.updatePermissionProfile).not.toHaveBeenCalled();
    expect(tools.archivePermissionProfile).not.toHaveBeenCalled();
    expect(committed).toEqual([false]);
  });
});

describe("permission selection reviews", () => {
  it.each([
    {}, { expectedProfileRevision: reviewedRevision }, { expectedSelectionRevision: reviewedRevision },
    { expectedProfileRevision: reviewedRevision, expectedSelectionRevision: "invalid" },
  ])("rejects incomplete activation preconditions before the owner runs: %j", async (preconditions) => {
    const { app, tools, committed } = await buildApp();
    const response = await app.inject({ method: "POST", url: "/api/v1/tools/permission-profiles/activate",
      payload: { profileId: "profile-1", surface: "chat", ...preconditions } });
    expect(response.statusCode).toBe(400);
    expect(tools.activatePermissionProfile).not.toHaveBeenCalled();
    expect(tools.listPermissionProfiles).not.toHaveBeenCalled();
    expect(committed).toEqual([false]);
  });

  it("returns an actor-bound review without recording a committed mutation", async () => {
    const { app, tools, committed } = await buildApp();
    const input = { operation: "defaults", scope: "workspace", scopeRef: "workspace-1", defaultForSurfaces: ["chat"] };
    const response = await app.inject({ method: "POST", url: "/api/v1/tools/permission-profiles/selection-review",
      payload: { ...input, createdBy: "spoofed" } });
    expect(response.statusCode).toBe(200);
    expect(tools.reviewPermissionProfileSelection).toHaveBeenCalledExactlyOnceWith({ ...input, createdBy: "operator-test" });
    expect(tools.activatePermissionProfile).not.toHaveBeenCalled();
    expect(committed).toEqual([false]);
  });

  it("forwards both reviewed tokens and preserves a selection conflict as an uncommitted 409", async () => {
    const { app, tools, committed } = await buildApp();
    tools.activatePermissionProfile.mockImplementation(() => { throw new ConflictError({ code: "WRITE_CONFLICT",
      details: { reason: "PERMISSION_SELECTION_REVISION_CONFLICT" } }); });
    const response = await app.inject({ method: "POST", url: "/api/v1/tools/permission-profiles/activate", payload: {
      profileId: "profile-1", surface: "chat", expectedProfileRevision: reviewedRevision,
      expectedSelectionRevision: currentRevision, operatorId: "spoofed", createdBy: "spoofed",
    } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ details: { reason: "PERMISSION_SELECTION_REVISION_CONFLICT" } });
    expect(tools.activatePermissionProfile).toHaveBeenCalledExactlyOnceWith({ profileId: "profile-1", surface: "chat",
      expectedProfileRevision: reviewedRevision, expectedSelectionRevision: currentRevision, operatorId: "operator-test", createdBy: "operator-test" });
    expect(committed).toEqual([false]);
  });
});
