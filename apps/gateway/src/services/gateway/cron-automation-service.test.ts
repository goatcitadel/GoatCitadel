import { describe, expect, it, vi } from "vitest";
import type { Storage } from "@goatcitadel/storage";
import { CronAutomationService } from "./cron-automation-service.js";

interface CronReviewRow {
  item_id: string;
  job_id: string;
  run_id: string;
  severity: "low" | "medium" | "high" | "critical";
  status: "open" | "resolved" | "retrying" | "ignored";
  summary_json: string;
  diff_json: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

class FakeDb {
  public review = new Map<string, CronReviewRow>();
  public diffs = new Map<string, { runId: string; previousRunId: string | null }>();
  public failDiffInsert = false;
  private snapshot: {
    review: Map<string, CronReviewRow>;
    diffs: Map<string, { runId: string; previousRunId: string | null }>;
  } | null = null;

  public exec(sql: string): void {
    if (sql.includes("BEGIN IMMEDIATE")) {
      this.snapshot = {
        review: new Map([...this.review.entries()].map(([id, row]) => [id, { ...row }])),
        diffs: new Map(this.diffs),
      };
      return;
    }
    if (sql.includes("COMMIT")) {
      this.snapshot = null;
      return;
    }
    if (sql.includes("ROLLBACK")) {
      if (this.snapshot) {
        this.review = new Map(this.snapshot.review);
        this.diffs = new Map(this.snapshot.diffs);
      }
      this.snapshot = null;
    }
  }

  public prepare(sql: string): { get: (arg?: unknown) => unknown; run: (arg?: unknown) => unknown } {
    if (sql.includes("FROM cron_review_items") && sql.includes("WHERE item_id = ?")) {
      return {
        get: (itemId?: unknown) => (typeof itemId === "string" ? this.review.get(itemId) : undefined),
        run: () => undefined,
      };
    }

    if (sql.includes("UPDATE cron_review_items")) {
      return {
        get: () => undefined,
        run: (params?: unknown) => {
          const payload = params as { itemId: string; runId: string; updatedAt: string };
          const current = this.review.get(payload.itemId);
          if (!current) {
            return undefined;
          }
          this.review.set(payload.itemId, {
            ...current,
            status: "retrying",
            run_id: payload.runId,
            updated_at: payload.updatedAt,
            resolved_at: null,
          });
          return undefined;
        },
      };
    }

    if (sql.includes("INSERT INTO cron_run_diffs")) {
      return {
        get: () => undefined,
        run: (params?: unknown) => {
          if (this.failDiffInsert) {
            throw new Error("cron_run_diffs unavailable");
          }
          const payload = params as {
            runId: string;
            previousRunId: string | null;
          };
          this.diffs.set(payload.runId, {
            runId: payload.runId,
            previousRunId: payload.previousRunId,
          });
          return undefined;
        },
      };
    }

    return {
      get: () => undefined,
      run: () => undefined,
    };
  }
}

function createService(db: FakeDb, publishRealtime = vi.fn()): CronAutomationService {
  return new CronAutomationService({
    storage: { db } as unknown as Storage,
    persistCronJobsConfig: () => {},
    publishRealtime,
    requireFeatureEnabled: () => {},
    isFeatureEnabled: () => true,
    runHandlers: {
      task: async () => ({ taskId: "task-1" }),
      improvement: async () => {},
      backup: async () => {},
      memoryFlush: async () => {},
      costReport: async () => {},
      updateReview: async () => {},
    },
  });
}

describe("CronAutomationService.retryCronReviewQueueItem", () => {
  it("rolls back review-item update when diff insert fails", () => {
    const db = new FakeDb();
    db.review.set("item-1", {
      item_id: "item-1",
      job_id: "job-1",
      run_id: "run-old",
      severity: "low",
      status: "open",
      summary_json: JSON.stringify({ trigger: "test" }),
      diff_json: null,
      created_at: "2026-03-05T00:00:00.000Z",
      updated_at: "2026-03-05T00:00:00.000Z",
      resolved_at: null,
    });
    db.failDiffInsert = true;

    const service = createService(db);
    expect(() => service.retryCronReviewQueueItem("item-1")).toThrow("cron_run_diffs unavailable");

    const row = db.review.get("item-1");
    expect(row?.status).toBe("open");
    expect(row?.run_id).toBe("run-old");
  });

  it("updates item and publishes retry event on success", () => {
    const db = new FakeDb();
    const publishRealtime = vi.fn();
    db.review.set("item-2", {
      item_id: "item-2",
      job_id: "job-2",
      run_id: "run-prev",
      severity: "medium",
      status: "open",
      summary_json: JSON.stringify({ trigger: "test" }),
      diff_json: null,
      created_at: "2026-03-05T00:00:00.000Z",
      updated_at: "2026-03-05T00:00:00.000Z",
      resolved_at: null,
    });

    const service = createService(db, publishRealtime);
    const updated = service.retryCronReviewQueueItem("item-2");

    expect(updated.itemId).toBe("item-2");
    expect(updated.status).toBe("retrying");
    expect(updated.runId).not.toBe("run-prev");
    expect(db.diffs.get(updated.runId)?.previousRunId).toBe("run-prev");
    expect(publishRealtime).toHaveBeenCalledWith(
      "system",
      "cron",
      expect.objectContaining({
        type: "cron_review_item_retried",
        itemId: "item-2",
        runId: updated.runId,
      }),
    );
  });
});
