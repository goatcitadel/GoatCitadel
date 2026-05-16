import { afterEach, describe, it } from "node:test";
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

    const warnCalls: Array<[unknown, string]> = [];
    const log = new TranscriptLog(root, {
      logger: {
        warn: (data, message) => warnCalls.push([data, message]),
      },
    });
    const events = await log.read(sessionId);

    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((event) => event.eventId),
      ["event-first", "event-second"],
    );
    assert.equal(warnCalls.length, 1);
    const firstWarning = warnCalls[0];
    assert.ok(firstWarning);
    const [warnContext, warnMessage] = firstWarning as [{ rowId: string; schemaError: string; store: string }, string];
    assert.match(warnMessage, /state validation failed/);
    assert.equal(warnContext.store, "transcript.jsonl");
    assert.equal(warnContext.rowId, `${sessionId}:line-2`);
    assert.match(warnContext.schemaError, /json_parse/);
  });

  it("returns empty array when the only row is garbage", async () => {
    const root = path.join(os.tmpdir(), `goatcitadel-tlog-malformed-${randomUUID()}`);
    createdDirs.push(root);
    fs.mkdirSync(root, { recursive: true });
    const sessionId = "only-garbage";
    const filePath = path.join(root, `${sessionId}.jsonl`);
    fs.writeFileSync(filePath, "{still-not-json\n", "utf8");

    const warnCalls: Array<[unknown, string]> = [];
    const log = new TranscriptLog(root, {
      logger: {
        warn: (data, message) => warnCalls.push([data, message]),
      },
    });
    const events = await log.read(sessionId);

    assert.equal(events.length, 0);
    assert.equal(warnCalls.length, 1);
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
