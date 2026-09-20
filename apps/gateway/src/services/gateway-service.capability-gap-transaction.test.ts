import { describe, expect, it, vi } from "vitest";
import type { ChatTurnTraceRecord } from "@goatcitadel/contracts";
import { GatewayService } from "./gateway-service.js";

describe("Chat approval finalization diagnostic isolation", () => {
  it.each(["recordCapabilityGapEvent", "recordFocusedToolFailureSignal"])(
    "can commit the waiting turn after %s aborts a PostgreSQL statement",
    async (failingOperation) => {
      // PostgreSQL rejects every following statement until the failed
      // savepoint/transaction is rolled back. A catch alone cannot recover it.
      let aborted = false;
      const storage = {
        runImmediateTransaction: async <T>(work: () => Promise<T>): Promise<T> => {
          if (aborted) throw new Error("current transaction is aborted");
          const prior = aborted;
          try {
            return await work();
          } catch (error) {
            aborted = prior;
            throw error;
          }
        },
      };
      const improvementService = {
        recordCapabilityGapEvent: vi.fn(async () => undefined),
        recordFocusedToolFailureSignal: vi.fn(async () => undefined),
      };
      improvementService[failingOperation as keyof typeof improvementService].mockImplementation(async () => {
        aborted = true;
        throw new Error("diagnostic SQL failed");
      });
      const host = {
        storage,
        improvementService,
        isReplayScratchSession: async () => false,
        config: { assistant: { defaultToolProfile: "safe" }, toolPolicy: { tools: { profile: "safe" } } },
      } as unknown as GatewayService;
      const trace = {
        status: "waiting_for_approval",
        routing: {},
        failure: { failureClass: "approval_required" },
        toolRuns: [{ toolName: "documents.create", status: "approval_required" }],
      } as ChatTurnTraceRecord;
      await storage.runImmediateTransaction(async () => {
        await GatewayService.prototype.recordCapabilityGapFromTrace.call(host, {
          sessionId: "session-test",
          turnId: "turn-test",
          content: "Create a test document.",
          trace,
        });
        expect(aborted, "the enclosing waiting-state transaction must remain usable").toBe(false);
      });
      expect(improvementService[failingOperation as keyof typeof improvementService]).toHaveBeenCalledOnce();
    },
  );
});
