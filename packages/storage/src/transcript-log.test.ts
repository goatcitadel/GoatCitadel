import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { mock } from "node:test";
import type { TranscriptEvent } from "@goatcitadel/contracts";
import { TranscriptLog } from "./transcript-log.js";

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("TranscriptLog", () => {
  it("serializes concurrent appends per session", async () => {
    const root = path.join(os.tmpdir(), `goatcitadel-transcripts-${randomUUID()}`);
    createdDirs.push(root);
    const log = new TranscriptLog(root);
    const sessionId = "session-test";

    const writes = Array.from({ length: 25 }, (_, index) =>
      log.append(buildEvent(sessionId, index)),
    );
    const offsets = await Promise.all(writes);
    const events = await log.read(sessionId);

    assert.equal(events.length, 25);
    assert.equal(new Set(offsets).size, offsets.length);
    const sorted = [...offsets].sort((a, b) => a - b);
    assert.deepEqual(offsets, sorted);
  });

  it("deletes a session transcript file", async () => {
    const root = path.join(os.tmpdir(), `goatcitadel-transcripts-${randomUUID()}`);
    createdDirs.push(root);
    const log = new TranscriptLog(root);
    const sessionId = "session-delete-test";

    await log.append(buildEvent(sessionId, 0));
    await log.delete(sessionId);

    await assert.rejects(() => log.read(sessionId));
  });

  it("warns and skips malformed transcript lines", async () => {
    const root = path.join(os.tmpdir(), `goatcitadel-transcripts-${randomUUID()}`);
    createdDirs.push(root);
    const log = new TranscriptLog(root);
    const sessionId = "session-corrupt-test";
    const warn = mock.method(console, "warn", () => {});

    await log.append(buildEvent(sessionId, 0));
    const filePath = path.join(root, `${sessionId}.jsonl`);
    fs.appendFileSync(filePath, "{not-json}\n", "utf8");
    await log.append(buildEvent(sessionId, 1));

    const events = await log.read(sessionId);

    assert.equal(events.length, 2);
    assert.equal(warn.mock.callCount(), 1);
  });
});

function buildEvent(sessionId: string, index: number): TranscriptEvent {
  return {
    eventId: `event-${index}`,
    actionId: randomUUID(),
    idempotencyKey: `idem-${index}`,
    sessionId,
    sessionKey: "channel:account:peer",
    timestamp: new Date().toISOString(),
    type: "message.user",
    actorType: "user",
    actorId: "operator",
    payload: { index },
  };
}
