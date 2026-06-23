import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Storage } from "@goatcitadel/storage";
import { CoworkAgenticProjectionService } from "./cowork-agentic-projection-service.js";

const storages: Storage[] = [];
const createdDirs: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-22T08:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  for (const storage of storages.splice(0)) {
    storage.close();
  }
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createHarness() {
  const root = path.join(os.tmpdir(), `goatcitadel-cowork-projection-${randomUUID()}`);
  createdDirs.push(root);
  fs.mkdirSync(root, { recursive: true });
  const storage = new Storage({
    dbPath: path.join(root, "gateway.db"),
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  storages.push(storage);
  return { storage, service: new CoworkAgenticProjectionService(storage) };
}

function createTrace(
  storage: Storage,
  input: {
    turnId: string;
    sessionId: string;
    status?: "running" | "waiting_for_approval" | "waiting_for_user_input" | "completed" | "failed" | "cancelled";
    durableRunId?: string;
    durableStatus?: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";
  },
) {
  storage.chatTurnTraces.create({
    turnId: input.turnId,
    sessionId: input.sessionId,
    userMessageId: `${input.turnId}:user`,
    status: input.status ?? "running",
    mode: "cowork",
    model: "gpt-5",
    webMode: "deep",
    memoryMode: "off",
    thinkingLevel: "standard",
    routing: {},
    durable: input.durableRunId
      ? {
          runId: input.durableRunId,
          workflowKey: "chat.turn.execute",
          status: input.durableStatus ?? "queued",
          createdAt: "2026-06-22T00:00:00.000Z",
          updatedAt: "2026-06-22T00:00:00.000Z",
        }
      : undefined,
  });
}

describe("CoworkAgenticProjectionService", () => {
  it("projects a Cowork orchestration run tree and reconciles stale durable state", () => {
    const { storage, service } = createHarness();
    storage.chatSessionMeta.ensure("parent-session", "2026-06-22T00:00:00.000Z", "default");
    storage.chatSessionMeta.ensure("child-session", "2026-06-22T00:00:00.000Z", "default");
    storage.durableRuns.createRun({
      runId: "durable-parent",
      workflowKey: "chat.turn.execute",
      status: "completed",
      startedAt: "2026-06-22T00:00:00.000Z",
      finishedAt: "2026-06-22T00:04:00.000Z",
    });
    storage.durableRuns.createRun({
      runId: "durable-child",
      workflowKey: "chat.turn.execute",
      status: "completed",
      startedAt: "2026-06-22T00:01:00.000Z",
      finishedAt: "2026-06-22T00:03:00.000Z",
    });
    createTrace(storage, {
      turnId: "parent-turn",
      sessionId: "parent-session",
      durableRunId: "durable-parent",
      durableStatus: "queued",
    });
    createTrace(storage, {
      turnId: "child-turn",
      sessionId: "child-session",
      status: "completed",
      durableRunId: "durable-child",
      durableStatus: "completed",
    });
    storage.chatDelegationRuns.create({
      runId: "orch-91303",
      sessionId: "parent-session",
      taskId: "chat-orchestration:parent-turn",
      objective: "Locate board game stores near 91303",
      roles: ["Researcher"],
      mode: "sequential",
      status: "running",
      workflowTemplate: "research_then_summarize",
      startedAt: "2026-06-22T00:00:00.000Z",
    });
    storage.chatDelegationSteps.create({
      stepId: "orch-91303:researcher",
      runId: "orch-91303",
      role: "Researcher",
      index: 0,
      status: "running",
      durableRunId: "durable-child",
      childSessionId: "child-session",
      childTurnId: "child-turn",
      startedAt: "2026-06-22T00:01:00.000Z",
    });

    const tree = service.getAgenticRunTree("orch-91303", { workspaceId: "default" });

    expect(tree).toBeDefined();
    expect(tree?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "run:orch-91303", kind: "run", status: "completed" }),
        expect.objectContaining({ id: "durable:durable-parent", status: "completed" }),
        expect.objectContaining({ id: "subagent:orch-91303:researcher", kind: "subagent", status: "completed" }),
        expect.objectContaining({ id: "durable:durable-child", status: "completed" }),
      ]),
    );
    expect(tree?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "projection_status_drift", evidenceRef: "durable-run:durable-parent" }),
        expect.objectContaining({ code: "projection_status_drift", evidenceRef: "durable-run:durable-child" }),
      ]),
    );
    expect(storage.chatTurnTraces.get("parent-turn").durable?.status).toBe("completed");
    expect(storage.chatDelegationSteps.get("orch-91303:researcher").status).toBe("completed");
    expect(storage.chatDelegationRuns.get("orch-91303").status).toBe("completed");
    expect(tree?.controls.every((control) => control.enabled === false)).toBe(true);
  });

  it("does not fake parent-filtered child runs until delegation parent links are persisted", () => {
    const { storage, service } = createHarness();
    storage.chatSessionMeta.ensure("parent-session", "2026-06-22T00:00:00.000Z", "default");
    storage.chatDelegationRuns.create({
      runId: "orch-parent",
      sessionId: "parent-session",
      taskId: "chat-orchestration:parent-turn",
      objective: "Parent orchestration",
      roles: ["Researcher"],
      mode: "sequential",
      status: "running",
      startedAt: "2026-06-22T00:00:00.000Z",
    });

    expect(service.listAgenticRuns({ workspaceId: "default", parentRunId: "orch-parent" })).toEqual([]);
  });

  it("projects approval-gated Cowork runs as settled operator gates instead of active running work", () => {
    const { storage, service } = createHarness();
    storage.chatSessionMeta.ensure("parent-session", "2026-06-22T00:00:00.000Z", "default");
    storage.chatSessionMeta.ensure("child-session", "2026-06-22T00:00:00.000Z", "default");
    storage.durableRuns.createRun({
      runId: "durable-parent-waiting",
      workflowKey: "chat.turn.execute",
      status: "waiting",
      startedAt: "2026-06-22T00:00:00.000Z",
      leaseHeartbeatAt: "2026-06-22T00:04:00.000Z",
    });
    storage.durableRuns.createRun({
      runId: "durable-child-waiting",
      workflowKey: "chat.turn.execute",
      status: "waiting",
      startedAt: "2026-06-22T00:01:00.000Z",
      leaseHeartbeatAt: "2026-06-22T00:04:00.000Z",
    });
    createTrace(storage, {
      turnId: "parent-turn",
      sessionId: "parent-session",
      status: "waiting_for_approval",
      durableRunId: "durable-parent-waiting",
      durableStatus: "waiting",
    });
    createTrace(storage, {
      turnId: "child-turn",
      sessionId: "child-session",
      status: "waiting_for_approval",
      durableRunId: "durable-child-waiting",
      durableStatus: "waiting",
    });
    storage.chatDelegationRuns.create({
      runId: "orch-approval-gate",
      sessionId: "parent-session",
      taskId: "chat-orchestration:parent-turn",
      objective: "Locate board game stores near 91303",
      roles: ["Planner", "Worker", "Reviewer", "Synthesizer"],
      mode: "sequential",
      status: "running",
      startedAt: "2026-06-22T00:00:00.000Z",
    });
    storage.chatDelegationSteps.create({
      stepId: "orch-approval-gate:planner",
      runId: "orch-approval-gate",
      role: "Planner",
      index: 0,
      status: "completed",
      summary: "Plan complete.",
      startedAt: "2026-06-22T00:00:30.000Z",
      finishedAt: "2026-06-22T00:01:00.000Z",
    });
    storage.chatDelegationSteps.create({
      stepId: "orch-approval-gate:worker",
      runId: "orch-approval-gate",
      role: "Worker",
      index: 1,
      status: "running",
      durableRunId: "durable-child-waiting",
      childSessionId: "child-session",
      childTurnId: "child-turn",
      summary: "Approval required by policy.",
      startedAt: "2026-06-22T00:01:00.000Z",
    });
    storage.chatDelegationSteps.create({
      stepId: "orch-approval-gate:reviewer",
      runId: "orch-approval-gate",
      role: "Reviewer",
      index: 2,
      status: "pending",
      startedAt: "2026-06-22T00:01:00.000Z",
    });

    const tree = service.getAgenticRunTree("orch-approval-gate", { workspaceId: "default" });

    expect(tree?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "run:orch-approval-gate", kind: "run", status: "approval_required" }),
        expect.objectContaining({ id: "durable:durable-parent-waiting", status: "waiting" }),
        expect.objectContaining({ id: "subagent:orch-approval-gate:worker", status: "approval_required" }),
        expect.objectContaining({
          id: "subagent:orch-approval-gate:reviewer",
          status: "blocked",
          metadata: expect.objectContaining({ blockedByOperatorGate: true }),
        }),
      ]),
    );
    expect(tree?.controls.find((control) => control.action === "cancel")?.enabled).toBe(true);
    expect(storage.chatDelegationRuns.get("orch-approval-gate").status).toBe("running");
    expect(storage.chatDelegationSteps.get("orch-approval-gate:reviewer").status).toBe("pending");
  });

  it("does not reconcile waiting child handoff text as completed when durable linkage is absent", () => {
    const { storage, service } = createHarness();
    storage.chatSessionMeta.ensure("parent-session", "2026-06-22T00:00:00.000Z", "default");
    storage.chatSessionMeta.ensure("child-session", "2026-06-22T00:00:00.000Z", "default");
    createTrace(storage, {
      turnId: "parent-turn",
      sessionId: "parent-session",
    });
    createTrace(storage, {
      turnId: "child-turn",
      sessionId: "child-session",
      status: "waiting_for_approval",
    });
    storage.chatDelegationRuns.create({
      runId: "orch-wait-no-durable",
      sessionId: "parent-session",
      taskId: "chat-orchestration:parent-turn",
      objective: "Collect local business contacts",
      roles: ["Worker"],
      mode: "sequential",
      status: "running",
      startedAt: "2026-06-22T00:00:00.000Z",
    });
    storage.chatDelegationSteps.create({
      stepId: "orch-wait-no-durable:worker",
      runId: "orch-wait-no-durable",
      role: "Worker",
      index: 0,
      status: "running",
      childSessionId: "child-session",
      childTurnId: "child-turn",
      output: "Delegate is waiting for approval.",
      startedAt: "2026-06-22T00:01:00.000Z",
    });

    const tree = service.getAgenticRunTree("orch-wait-no-durable", { workspaceId: "default" });

    expect(tree?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "run:orch-wait-no-durable", status: "running" }),
        expect.objectContaining({ id: "subagent:orch-wait-no-durable:worker", status: "approval_required" }),
      ]),
    );
    expect(storage.chatDelegationSteps.get("orch-wait-no-durable:worker").status).toBe("running");
    expect(storage.chatDelegationRuns.get("orch-wait-no-durable").status).toBe("running");
  });

  it("does not let terminal child traces override nonterminal durable child state", () => {
    const { storage, service } = createHarness();
    storage.chatSessionMeta.ensure("parent-session", "2026-06-22T00:00:00.000Z", "default");
    storage.chatSessionMeta.ensure("child-session", "2026-06-22T00:00:00.000Z", "default");
    storage.durableRuns.createRun({
      runId: "durable-child-still-waiting",
      workflowKey: "chat.turn.execute",
      status: "waiting",
      startedAt: "2026-06-22T00:01:00.000Z",
      leaseHeartbeatAt: "2026-06-22T00:04:00.000Z",
    });
    createTrace(storage, {
      turnId: "parent-turn",
      sessionId: "parent-session",
    });
    createTrace(storage, {
      turnId: "child-turn",
      sessionId: "child-session",
      status: "completed",
      durableRunId: "durable-child-still-waiting",
      durableStatus: "waiting",
    });
    storage.chatDelegationRuns.create({
      runId: "orch-durable-dominates",
      sessionId: "parent-session",
      taskId: "chat-orchestration:parent-turn",
      objective: "Collect local business contacts",
      roles: ["Worker"],
      mode: "sequential",
      status: "running",
      startedAt: "2026-06-22T00:00:00.000Z",
    });
    storage.chatDelegationSteps.create({
      stepId: "orch-durable-dominates:worker",
      runId: "orch-durable-dominates",
      role: "Worker",
      index: 0,
      status: "running",
      durableRunId: "durable-child-still-waiting",
      childSessionId: "child-session",
      childTurnId: "child-turn",
      output: "Found candidate evidence.",
      startedAt: "2026-06-22T00:01:00.000Z",
    });

    const tree = service.getAgenticRunTree("orch-durable-dominates", { workspaceId: "default" });

    expect(tree?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "run:orch-durable-dominates", status: "running" }),
        expect.objectContaining({ id: "subagent:orch-durable-dominates:worker", status: "approval_required" }),
        expect.objectContaining({ id: "durable:durable-child-still-waiting", status: "waiting" }),
      ]),
    );
    expect(storage.chatDelegationSteps.get("orch-durable-dominates:worker").status).toBe("running");
    expect(storage.chatDelegationRuns.get("orch-durable-dominates").status).toBe("running");
  });

  it("does not surface planner-only local-business candidate diagnostics before worker discovery runs", () => {
    const { storage, service } = createHarness();
    storage.chatSessionMeta.ensure("parent-session", "2026-06-22T00:00:00.000Z", "default");
    storage.chatSessionMeta.ensure("planner-session", "2026-06-22T00:00:00.000Z", "default");
    createTrace(storage, {
      turnId: "parent-turn",
      sessionId: "parent-session",
    });
    createTrace(storage, {
      turnId: "planner-turn",
      sessionId: "planner-session",
      status: "completed",
    });
    storage.chatToolRuns.create({
      toolRunId: "planner-local-business",
      turnId: "planner-turn",
      sessionId: "planner-session",
      toolName: "browser.search",
      status: "executed",
      args: { query: "board game store 91303 contact email" },
      result: {
        localBusinessResearch: {
          kind: "local_business_contact_research",
          workflow: "local_business.research",
          candidates: [],
          blockers: ["candidate_discovery_incomplete"],
          excluded: [{ reason: "location_not_verified_from_search_result", sourceUrl: "https://board.example" }],
        },
      },
      startedAt: "2026-06-22T00:00:30.000Z",
      finishedAt: "2026-06-22T00:00:31.000Z",
    });
    storage.chatDelegationRuns.create({
      runId: "orch-planner-only",
      sessionId: "parent-session",
      taskId: "chat-orchestration:parent-turn",
      objective: "Locate board game stores near 91303",
      roles: ["Planner", "Worker"],
      mode: "sequential",
      status: "running",
      startedAt: "2026-06-22T00:00:00.000Z",
    });
    storage.chatDelegationSteps.create({
      stepId: "orch-planner-only:planner",
      runId: "orch-planner-only",
      role: "planner",
      label: "Planner",
      index: 0,
      status: "completed",
      childSessionId: "planner-session",
      childTurnId: "planner-turn",
      output: "Plan complete.",
      startedAt: "2026-06-22T00:00:10.000Z",
      finishedAt: "2026-06-22T00:00:40.000Z",
    });
    storage.chatDelegationSteps.create({
      stepId: "orch-planner-only:worker",
      runId: "orch-planner-only",
      role: "worker",
      label: "Worker",
      index: 1,
      status: "pending",
      startedAt: "2026-06-22T00:00:40.000Z",
    });

    const tree = service.getAgenticRunTree("orch-planner-only", { workspaceId: "default" });

    expect(tree?.diagnostics).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "candidate_discovery_incomplete" })]),
    );
  });

  it("reconciles missing durable rows from output or stale worker evidence", () => {
    const { storage, service } = createHarness();
    storage.chatSessionMeta.ensure("parent-session", "2026-06-22T00:00:00.000Z", "default");
    createTrace(storage, { turnId: "parent-turn", sessionId: "parent-session" });
    storage.chatDelegationRuns.create({
      runId: "orch-missing-durable",
      sessionId: "parent-session",
      taskId: "chat-orchestration:parent-turn",
      objective: "Collect local business leads",
      roles: ["Researcher", "Verifier"],
      mode: "parallel",
      status: "running",
      startedAt: "2026-06-22T00:00:00.000Z",
    });
    storage.chatDelegationSteps.create({
      stepId: "orch-missing-durable:researcher",
      runId: "orch-missing-durable",
      role: "Researcher",
      index: 0,
      status: "running",
      output: "Found two official store sites with address evidence.",
      startedAt: "2026-06-22T00:01:00.000Z",
    });
    storage.chatDelegationSteps.create({
      stepId: "orch-missing-durable:verifier",
      runId: "orch-missing-durable",
      role: "Verifier",
      index: 1,
      status: "running",
      startedAt: "2026-06-20T00:01:00.000Z",
    });

    const tree = service.getAgenticRunTree("orch-missing-durable", { workspaceId: "default" });

    expect(tree?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "durable_missing_after_completion" }),
        expect.objectContaining({ code: "stale_worker" }),
      ]),
    );
    expect(storage.chatDelegationSteps.get("orch-missing-durable:researcher").status).toBe("completed");
    expect(storage.chatDelegationSteps.get("orch-missing-durable:verifier").status).toBe("failed");
    expect(storage.chatDelegationRuns.get("orch-missing-durable").status).toBe("partial");
    expect(tree?.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "run:orch-missing-durable", status: "blocked" })]),
    );
  });

  it("does not attach orphaned delegation runs to arbitrary requested workspaces", () => {
    const { storage, service } = createHarness();
    storage.durableRuns.createRun({
      runId: "durable-orphan-child",
      workflowKey: "chat.turn.execute",
      status: "completed",
      startedAt: "2026-06-22T00:01:00.000Z",
      finishedAt: "2026-06-22T00:03:00.000Z",
    });
    storage.chatDelegationRuns.create({
      runId: "orch-orphan",
      sessionId: "missing-parent-session",
      taskId: "chat-orchestration:missing-parent-turn",
      objective: "Should not inherit caller workspace",
      roles: ["Researcher"],
      mode: "sequential",
      status: "running",
      startedAt: "2026-06-22T00:00:00.000Z",
    });
    storage.chatDelegationSteps.create({
      stepId: "orch-orphan:researcher",
      runId: "orch-orphan",
      role: "Researcher",
      index: 0,
      status: "running",
      durableRunId: "durable-orphan-child",
      startedAt: "2026-06-22T00:01:00.000Z",
    });

    expect(service.getAgenticRunTree("orch-orphan", { workspaceId: "workspace-a" })).toBeUndefined();
    expect(service.getAgenticRunTree("orch-orphan", { workspaceId: "default" })).toBeUndefined();
    expect(storage.chatDelegationSteps.get("orch-orphan:researcher").status).toBe("running");
    expect(storage.chatDelegationRuns.get("orch-orphan").status).toBe("running");
  });

  it("rejects workspace mismatches before stale child reconciliation", () => {
    const { storage, service } = createHarness();
    storage.chatSessionMeta.ensure("parent-session", "2026-06-22T00:00:00.000Z", "workspace-a");
    storage.chatSessionMeta.ensure("child-session", "2026-06-22T00:00:00.000Z", "workspace-a");
    storage.durableRuns.createRun({
      runId: "durable-mismatch-child",
      workflowKey: "chat.turn.execute",
      status: "completed",
      startedAt: "2026-06-22T00:01:00.000Z",
      finishedAt: "2026-06-22T00:03:00.000Z",
    });
    createTrace(storage, {
      turnId: "parent-turn",
      sessionId: "parent-session",
    });
    storage.chatDelegationRuns.create({
      runId: "orch-workspace-a",
      sessionId: "parent-session",
      taskId: "chat-orchestration:parent-turn",
      objective: "Scoped run",
      roles: ["Researcher"],
      mode: "sequential",
      status: "running",
      startedAt: "2026-06-22T00:00:00.000Z",
    });
    storage.chatDelegationSteps.create({
      stepId: "orch-workspace-a:researcher",
      runId: "orch-workspace-a",
      role: "Researcher",
      index: 0,
      status: "running",
      durableRunId: "durable-mismatch-child",
      childSessionId: "child-session",
      startedAt: "2026-06-22T00:01:00.000Z",
    });

    expect(service.getAgenticRunTree("orch-workspace-a", { workspaceId: "workspace-b" })).toBeUndefined();
    expect(storage.chatDelegationSteps.get("orch-workspace-a:researcher").status).toBe("running");

    const tree = service.getAgenticRunTree("orch-workspace-a", { workspaceId: "workspace-a" });

    expect(tree).toMatchObject({ runId: "orch-workspace-a", boardId: "cowork:workspace-a" });
    expect(tree?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "subagent:orch-workspace-a:researcher", status: "completed" }),
      ]),
    );
    expect(storage.chatDelegationSteps.get("orch-workspace-a:researcher").status).toBe("completed");
    expect(storage.chatDelegationRuns.get("orch-workspace-a").status).toBe("completed");
  });

  it("preserves explicitly default-owned projected run trees", () => {
    const { storage, service } = createHarness();
    storage.chatSessionMeta.ensure("parent-session", "2026-06-22T00:00:00.000Z", "default");
    createTrace(storage, {
      turnId: "parent-turn",
      sessionId: "parent-session",
    });
    storage.chatDelegationRuns.create({
      runId: "orch-default",
      sessionId: "parent-session",
      taskId: "chat-orchestration:parent-turn",
      objective: "Default workspace run",
      roles: ["Researcher"],
      mode: "sequential",
      status: "completed",
      finalSummary: "Done",
      startedAt: "2026-06-22T00:00:00.000Z",
      finishedAt: "2026-06-22T00:01:00.000Z",
    });

    expect(service.getAgenticRunTree("orch-default")).toMatchObject({
      runId: "orch-default",
      boardId: "cowork:default",
    });
    expect(service.getAgenticRunTree("orch-default", { workspaceId: "workspace-a" })).toBeUndefined();
  });

  it("accepts durable payload workspace proof when session metadata is missing", () => {
    const { storage, service } = createHarness();
    storage.durableRuns.createRun({
      runId: "durable-parent-proof",
      workflowKey: "chat.turn.execute",
      status: "completed",
      payload: {
        version: "chat.turn.execute.v1",
        sessionId: "parent-session",
        turnId: "parent-turn",
        request: { workspaceId: "workspace-a" },
      },
      startedAt: "2026-06-22T00:00:00.000Z",
      finishedAt: "2026-06-22T00:04:00.000Z",
    });
    createTrace(storage, {
      turnId: "parent-turn",
      sessionId: "parent-session",
      durableRunId: "durable-parent-proof",
      durableStatus: "queued",
    });
    storage.chatDelegationRuns.create({
      runId: "orch-durable-proof",
      sessionId: "parent-session",
      taskId: "chat-orchestration:parent-turn",
      objective: "Use durable linkage",
      roles: ["Researcher"],
      mode: "sequential",
      status: "completed",
      finalSummary: "Done",
      startedAt: "2026-06-22T00:00:00.000Z",
      finishedAt: "2026-06-22T00:01:00.000Z",
    });

    expect(service.getAgenticRunTree("orch-durable-proof", { workspaceId: "workspace-b" })).toBeUndefined();
    expect(service.getAgenticRunTree("orch-durable-proof", { workspaceId: "workspace-a" })).toMatchObject({
      runId: "orch-durable-proof",
      boardId: "cowork:workspace-a",
    });
  });

  it("projects partial Cowork handoffs with output as checkpointing instead of completed", () => {
    const { storage, service } = createHarness();
    storage.chatSessionMeta.ensure("parent-session", "2026-06-22T00:00:00.000Z", "default");
    createTrace(storage, {
      turnId: "parent-turn",
      sessionId: "parent-session",
      status: "completed",
    });
    storage.chatDelegationRuns.create({
      runId: "orch-partial-checkpoint",
      sessionId: "parent-session",
      taskId: "chat-orchestration:parent-turn",
      objective: "Checkpoint partial handoff",
      roles: ["Researcher"],
      mode: "sequential",
      status: "partial",
      stitchedOutput: "Checkpointed handoff with gathered evidence.",
      startedAt: "2026-06-22T00:00:00.000Z",
      finishedAt: "2026-06-22T00:01:00.000Z",
    });

    const tree = service.getAgenticRunTree("orch-partial-checkpoint", { workspaceId: "default" });

    expect(tree?.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "run:orch-partial-checkpoint", status: "checkpointing" })]),
    );
    expect(tree?.controls.find((control) => control.action === "retry")?.enabled).toBe(true);
  });

  it("projects blocked Cowork handoffs with research diagnostics from trace, handoff, and local-business metadata", () => {
    const { storage, service } = createHarness();
    storage.chatSessionMeta.ensure("parent-session", "2026-06-22T00:00:00.000Z", "default");
    storage.chatSessionMeta.ensure("child-session", "2026-06-22T00:00:00.000Z", "default");
    createTrace(storage, {
      turnId: "parent-turn",
      sessionId: "parent-session",
      status: "failed",
    });
    storage.chatTurnTraces.patch("parent-turn", {
      routing: {
        fallbackReason: "candidate_discovery_incomplete: delegated search did not produce enough candidates.",
      },
      failure: {
        failureClass: "tool_loop_guard",
        message: "repeated_tool_loop stopped at a Cowork checkpoint.",
        recommendedAction: "retry_narrower",
      },
    });
    createTrace(storage, {
      turnId: "child-turn",
      sessionId: "child-session",
      status: "completed",
    });
    storage.chatToolRuns.create({
      toolRunId: "tool-local-business",
      turnId: "child-turn",
      sessionId: "child-session",
      toolName: "browser.search",
      status: "failed",
      args: { query: "board game store 91303 contact email" },
      result: {
        localBusinessResearch: {
          kind: "local_business_contact_research",
          workflow: "local_business.research",
          candidates: [
            {
              storeName: "Game N Grounds",
              verificationStatus: "partial",
              sourceUrls: ["https://gamengrounds.example/contact"],
              blockers: ["email_not_verified_from_search_result"],
              evidence: [{ url: "https://gamengrounds.example/contact", evidenceKind: "identity" }],
            },
          ],
          blockers: ["Yelp returned 403"],
          excluded: [
            {
              reason: "blocked_or_secondary_listing_source",
              sourceUrl: "https://www.yelp.com/search?find_desc=board+games&find_loc=91303",
            },
          ],
          unresolvedNextSteps: ["Open official contact pages for email/name verification."],
        },
      },
      error: "remote site blocked automation",
      failureGuidance: "source_access_blocked: try an official source instead of the blocked listing.",
      startedAt: "2026-06-22T00:01:00.000Z",
      finishedAt: "2026-06-22T00:01:05.000Z",
    });
    storage.chatDelegationRuns.create({
      runId: "orch-checkpointed",
      sessionId: "parent-session",
      taskId: "chat-orchestration:parent-turn",
      objective: "Locate board game stores near 91303",
      roles: ["Researcher"],
      mode: "sequential",
      status: "partial",
      stitchedOutput: "Checkpointed handoff with partial local-business evidence.",
      startedAt: "2026-06-22T00:00:00.000Z",
      finishedAt: "2026-06-22T00:02:00.000Z",
    });
    storage.chatDelegationSteps.create({
      stepId: "orch-checkpointed:researcher",
      runId: "orch-checkpointed",
      role: "Researcher",
      index: 0,
      status: "completed",
      childSessionId: "child-session",
      childTurnId: "child-turn",
      output: "Operator handoff: source_access_blocked on Yelp; research_evidence_incomplete for email/name fields.",
      startedAt: "2026-06-22T00:01:00.000Z",
      finishedAt: "2026-06-22T00:02:00.000Z",
    });

    const tree = service.getAgenticRunTree("orch-checkpointed", { workspaceId: "default" });

    expect(tree?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "run:orch-checkpointed", status: "blocked" }),
        expect.objectContaining({
          kind: "diagnostic",
          metadata: expect.objectContaining({ code: "source_access_blocked" }),
        }),
        expect.objectContaining({
          kind: "diagnostic",
          metadata: expect.objectContaining({ code: "research_evidence_incomplete" }),
        }),
        expect.objectContaining({
          kind: "diagnostic",
          metadata: expect.objectContaining({ code: "candidate_discovery_incomplete" }),
        }),
      ]),
    );
    expect(tree?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "source_access_blocked" }),
        expect.objectContaining({ code: "research_evidence_incomplete" }),
        expect.objectContaining({ code: "candidate_discovery_incomplete" }),
      ]),
    );
    const researcherNode = tree?.nodes.find((node) => node.id === "subagent:orch-checkpointed:researcher");
    expect(researcherNode?.metadata).toMatchObject({
      toolRunCount: 1,
      localBusinessResearch: [
        expect.objectContaining({
          kind: "local_business_contact_research",
          workflow: "local_business.research",
          candidates: [
            expect.objectContaining({
              storeName: "Game N Grounds",
              verificationStatus: "partial",
              sourceUrls: ["https://gamengrounds.example/contact"],
            }),
          ],
          blockers: ["Yelp returned 403"],
        }),
      ],
    });
    expect(tree?.controls.find((control) => control.action === "retry")?.enabled).toBe(true);
  });

  it("projects local-business annotations from completed delegated handoff output and citations", () => {
    const { storage, service } = createHarness();
    storage.chatSessionMeta.ensure("parent-session", "2026-06-22T00:00:00.000Z", "default");
    createTrace(storage, {
      turnId: "parent-turn",
      sessionId: "parent-session",
      status: "completed",
    });
    storage.chatDelegationRuns.create({
      runId: "orch-handoff-research",
      sessionId: "parent-session",
      taskId: "chat-orchestration:parent-turn",
      objective:
        "Can you locate all the boardgame/tabletop game stores within a 10-mile radius of 91303 and find the email addresses and who I should address in them?",
      roles: ["Worker"],
      mode: "sequential",
      status: "completed",
      finalSummary: "Completed source-backed local-business handoff.",
      startedAt: "2026-06-22T00:00:00.000Z",
      finishedAt: "2026-06-22T00:01:00.000Z",
    });
    storage.chatDelegationSteps.create({
      stepId: "orch-handoff-research:worker",
      runId: "orch-handoff-research",
      role: "Worker",
      index: 0,
      status: "completed",
      output: [
        "| Store | Address / radius status | Public email | Who to address | Evidence / status |",
        "|---|---|---:|---|---|",
        "| **Cash Cards Unlimited** | 6600 Topanga Canyon Blvd, Canoga Park, CA 91303 | **info@cashcardsunlimited.com** | **Cash Cards Unlimited Team** | Official contact page verifies the local store email: https://cashcardsunlimited.com/pages/contact-us |",
      ].join("\n"),
      citations: [
        {
          citationId: "cash-cards-contact",
          title: "Contact Us - Cash Cards Unlimited",
          url: "https://cashcardsunlimited.com/pages/contact-us",
          snippet:
            "Cash Cards Unlimited 6600 Topanga Canyon Blvd, Canoga Park, CA 91303. Email: Info@cashcardsunlimited.com",
          sourceType: "web",
        },
      ],
      startedAt: "2026-06-22T00:00:10.000Z",
      finishedAt: "2026-06-22T00:01:00.000Z",
    });

    const tree = service.getAgenticRunTree("orch-handoff-research", { workspaceId: "default" });
    const workerNode = tree?.nodes.find((node) => node.id === "subagent:orch-handoff-research:worker");

    expect(workerNode?.metadata).toMatchObject({
      localBusinessResearch: [
        expect.objectContaining({
          kind: "local_business_contact_research",
          workflow: "local_business.research",
          candidates: [
            expect.objectContaining({
              storeName: "Cash Cards Unlimited",
              email: "info@cashcardsunlimited.com",
              verificationStatus: "partial",
              sourceUrls: ["https://cashcardsunlimited.com/pages/contact-us"],
            }),
          ],
        }),
      ],
    });
  });
});
