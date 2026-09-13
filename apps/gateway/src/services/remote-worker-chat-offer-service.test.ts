import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { Storage, createSqliteAsyncStorage } from "@goatcitadel/storage";
import { prepareChatOfferFixture } from "../../../../packages/storage/src/remote-worker-chat-offer-fixture.js";
import {
  RemoteWorkerChatOfferService,
  type RemoteWorkerChatOfferDependencies,
} from "./remote-worker-chat-offer-service.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "goat-chat-offer-"));
  const storage = new Storage({
    dbPath: join(root, "gateway.sqlite"),
    transcriptsDir: join(root, "transcripts"),
    auditDir: join(root, "audit"),
  });
  cleanups.push(() => {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const prepared = prepareChatOfferFixture(storage.db, true);
  const run = storage.durableRuns.getRun(prepared.durableRunId);
  const dependencies: RemoteWorkerChatOfferDependencies = {
    storage: createSqliteAsyncStorage(storage),
    enabled: true,
    registryWorkspaceId: "default",
    pathJailSha256: prepared.offerInput.pathJailSha256,
    listCallableCapabilities: async () => [],
    resolvePolicyContext: async () => ({ permissionProfileId: "safe" }),
  };
  const count = () =>
    Number(
      storage.db.prepare("SELECT COUNT(*) AS count FROM remote_worker_assignments").get<{ count: number }>()!.count,
    );
  return { storage, run, dependencies, count };
}

describe("canonical Chat offer scheduling", () => {
  it("creates one bounded offer from the original admission and exactly replays it", async () => {
    const { run, dependencies, count } = fixture();
    const service = new RemoteWorkerChatOfferService(dependencies);
    const created = await service.schedule(run);
    expect(created.disposition).toBe("created");
    expect(created.assignment.manifest).toMatchObject({
      durableRunId: run.runId,
      executionWorkspaceId: "default",
      sessionId: "session-connected-worker",
      turnId: "turn-connected-worker",
      taskId: "task-connected-worker",
      deadlineAt: new Date(Date.parse(run.createdAt) + 30 * 60_000).toISOString(),
      requiredCapabilityClasses: ["artifact_stage", "durable_compute", "gateway_inference"],
      leaseTtlSeconds: 60,
      maxOutputBytes: 1_048_576,
    });
    expect(await service.schedule(run)).toEqual({ disposition: "replayed", assignment: created.assignment });
    expect(count()).toBe(1);
  });

  it("rejects disabled operation and stale durable claims before creating an offer", async () => {
    const { run, dependencies, count } = fixture();
    await expect(new RemoteWorkerChatOfferService({ ...dependencies, enabled: false }).schedule(run)).rejects.toThrow(
      "not activated",
    );
    const service = new RemoteWorkerChatOfferService(dependencies);
    await expect(service.schedule({ ...run, version: run.version + 1 })).rejects.toThrow("current durable Chat claim");
    await expect(service.schedule({ ...run, leaseOwnerId: "another-owner" })).rejects.toThrow(
      "current durable Chat claim",
    );
    expect(count()).toBe(0);
  });

  it("rejects changed permission authority without publishing work", async () => {
    const { run, dependencies, count } = fixture();
    await expect(
      new RemoteWorkerChatOfferService({
        ...dependencies,
        resolvePolicyContext: async () => ({ permissionProfileId: "trusted_local_power" }),
      }).schedule(run),
    ).rejects.toThrow("permission authority changed");
    expect(count()).toBe(0);
  });

  it("rechecks the claim atomically after asynchronous capability and policy preflight", async () => {
    const { run, storage, dependencies, count } = fixture();
    await expect(
      new RemoteWorkerChatOfferService({
        ...dependencies,
        resolvePolicyContext: async () => {
          storage.db.prepare("UPDATE durable_runs SET lease_owner_id = ? WHERE run_id = ?").run("new-owner", run.runId);
          return { permissionProfileId: "safe" };
        },
      }).schedule(run),
    ).rejects.toThrow("execution claim");
    expect(count()).toBe(0);
  });
});
