import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { TranscriptEvent } from "@goatcitadel/contracts";
import { TranscriptLog } from "./transcript-log.js";
import { createDatabase } from "./sqlite.js";
import { StateValidationQuarantineRepository } from "./state-validation-quarantine-repo.js";

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

    const writes = Array.from({ length: 25 }, (_, index) => log.append(buildEvent(sessionId, index)));
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

  it("skips malformed transcript lines and continues reading", async () => {
    const root = path.join(os.tmpdir(), `goatcitadel-transcripts-${randomUUID()}`);
    createdDirs.push(root);
    const log = new TranscriptLog(root);
    const sessionId = "session-corrupt-test";

    await log.append(buildEvent(sessionId, 0));
    const filePath = path.join(root, `${sessionId}.jsonl`);
    fs.appendFileSync(filePath, "{not-json}\n", "utf8");
    await log.append(buildEvent(sessionId, 1));

    const events = await log.read(sessionId);

    assert.equal(events.length, 2);
  });
});

describe("TranscriptLog sanitization", () => {
  it("skips and quarantines a malformed JSONL row instead of crashing", async () => {
    const transcriptsDir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-transcript-sanitize-"));
    createdDirs.push(transcriptsDir);
    const dbPath = path.join(transcriptsDir, "db.sqlite");
    const db = createDatabase({ dbPath });
    const quarantine = new StateValidationQuarantineRepository(db);
    const log = new TranscriptLog(transcriptsDir, { quarantine });

    const sessionId = "session-sanitize";
    const transcriptPath = path.join(transcriptsDir, `${sessionId}.jsonl`);
    await fs.promises.writeFile(
      transcriptPath,
      [JSON.stringify(buildEvent(sessionId, 0)), "{not json", JSON.stringify(buildEvent(sessionId, 1))].join("\n") +
        "\n",
      "utf8",
    );

    const events = await log.read(sessionId);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.eventId, "event-0");
    assert.equal(events[1]?.eventId, "event-1");
    assert.equal(quarantine.count(), 1);
    const entry0 = quarantine.list(10)[0];
    assert.ok(entry0);
    assert.equal(entry0.store, "transcript.jsonl");
    assert.match(entry0.rowId, new RegExp(sessionId));
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
