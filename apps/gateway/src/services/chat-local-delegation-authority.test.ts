import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { readDurableChatTurnExecutionPayloadAuthority } from "@goatcitadel/contracts";
import { assertLocalDelegationTurnAuthority } from "./chat-local-delegation-authority.js";
import { seedLocalDelegationAuthority } from "../../test/fixtures/local-delegation.js";

describe("canonical local delegation authority", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-local-authority-"));
  const raw = new Storage({
    dbPath: path.join(root, "gateway.db"),
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  const storage = createSqliteAsyncStorage(raw);
  let fixture: Awaited<ReturnType<typeof seedLocalDelegationAuthority>>;
  beforeAll(async () => {
    fixture = await seedLocalDelegationAuthority(storage);
  });
  afterAll(() => {
    raw.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("accepts an actual canonical request claim without manufacturing a profile", async () => {
    await expect(assertLocalDelegationTurnAuthority(storage, fixture.input)).resolves.toBeUndefined();
    expect(raw.chatTurnCapabilityProfiles.findByTurn(fixture.input.turnId)).toBeUndefined();
    expect(raw.chatDelegationSteps.get("local-step").durableRunId).toBeUndefined();
  });

  it.each([
    "session",
    "turn",
    "user-message",
    "assistant-message",
    "request-actor",
    "policy-task",
    "material",
    "no-claim",
  ])("rejects %s mismatch before any durable child exists", async (kind) => {
    const input = structuredClone(fixture.input);
    if (kind === "session") input.sessionId = "foreign";
    if (kind === "turn") input.turnId = "foreign";
    if (kind === "user-message") input.userMessageId = "foreign";
    if (kind === "assistant-message") input.assistantMessageId = "foreign";
    if (kind === "request-actor") input.request.authActorId = "foreign";
    if (kind === "policy-task") input.request.policyTaskId = "foreign";
    if (kind === "material") input.admission!.admittedRequest.content = "different";
    if (kind === "no-claim") input.admission!.requestClaim = undefined;
    await expect(assertLocalDelegationTurnAuthority(storage, input)).rejects.toThrow("Local delegated Chat requires");
    expect(raw.durableRuns.listRuns()).toHaveLength(1);
  });

  const rollback = new Error("restore fixture");
  async function changed(change: () => Promise<unknown>, run: () => Promise<void>) {
    await expect(
      storage.runImmediateTransaction(async () => {
        await change();
        await run();
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  }
  it.each(["automatic", "wrong-step", "parent-cancelled", "parent-archived", "dispatch-expired", "child-turn-drift"])(
    "rejects current canonical %s drift",
    async (kind) => {
      await changed(
        async () => {
          if (kind === "automatic")
            await storage.chatDelegationRuns.patch("local-delegation", { workflowTemplate: "auto_fanout" });
          if (kind === "wrong-step")
            await storage.chatDelegationSteps.patch("local-step", { childSessionId: "foreign" });
          if (kind === "parent-cancelled")
            await storage.durableRuns.updateRun({ runId: "local-parent-run", status: "cancelled" });
          if (kind === "parent-archived")
            await storage.chatSessionMeta.patch("local-parent-session", { lifecycleStatus: "archived" });
          if (kind === "dispatch-expired") {
            const expired = await storage.chatDelegationSteps.reclaimLinkedDispatch(
              "local-step",
              fixture.input.sessionId,
              fixture.dispatchToken,
              fixture.dispatchToken,
              "2000-01-01T00:00:00.000Z",
              new Date().toISOString(),
            );
            expect(expired).toBeDefined();
          }
          if (kind === "child-turn-drift")
            await storage.chatDelegationSteps.patch("local-step", { childTurnId: "foreign" });
        },
        async () => {
          await expect(assertLocalDelegationTurnAuthority(storage, fixture.input)).rejects.toThrow();
        },
      );
    },
  );

  it("does not accept a hash-valid generic durable row without its actual Chat admission binding", async () => {
    await changed(
      async () => {
        const parent = await storage.durableRuns.getRun("local-parent-run");
        const payload = { ...parent.payload, admissionId: "missing-admission" };
        expect(
          readDurableChatTurnExecutionPayloadAuthority({
            workflowKey: parent.workflowKey,
            durableRunId: parent.runId,
            payload,
          }),
        ).toBeTruthy();
        await storage.durableRuns.updateRun({ runId: parent.runId, status: parent.status, payload });
      },
      async () => {
        await expect(assertLocalDelegationTurnAuthority(storage, fixture.input)).rejects.toThrow();
      },
    );
  });

  it("rejects a different operator adopting the parent even when its own input actor is internally consistent", async () => {
    const input = structuredClone(fixture.input);
    input.request.operatorId = "other-operator";
    input.request.authActorId = "other-operator";
    input.admission!.requestActor = {
      ...input.admission!.requestActor,
      actorId: "other-operator",
      operatorId: "other-operator",
      authActorId: "other-operator",
    };
    await expect(assertLocalDelegationTurnAuthority(storage, input)).rejects.toThrow("Local delegated Chat requires");
    expect(raw.durableRuns.listRuns()).toHaveLength(1);
  });

  it("requires exact canonical replay binding and permits attention detach without redispatch", async () => {
    const admission = await fixture.admitChild();
    const input = { ...fixture.input, admission };
    await expect(assertLocalDelegationTurnAuthority(storage, input)).resolves.toBeUndefined();
    await storage.durableChildWatchers.detach("delegation-child:local-step");
    await expect(assertLocalDelegationTurnAuthority(storage, input)).resolves.toBeUndefined();
    for (const mutation of [
      { leaseOwnerId: "other" },
      { attemptCount: admission.durableClaim!.attemptCount + 1 },
      { durableRunId: "other" },
    ]) {
      await expect(
        assertLocalDelegationTurnAuthority(storage, {
          ...input,
          admission: { ...admission, durableClaim: { ...admission.durableClaim!, ...mutation } },
        }),
      ).rejects.toThrow();
    }
    await changed(
      () => storage.chatDelegationSteps.patch("local-step", { durableRunId: "other" }),
      async () => {
        await expect(assertLocalDelegationTurnAuthority(storage, input)).rejects.toThrow();
      },
    );
    expect(raw.durableRuns.listRuns()).toHaveLength(2);
    expect(raw.chatTurnCapabilityProfiles.findByTurn(input.turnId)).toBeUndefined();
  });
});
