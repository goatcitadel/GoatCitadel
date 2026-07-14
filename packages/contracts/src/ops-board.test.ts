import { describe, expect, it } from "vitest";
import {
  OPS_SAVED_BOARD_SCHEMA_VERSION,
  OPS_SAVED_BOARD_WIDGET_KINDS,
  assertOpsSavedBoardRecord,
  normalizeOpsSavedBoardCreateInput,
  normalizeOpsSavedBoardPlacements,
  normalizeOpsSavedBoardStatusInput,
  normalizeOpsSavedBoardUpdateInput,
  type OpsSavedBoardRecord,
} from "./ops-board.js";

const NOW = "2026-07-14T12:00:00.000Z";
const SHA = "a".repeat(64);

function placement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    widgetId: "widget-1",
    kind: "runtime_truth_summary",
    x: 0,
    y: 0,
    width: 6,
    height: 4,
    ...overrides,
  };
}

function record(overrides: Partial<OpsSavedBoardRecord> = {}): OpsSavedBoardRecord {
  return {
    schemaVersion: OPS_SAVED_BOARD_SCHEMA_VERSION,
    boardId: "board-1",
    workspaceId: "workspace-1",
    name: "Operations",
    status: "active",
    placements: [placement() as unknown as OpsSavedBoardRecord["placements"][number]],
    revision: 1,
    createdByActorId: "operator-1",
    createdAt: NOW,
    updatedByActorId: "operator-1",
    updatedAt: NOW,
    idempotencyKey: "create-board-1",
    requestSha256: SHA,
    ...overrides,
  };
}

describe("trusted ops saved board contracts", () => {
  it("freezes exactly five compiled widget kinds", () => {
    expect(OPS_SAVED_BOARD_WIDGET_KINDS).toEqual([
      "agentic_run_kanban",
      "approval_queue_summary",
      "runtime_truth_summary",
      "task_status_summary",
      "usage_cost_summary",
    ]);
  });

  it("normalizes NFKC text while keeping actor fields out of create and update bodies", () => {
    expect(
      normalizeOpsSavedBoardCreateInput({
        workspaceId: "workspace-1",
        name: "  Ｏps  ",
        description: "  trusted summaries  ",
        placements: [placement()],
        idempotencyKey: "create-board-1",
      }),
    ).toMatchObject({ name: "Ops", description: "trusted summaries" });
    expect(() =>
      normalizeOpsSavedBoardCreateInput({
        workspaceId: "workspace-1",
        name: "Ops",
        placements: [placement()],
        idempotencyKey: "create-board-1",
        createdByActorId: "spoofed",
      }),
    ).toThrow(/unknown or missing keys/);
    expect(() =>
      normalizeOpsSavedBoardUpdateInput({
        workspaceId: "workspace-1",
        name: "Ops 2",
        expectedRevision: 1,
        updatedByActorId: "spoofed",
      }),
    ).toThrow(/unknown or missing keys/);
    expect(() =>
      normalizeOpsSavedBoardUpdateInput({
        workspaceId: "workspace-1",
        name: undefined,
        expectedRevision: 1,
      }),
    ).toThrow(/name must be plain text/);
  });

  it("rejects executable or generic widget bytes through exact-key placement validation", () => {
    for (const invalid of [
      placement({ kind: "custom_component" }),
      placement({ url: "https://example.test/widget" }),
      placement({ html: "<script>alert(1)</script>" }),
      placement({ markdown: "[run](javascript:alert(1))" }),
      placement({ props: { query: "SELECT *" } }),
    ]) {
      expect(() => normalizeOpsSavedBoardPlacements([invalid])).toThrow();
    }
  });

  it("enforces unique widget IDs and every frozen grid bound", () => {
    expect(() => normalizeOpsSavedBoardPlacements([])).toThrow(/between 1 and 12/);
    expect(() =>
      normalizeOpsSavedBoardPlacements(Array.from({ length: 13 }, (_, index) => placement({ widgetId: `w-${index}` }))),
    ).toThrow(/between 1 and 12/);
    expect(() => normalizeOpsSavedBoardPlacements([placement(), placement()])).toThrow(/duplicated/);
    for (const invalid of [
      placement({ x: -1 }),
      placement({ x: 12 }),
      placement({ y: -1 }),
      placement({ y: 256 }),
      placement({ width: 0 }),
      placement({ width: 13 }),
      placement({ height: 0 }),
      placement({ height: 13 }),
      placement({ x: 6, width: 7 }),
      placement({ x: 0.5 }),
    ]) {
      expect(() => normalizeOpsSavedBoardPlacements([invalid])).toThrow();
    }
  });

  it("rejects oversized or controlled text and malformed request guards", () => {
    expect(() =>
      normalizeOpsSavedBoardCreateInput({
        workspaceId: "workspace-1",
        name: "x".repeat(121),
        placements: [placement()],
        idempotencyKey: "create-board-1",
      }),
    ).toThrow(/oversized/);
    expect(() =>
      normalizeOpsSavedBoardCreateInput({
        workspaceId: "workspace-1",
        name: "Ops\u0000Board",
        placements: [placement()],
        idempotencyKey: "create-board-1",
      }),
    ).toThrow(/control/);
    expect(() => normalizeOpsSavedBoardUpdateInput({ workspaceId: "workspace-1", expectedRevision: 1 })).toThrow(
      /mutable field/,
    );
    expect(() => normalizeOpsSavedBoardStatusInput({ workspaceId: "workspace-1", expectedRevision: 0 })).toThrow(
      /positive safe integer/,
    );
  });

  it("validates complete active and archived records and fails closed on unknown bytes", () => {
    expect(() => assertOpsSavedBoardRecord(record())).not.toThrow();
    expect(() =>
      assertOpsSavedBoardRecord(
        record({
          status: "archived",
          revision: 2,
          updatedByActorId: "operator-2",
          updatedAt: "2026-07-14T12:01:00.000Z",
          archivedByActorId: "operator-2",
          archivedAt: "2026-07-14T12:01:00.000Z",
        }),
      ),
    ).not.toThrow();
    expect(() => assertOpsSavedBoardRecord({ ...record(), script: "alert(1)" })).toThrow(/unknown or missing keys/);
    expect(() => assertOpsSavedBoardRecord({ ...record(), archivedAt: undefined })).toThrow(/cannot retain/);
    expect(() => assertOpsSavedBoardRecord(record({ requestSha256: "A".repeat(64) }))).toThrow(/SHA-256/);
    expect(() =>
      assertOpsSavedBoardRecord(
        record({
          status: "archived",
          revision: 2,
          updatedAt: "2026-07-14T12:01:00.000Z",
          updatedByActorId: "operator-2",
        }),
      ),
    ).toThrow(/archivedByActorId/);
  });
});
