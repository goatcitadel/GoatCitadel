import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Storage } from "@goatcitadel/storage";
import { CoworkAgenticProjectionService } from "./cowork-agentic-projection-service.js";

const storages: Storage[] = [];
const createdDirs: string[] = [];

afterEach(() => {
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
    status?: "running" | "completed" | "failed" | "cancelled";
    durableRunId?: string;
    durableStatus?: "queued" | "running" | "completed" | "failed" | "cancelled";
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
  });
});
