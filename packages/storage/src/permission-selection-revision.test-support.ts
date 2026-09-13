import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import type { PermissionProfileSelectionReviewInput } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { PermissionProfileRepository } from "./permission-profile-repo.js";
import { createPermissionProfileSelectionSchema, PERMISSION_PROFILE_SELECTION_POSTGRES_SQL } from "./permission-profile-selection-schema.js";

export const selectionProfileInput = (label: string) => ({ label, scope: "workspace" as const, scopeRef: "selection-workspace",
  approvalMode: "approve_all" as const, toolPatterns: ["session.status"], deny: ["shell.exec"], createdBy: "reviewer" });
export const activationReviewInput = (profileId: string): PermissionProfileSelectionReviewInput => ({ operation: "activate", profileId,
  workspaceId: "selection-workspace", surface: "chat", createdBy: "reviewer" });
const selectionConflict = (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "WRITE_CONFLICT");

export function verifyPermissionSelectionRevisions(db: DatabaseClient): void {
  const repo = new PermissionProfileRepository(db);
  const a = repo.createProfile(selectionProfileInput("Profile A"));
  const b = repo.createProfile(selectionProfileInput("Profile B"));
  const review = (id: string) => repo.reviewSelection(activationReviewInput(id));
  const first = review(a.profileId);
  assert.equal(first.activeProfiles.length, 0);
  if (db.dialect === "sqlite") createPermissionProfileSelectionSchema(db);
  else db.exec(PERMISSION_PROFILE_SELECTION_POSTGRES_SQL);
  assert.equal(review(a.profileId).revision, first.revision, "reapplying the additive schema cannot reset the review generation");
  const second = review(b.profileId);
  const apply = (id: string, expectedSelectionRevision: string, expectedProfileRevision: string) => repo.activateReviewedProfile({
    profileId: id, workspaceId: "selection-workspace", surface: "chat", createdBy: "reviewer", expectedSelectionRevision, expectedProfileRevision,
  });
  assert.throws(() => apply(a.profileId, undefined as never, a.revision), /expected selection revision/);
  assert.throws(() => apply(b.profileId, first.revision, b.revision), selectionConflict);
  assert.throws(() => repo.activateReviewedProfile({ profileId: a.profileId, workspaceId: "selection-workspace", surface: "tools",
    createdBy: "reviewer", expectedProfileRevision: a.revision, expectedSelectionRevision: first.revision }), selectionConflict);
  assert.throws(() => repo.activateReviewedProfile({ profileId: a.profileId, workspaceId: "selection-workspace", surface: "chat",
    createdBy: "another-reviewer", expectedProfileRevision: a.revision, expectedSelectionRevision: first.revision }), selectionConflict);
  apply(a.profileId, first.revision, a.revision);
  assert.throws(() => apply(b.profileId, second.revision, b.revision), selectionConflict);
  assert.equal(review(b.profileId).activeProfiles[0]?.profile.profileId, a.profileId);
  apply(b.profileId, review(b.profileId).revision, b.revision);
  apply(a.profileId, review(a.profileId).revision, a.revision);
  repo.deactivateProfileActivations({ profileId: a.profileId, workspaceId: "selection-workspace" });
  assert.equal(review(a.profileId).activeProfiles.length, 0);
  assert.notEqual(review(a.profileId).revision, first.revision, "empty selection after an ABA sequence must not reuse its old review");
  assert.throws(() => apply(a.profileId, first.revision, a.revision), selectionConflict);

  const createInput = { ...selectionProfileInput("Reviewed defaults"), defaultForSurfaces: ["chat", "tools"] as const };
  const createRequest: PermissionProfileSelectionReviewInput = { operation: "defaults", scope: "workspace", scopeRef: "selection-workspace",
    defaultForSurfaces: [...createInput.defaultForSurfaces], createdBy: "reviewer" };
  const beforeCreateCount = repo.listProfiles().length;
  assert.throws(() => repo.createProfileWithDefaults({ ...createInput, defaultForSurfaces: [...createInput.defaultForSurfaces] }), /expected selection revision/);
  assert.equal(repo.listProfiles().length, beforeCreateCount);
  const staleCreateReview = repo.reviewSelection(createRequest);
  apply(a.profileId, review(a.profileId).revision, a.revision);
  assert.throws(() => repo.createProfileWithDefaults({ ...createInput, defaultForSurfaces: [...createInput.defaultForSurfaces],
    expectedSelectionRevision: staleCreateReview.revision }), selectionConflict);
  assert.equal(repo.listProfiles().length, beforeCreateCount, "failed default creation cannot leave a profile behind");
  const created = repo.createProfileWithDefaults({ ...createInput, defaultForSurfaces: [...createInput.defaultForSurfaces],
    expectedSelectionRevision: repo.reviewSelection(createRequest).revision });
  assert.equal(repo.resolveContext({ workspaceId: "selection-workspace", surface: "chat" }).permissionProfile.profileId, created.profileId);
  apply(b.profileId, review(b.profileId).revision, b.revision);
  const edited = repo.updateProfileWithDefaults(created.profileId, { expectedRevision: created.revision,
    updatedBy: "reviewer", label: "Only the label changed", defaultForSurfaces: ["tools", "chat"] });
  assert.equal(repo.resolveContext({ workspaceId: "selection-workspace", surface: "chat" }).permissionProfile.profileId, b.profileId,
    "an ordinary edit cannot reassert the profile's stored defaults");
  const updateRequest: PermissionProfileSelectionReviewInput = { operation: "defaults", profileId: created.profileId,
    defaultForSurfaces: ["mcp"], createdBy: "reviewer" };
  assert.throws(() => repo.updateProfileWithDefaults(created.profileId, { expectedRevision: edited.revision,
    updatedBy: "reviewer", defaultForSurfaces: ["mcp"] }), /expected selection revision/);
  assert.deepEqual(repo.getProfile(created.profileId), edited);
  const staleUpdateReview = repo.reviewSelection(updateRequest);
  apply(a.profileId, review(a.profileId).revision, a.revision);
  assert.throws(() => repo.updateProfileWithDefaults(created.profileId, { expectedRevision: edited.revision,
    updatedBy: "reviewer", defaultForSurfaces: ["mcp"], expectedSelectionRevision: staleUpdateReview.revision }), selectionConflict);
  assert.deepEqual(repo.getProfile(created.profileId), edited);
  const beforeRollback = repo.reviewSelection(updateRequest);
  assert.throws(() => db.transaction("immediate", () => {
    repo.updateProfileWithDefaults(created.profileId, { expectedRevision: edited.revision, updatedBy: "reviewer",
      defaultForSurfaces: ["mcp"], expectedSelectionRevision: beforeRollback.revision });
    throw new Error("rollback the whole default selection");
  }), /rollback the whole default selection/);
  assert.deepEqual(repo.getProfile(created.profileId), edited);
  assert.deepEqual(repo.reviewSelection(updateRequest), beforeRollback);
  repo.archiveProfile(a.profileId, a.revision);
  assert.throws(() => review(a.profileId), selectionConflict);

  // Both callers own disposable test databases. Reconstruct the pre-addition
  // shape while preserving the existing profile and activation tables verbatim.
  const profileRows = () => db.prepare("SELECT * FROM permission_profiles ORDER BY profile_id").all();
  const activationRows = () => db.prepare("SELECT * FROM permission_profile_activations ORDER BY activation_id").all();
  const beforeProfiles = profileRows();
  const beforeActivations = activationRows();
  assert.ok(beforeActivations.length > 0);
  db.exec("DROP TABLE permission_profile_selection_state");
  if (db.dialect === "sqlite") createPermissionProfileSelectionSchema(db);
  else db.exec(PERMISSION_PROFILE_SELECTION_POSTGRES_SQL);
  assert.deepEqual(profileRows(), beforeProfiles, "initial selection schema leaves existing profiles unchanged");
  assert.deepEqual(activationRows(), beforeActivations, "initial selection schema leaves existing activation history unchanged");
  const afterUpgrade = review(b.profileId);
  if (db.dialect === "sqlite") createPermissionProfileSelectionSchema(db);
  else db.exec(PERMISSION_PROFILE_SELECTION_POSTGRES_SQL);
  assert.deepEqual(review(b.profileId), afterUpgrade, "reapplication preserves the initialized generation and active selections");
}

