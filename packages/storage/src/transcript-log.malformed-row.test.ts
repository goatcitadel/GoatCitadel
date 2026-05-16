import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TranscriptEvent } from "@goatcitadel/contracts";
import { TranscriptLog } from "./transcript-log.js";

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("TranscriptLog malformed-row tolerance", () => {
  it("skips malformed JSONL line and returns valid neighbors", async () => {
    const root = path.join(os.tmpdir(), `goatcitadel-tlog-malformed-${randomUUID()}`);
    createdDirs.push(root);
    fs.mkdirSync(root, { recursive: true });
    const sessionId = "abc";
    const filePath = path.join(root, `${sessionId}.jsonl`);
    const goodLine = JSON.stringify(buildEvent(sessionId, "first"));
    const goodLineTwo = JSON.stringify(buildEvent(sessionId, "second"));
    const garbage = "{not-valid-json";
    fs.writeFileSync(filePath, `${goodLine}\n${garbage}\n${goodLineTwo}\n`, "utf8");

    const warn = mock.method(console, "warn", () => {});
    const log = new TranscriptLog(root);
    const events = await log.read(sessionId);

    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((event) => event.eventId),
      ["event-first", "event-second"],
    );
    assert.equal(warn.mock.callCount(), 1);
    const [firstCall] = warn.mock.calls;
    assert.ok(firstCall, "expected console.warn to be invoked for malformed line");
    const [warnMessage, warnContext] = firstCall.arguments as [string, { sessionId: string; lineNumber: number }];
    assert.match(warnMessage, /transcript line is malformed/);
    assert.equal(warnContext.sessionId, sessionId);
    assert.equal(warnContext.lineNumber, 2);
  });

  it("returns empty array when the only row is garbage", async () => {
    const root = path.join(os.tmpdir(), `goatcitadel-tlog-malformed-${randomUUID()}`);
    createdDirs.push(root);
    fs.mkdirSync(root, { recursive: true });
    const sessionId = "only-garbage";
    const filePath = path.join(root, `${sessionId}.jsonl`);
    fs.writeFileSync(filePath, "{still-not-json\n", "utf8");

    const warn = mock.method(console, "warn", () => {});
    const log = new TranscriptLog(root);
    const events = await log.read(sessionId);

    assert.equal(events.length, 0);
    assert.equal(warn.mock.callCount(), 1);
  });
});

function buildEvent(sessionId: string, suffix: string): TranscriptEvent {
  return {
    eventId: `event-${suffix}`,
    actionId: randomUUID(),
    idempotencyKey: `idem-${suffix}`,
    sessionId,
    sessionKey: "channel:account:peer",
    timestamp: new Date().toISOString(),
    type: "message.user",
    actorType: "user",
    actorId: "operator",
    payload: { suffix },
  };
}
