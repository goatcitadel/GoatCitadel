import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ChatToolRunRepository, type ChatToolRunCreateInput } from "./chat-tool-run-repo.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const tempDbs = new TempSqliteFiles();

afterEach(() => tempDbs.cleanup());

function createRepo(): ChatToolRunRepository {
  return new ChatToolRunRepository(tempDbs.open({ dbPath: tempDbs.path("goatcitadel-chat-tool-run-counts") }));
}

let sequence = 0;

/** Adds one run; the defaults describe a plain executed call inside the window. */
function addRun(repo: ChatToolRunRepository, input: Partial<ChatToolRunCreateInput> & { toolName: string }): void {
  sequence += 1;
  repo.create({
    toolRunId: `run-${sequence}`,
    turnId: "turn-a",
    sessionId: "session-a",
    status: "executed",
    startedAt: "2026-10-01T00:00:00.000Z",
    ...input,
  });
}

describe("ChatToolRunRepository.countCallsByToolSince", () => {
  it("counts executed and failed calls per tool with the latest start", () => {
    const repo = createRepo();
    addRun(repo, { toolName: "fs.read", startedAt: "2026-10-01T00:00:00.000Z" });
    addRun(repo, { toolName: "fs.read", startedAt: "2026-10-03T00:00:00.000Z" });
    addRun(repo, { toolName: "fs.read", status: "failed", startedAt: "2026-10-02T00:00:00.000Z" });
    addRun(repo, { toolName: "shell.exec", sessionId: "session-b", startedAt: "2026-10-05T00:00:00.000Z" });

    assert.deepEqual(repo.countCallsByToolSince("2026-09-01T00:00:00.000Z"), [
      { toolName: "fs.read", calls: 3, lastCalledAt: "2026-10-03T00:00:00.000Z" },
      { toolName: "shell.exec", calls: 1, lastCalledAt: "2026-10-05T00:00:00.000Z" },
    ]);
  });

  it("leaves out blocked, waiting, running and reused rows", () => {
    const repo = createRepo();
    addRun(repo, { toolName: "fs.write" });
    addRun(repo, { toolName: "fs.write", status: "blocked" });
    addRun(repo, { toolName: "fs.write", status: "approval_required" });
    addRun(repo, { toolName: "fs.write", status: "started" });
    addRun(repo, { toolName: "fs.write", reused: true, reusedFromToolRunId: "run-earlier" });
    // A row written with reused = false stores 0 and still counts, like the first row that never set the field.
    addRun(repo, { toolName: "fs.write", reused: false });
    addRun(repo, { toolName: "fs.delete", status: "blocked" });

    assert.deepEqual(repo.countCallsByToolSince("2026-09-01T00:00:00.000Z"), [
      { toolName: "fs.write", calls: 2, lastCalledAt: "2026-10-01T00:00:00.000Z" },
    ]);
  });

  it("includes a call exactly at the window start and leaves out older ones", () => {
    const repo = createRepo();
    addRun(repo, { toolName: "memory.read", startedAt: "2025-10-27T00:00:00.000Z" });
    addRun(repo, { toolName: "memory.read", startedAt: "2025-10-26T23:59:59.999Z" });
    addRun(repo, { toolName: "memory.search", startedAt: "2025-10-20T00:00:00.000Z" });

    assert.deepEqual(repo.countCallsByToolSince("2025-10-27T00:00:00.000Z"), [
      { toolName: "memory.read", calls: 1, lastCalledAt: "2025-10-27T00:00:00.000Z" },
    ]);
  });

  it("answers an empty list when nothing was called", () => {
    assert.deepEqual(createRepo().countCallsByToolSince("2026-09-01T00:00:00.000Z"), []);
  });
});