export interface SelectionRaceWriter {
  request: PermissionProfileSelectionReviewInput;
  expectedSelectionRevision: string;
  expectedProfileRevision?: string;
  kind: "activate" | "create" | "update";
  profileId?: string;
  label?: string;
}

export async function verifyPermissionSelectionRaces(db: DatabaseClient, kind: "sqlite" | "postgres", workerOptions: Record<string, unknown>): Promise<void> {
  const repo = new PermissionProfileRepository(db);
  for (const competitor of ["activate", "create", "update"] as const) {
    const workspaceId = `selection-race-${competitor}`;
    const a = repo.createProfile({ ...selectionProfileInput("Race A"), scopeRef: workspaceId });
    const b = repo.createProfile({ ...selectionProfileInput("Race B"), scopeRef: workspaceId });
    const firstRequest: PermissionProfileSelectionReviewInput = { operation: "activate", profileId: a.profileId,
      workspaceId, surface: "chat", createdBy: "reviewer" };
    const firstReview = repo.reviewSelection(firstRequest);
    assert.equal(firstReview.activeProfiles.length, 0);
    const secondRequest: PermissionProfileSelectionReviewInput = competitor === "activate"
      ? { ...firstRequest, profileId: b.profileId }
      : competitor === "create"
        ? { operation: "defaults", scope: "workspace", scopeRef: workspaceId, defaultForSurfaces: ["chat"], createdBy: "reviewer" }
        : { operation: "defaults", profileId: b.profileId, defaultForSurfaces: ["chat"], createdBy: "reviewer" };
    const results = await racePermissionSelections({ kind, workerOptions, writers: [
      { kind: "activate", request: firstRequest, profileId: a.profileId, expectedProfileRevision: a.revision, expectedSelectionRevision: firstReview.revision },
      { kind: competitor, request: secondRequest, profileId: b.profileId, label: "Race created default", expectedProfileRevision: b.revision,
        expectedSelectionRevision: repo.reviewSelection(secondRequest).revision },
    ] });
    assert.deepEqual(results.map((result) => result.outcome).sort(), ["conflict", "saved"]);
    const winner = results.find((result) => result.outcome === "saved")!;
    assert.equal(repo.resolveContext({ workspaceId, surface: "chat" }).permissionProfile.profileId, winner.profileId);
    assert.equal(repo.reviewSelection(firstRequest).activeProfiles.length, 1, "competing inserts cannot leave two active defaults");
  }
}

