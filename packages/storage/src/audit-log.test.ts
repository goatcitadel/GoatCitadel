import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { AuditLog } from "./audit-log.js";

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

describe("AuditLog", () => {
  it("warns and writes a degraded record when payload serialization fails", async () => {
    const root = path.join(os.tmpdir(), `goatcitadel-audit-${randomUUID()}`);
    createdDirs.push(root);
    const log = new AuditLog(root);
    const warn = mock.method(console, "warn", () => {});
    const payload: Record<string, unknown> = {
      action: "tool.invoke",
    };
    payload.self = payload;

    await log.append("tool_invocations", payload);

    const filePath = path.join(root, "tool_invocations.jsonl");
    const raw = fs.readFileSync(filePath, "utf8").trim();
    const record = JSON.parse(raw) as { degraded?: boolean; serializationError?: string };

    assert.equal(record.degraded, true);
    assert.equal(typeof record.serializationError, "string");
    assert.equal(warn.mock.callCount(), 1);
  });
});
