import { describe, it, expect } from "vitest";
import type { AgenticRunListItem } from "@goatcitadel/contracts";
import { toKanbanCard, toKanbanColumn, type KanbanColumnId } from "./kanban-card-model";

const now = () => Date.parse("2026-05-30T17:00:00.000Z");

const baseRun: AgenticRunListItem = {
  taskId: "t-1",
  runId: "run-1",
  boardId: "cowork:default",
  title: "Build feature",
  taskStatus: "in_progress",
  status: "running",
  surface: "cowork",
  contextMode: "fork",
  profileId: "researcher",
  updatedAt: "2026-05-30T16:55:00.000Z",
};

describe("kanban-card-model", () => {
  it("toKanbanCard surfaces run metadata, diagnostics, status, and age", () => {
    const card = toKanbanCard(
      {
        ...baseRun,
        diagnostics: [
          {
            signalId: "diag-1",
            code: "repeated_tool_result",
            severity: "critical",
            title: "Browser blocked",
            summary: "Host is not allowlisted.",
            createdAt: "2026-05-30T16:56:00.000Z",
          },
        ],
      },
      { now },
    );
    expect(card.column).toBe("running");
    expect(card.diagnosticSummary).toMatchObject({ critical: 1, warning: 0, info: 0 });
    expect(card.statusLabel).toBe("Running");
    expect(card.surfaceLabel).toBe("Cowork");
    expect(card.updatedDisplay).toBe("5m idle");
    expect(card.contextMode).toBe("fork");
    expect(card.profileId).toBe("researcher");
  });

  it("toKanbanCard marks old active run projections as stale attention items", () => {
    const card = toKanbanCard(
      {
        ...baseRun,
        updatedAt: "2026-05-30T15:00:00.000Z",
      },
      { now },
    );
    expect(card.column).toBe("needs_attention");
    expect(card.statusLabel).toBe("Stale");
    expect(card.stale).toBe(true);
    expect(card.attentionReason).toBe("No recent run update.");
  });

  it("toKanbanCard excludes resolved diagnostics from the summary", () => {
    const card = toKanbanCard(
      {
        ...baseRun,
        diagnostics: [
          {
            signalId: "diag-1",
            code: "stale_worker",
            severity: "warning",
            title: "Stale",
            summary: "Resolved already.",
            createdAt: "2026-05-30T16:30:00.000Z",
            resolvedAt: "2026-05-30T16:31:00.000Z",
          },
        ],
      },
      { now },
    );
    expect(card.diagnosticSummary).toEqual({ info: 0, warning: 0, critical: 0 });
    expect(card.unresolvedDiagnostics).toEqual([]);
  });

  it("toKanbanColumn assigns run statuses to truthful operator columns", () => {
    expect<KanbanColumnId>(toKanbanColumn("queued", "assigned")).toBe("queued");
    expect<KanbanColumnId>(toKanbanColumn("planning", "planning")).toBe("queued");
    expect<KanbanColumnId>(
      toKanbanColumn("running", "in_progress", {
        updatedAt: "2026-05-30T16:59:00.000Z",
        now,
      }),
    ).toBe("running");
    expect<KanbanColumnId>(toKanbanColumn("approval_required", "in_progress")).toBe("needs_attention");
    expect<KanbanColumnId>(toKanbanColumn("paused", "in_progress")).toBe("needs_attention");
    expect<KanbanColumnId>(toKanbanColumn("failed", "blocked")).toBe("needs_attention");
    expect<KanbanColumnId>(toKanbanColumn("cancelled", "blocked")).toBe("needs_attention");
    expect<KanbanColumnId>(toKanbanColumn("stopped_by_limit", "blocked")).toBe("needs_attention");
    expect<KanbanColumnId>(toKanbanColumn("completed", "done")).toBe("closed");
  });
});
