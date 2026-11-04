import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { expect, it, vi } from "vitest";
import {
  createCommunicationsDashboardService,
  INTERRUPTED_SEND_RELEASE_GRACE_MS,
} from "./communications-dashboard-service.js";
import { COMMUNICATIONS_MAIL_SEND_APPROVAL_KIND } from "./communications-approval-effect-service.js";

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, wait };
}

it.each(["linked", "persisted-before-link", "persisted-before-link-with-clock-return"] as const)(
  "rejects stale interrupted recovery after the new approval is %s",
  async (boundary) => {
    const directory = await mkdtemp(join(tmpdir(), "gc-mail-recovery-generation-"));
    const storage = createSqliteAsyncStorage(
      new Storage({ dbPath: ":memory:", transcriptsDir: join(directory, "transcripts"), auditDir: join(directory, "audit") }),
    );
    const oldFence = new Date("2026-06-05T12:00:00.000Z");
    const afterGrace = new Date(oldFence.getTime() + INTERRUPTED_SEND_RELEASE_GRACE_MS + 1_000);
    const service = createCommunicationsDashboardService({ mailDrafts: storage.mailDrafts, now: () => afterGrace });
    const firstLookup = gate(), secondLookup = gate(), approveResponse = gate();
    const snapshotsReady = gate();
    const pending: Promise<unknown>[] = [];
    function track<T>(promise: Promise<T>): Promise<T> {
      pending.push(promise.catch(() => undefined));
      return promise;
    }
    try {
      const draft = await storage.mailDrafts.create({
        draftId: "interrupted-mail",
        workspaceId: "workspace-test",
        accountId: "synthetic-account",
        to: ["review@example.test"],
        cc: [],
        bcc: [],
        subject: "Synthetic draft",
        bodyText: "No delivery is part of this test.",
        status: "approval_required",
        createdAt: oldFence.toISOString(),
        updatedAt: oldFence.toISOString(),
      });
      const findPersisted = (draftId: string) =>
        storage.approvals.listByKindAndPayloadString(COMMUNICATIONS_MAIL_SEND_APPROVAL_KIND, "draftId", draftId);
      const snapshotSizes: number[] = [];
      const audit = vi.fn(async (_event: Record<string, unknown>) => {});
      const recovery = (hold: ReturnType<typeof gate>) => ({
        findMailSendApprovals: async (draftId: string) => {
          const snapshot = await findPersisted(draftId);
          snapshotSizes.push(snapshot.length);
          if (snapshotSizes.length === 2) snapshotsReady.release();
          await hold.wait;
          return snapshot;
        },
        recordAudit: audit,
      });

      const first = track(service.releaseInterruptedDraft(draft.draftId, recovery(firstLookup)));
      const stale = track(service.releaseInterruptedDraft(draft.draftId, recovery(secondLookup)));
      const returnedBeforeLookup = (result: { outcome: string }) => {
        throw new Error(`Recovery returned ${result.outcome} before the barrier`);
      };
      await Promise.race([snapshotsReady.wait, first.then(returnedBeforeLookup), stale.then(returnedBeforeLookup)]);
      expect(snapshotSizes).toEqual([0, 0]);
      firstLookup.release();
      expect((await first).outcome).toBe("released");

      const holdLink = boundary !== "linked";
      const sender = createCommunicationsDashboardService({
        now: () => boundary === "persisted-before-link-with-clock-return" ? oldFence : afterGrace,
        mailDrafts: storage.mailDrafts,
        createApproval: async (input, onCreated) => {
          if (holdLink) {
            // Simulate legacy code that persisted the approval before linking the draft.
            const approval = await storage.approvals.create(input);
            await approveResponse.wait;
            await onCreated?.(approval);
            return approval;
          }
          return await storage.runImmediateTransaction(async () => {
            const approval = await storage.approvals.create(input);
            await onCreated?.(approval);
            return approval;
          });
        },
      });
      const send = track(sender.sendDraft(draft.draftId));
      await vi.waitFor(async () => expect(await findPersisted(draft.draftId)).toHaveLength(1));
      const [approval] = await findPersisted(draft.draftId);
      expect(approval?.status).toBe("pending");
      if (!holdLink) expect(await send).toMatchObject({ status: "approval_required", approvalId: approval?.approvalId });
      else {
        const unlinked = await storage.mailDrafts.get(draft.draftId);
        expect(unlinked.status).toBe("approval_required");
        expect(unlinked.approvalId).toBeUndefined();
      }

      secondLookup.release();
      const staleResult = await stale;
      approveResponse.release();
      await send;
      // Use the ordinary operator request again so the test detects a newly persisted approval B,
      // not merely the misleading "released" response. No approval is resolved and no sender exists here.
      const again = await sender.sendDraft(draft.draftId);
      expect({
        outcome: staleResult.outcome,
        nextStatus: again.status,
        nextApproval: again.approvalId,
        approvalIds: (await findPersisted(draft.draftId)).map((entry) => entry.approvalId),
        auditEvents: audit.mock.calls.map(([event]) => event.event),
      }).toEqual({
        outcome: "not_interrupted",
        nextStatus: "approval_required",
        nextApproval: approval?.approvalId,
        approvalIds: [approval?.approvalId],
        auditEvents: ["mail_draft_send_released"],
      });
    } finally {
      firstLookup.release();
      secondLookup.release();
      approveResponse.release();
      await Promise.allSettled(pending);
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