export async function racePermissionSelections(input: {
  kind: "sqlite" | "postgres"; workerOptions: Record<string, unknown>; writers: SelectionRaceWriter[];
}): Promise<Array<{ outcome: string; kind: string; profileId: string }>> {
  const startGate = new SharedArrayBuffer(4);
  const extension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const workers = input.writers.map((writer) => new Worker(SELECTION_WORKER, { eval: true, workerData: { ...input, writer, startGate,
    tsxApiUrl: import.meta.resolve("tsx/esm/api"), repoUrl: new URL(`./permission-profile-repo${extension}`, import.meta.url).href,
    sqliteUrl: new URL(`./sqlite${extension}`, import.meta.url).href, postgresUrl: new URL(`./postgres/sync${extension}`, import.meta.url).href,
  } }));
  const completions = workers.map((worker) => {
    let readyResolve!: () => void; let readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const done = new Promise<{ outcome: string; kind: string; profileId: string }>((resolve, reject) => {
      let completed = false;
      const fail = (error: Error) => { readyReject(error); reject(error); };
      worker.on("message", (message) => {
        if (message.type === "ready") readyResolve();
        if (message.type === "done") { completed = true; resolve(message.result); }
        if (message.type === "error") fail(new Error(message.error));
      });
      worker.on("error", fail);
      worker.on("exit", (code) => { if (!completed) fail(new Error(`Selection test worker exited without a result (${code})`)); });
    });
    void done.catch(() => undefined);
    return { ready, done };
  });
  const deadline = setTimeout(() => { for (const worker of workers) void worker.terminate(); }, 45_000);
  try {
    await Promise.all(completions.map((completion) => completion.ready));
    Atomics.store(new Int32Array(startGate), 0, 1); Atomics.notify(new Int32Array(startGate), 0);
    return await Promise.all(completions.map((completion) => completion.done));
  } finally { clearTimeout(deadline); await Promise.allSettled(workers.map((worker) => worker.terminate())); }
}

const SELECTION_WORKER = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
void (async () => {
  const { tsImport } = await import(workerData.tsxApiUrl);
  const { PermissionProfileRepository } = await tsImport(workerData.repoUrl, workerData.repoUrl);
  const db = workerData.kind === "sqlite"
    ? (await tsImport(workerData.sqliteUrl, workerData.repoUrl)).createDatabase(workerData.workerOptions)
    : new (await tsImport(workerData.postgresUrl, workerData.repoUrl)).PostgresSyncDatabaseClient(workerData.workerOptions);
  let result;
  try {
    const repo = new PermissionProfileRepository(db); const writer = workerData.writer;
    if (repo.reviewSelection(writer.request).revision !== writer.expectedSelectionRevision) throw new Error("Writers did not observe the same selection state");
    parentPort.postMessage({ type: "ready" });
    Atomics.wait(new Int32Array(workerData.startGate), 0, 0, 40_000);
    let outcome = "saved"; let profileId = writer.profileId ?? "";
    try {
      if (writer.kind === "activate") repo.activateReviewedProfile({ ...writer.request, expectedProfileRevision: writer.expectedProfileRevision,
        expectedSelectionRevision: writer.expectedSelectionRevision });
      else if (writer.kind === "update") repo.updateProfileWithDefaults(writer.profileId, { defaultForSurfaces: writer.request.defaultForSurfaces,
        expectedRevision: writer.expectedProfileRevision, expectedSelectionRevision: writer.expectedSelectionRevision, updatedBy: writer.request.createdBy });
      else profileId = repo.createProfileWithDefaults({ label: writer.label, scope: writer.request.scope, scopeRef: writer.request.scopeRef,
        approvalMode: "approve_all", toolPatterns: ["session.status"], deny: ["shell.exec"], defaultForSurfaces: writer.request.defaultForSurfaces,
        expectedSelectionRevision: writer.expectedSelectionRevision, createdBy: writer.request.createdBy }).profileId;
    } catch (error) { if (error.code !== "WRITE_CONFLICT") throw error; outcome = "conflict"; }
    result = { outcome, kind: writer.kind, profileId };
  } finally { db.close(); }
  parentPort.postMessage({ type: "done", result });
})().catch((error) => { parentPort.postMessage({ type: "error", error: String(error.stack ?? error) }); process.exitCode = 1; });
`;
