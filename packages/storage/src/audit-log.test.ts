import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { AuditLog } from "./audit-log.js";

const createdDirs: string[] = [];

afterEach(() => {
  delete process.env.GOAT_AUDIT_RETENTION_DAYS;
  for (const dir of createdDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("AuditLog", () => {
  it("sanitizes cyclic payloads into serializable audit records", async () => {
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
    const record = JSON.parse(raw) as { action: string; self: { action: string; self: string } };

    assert.equal(record.action, "tool.invoke");
    assert.deepEqual(record.self, {
      action: "tool.invoke",
      self: "[Circular]",
    });
    assert.equal(warn.mock.callCount(), 0);
  });

  it("redacts secret-like values before writing audit records", async () => {
    const root = path.join(os.tmpdir(), `goatcitadel-audit-${randomUUID()}`);
    createdDirs.push(root);
    const log = new AuditLog(root);

    await log.append("tool_invocations", {
      action: "tool.invoke",
      token: "Bearer abcdefghijklmnopqrstuvwxyz012345",
      nested: {
        apiKey: "sk-abcdefghijklmnopqrstuvwxyz0123456789",
      },
    });

    const filePath = path.join(root, "tool_invocations.jsonl");
    const raw = fs.readFileSync(filePath, "utf8").trim();
    const record = JSON.parse(raw) as { token: string; nested: { apiKey: string } };

    assert.equal(record.token, "[REDACTED]");
    assert.equal(record.nested.apiKey, "[REDACTED]");
  });

  it("prunes aged audit lines when retention is configured", async () => {
    const root = path.join(os.tmpdir(), `goatcitadel-audit-${randomUUID()}`);
    createdDirs.push(root);
    const filePath = path.join(root, "tool_invocations.jsonl");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(filePath, [
      JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", action: "old" }),
      JSON.stringify({ timestamp: new Date().toISOString(), action: "recent" }),
      "",
    ].join("\n"));
    process.env.GOAT_AUDIT_RETENTION_DAYS = "30";

    const log = new AuditLog(root);
    await log.append("tool_invocations", { action: "new" });

    const lines = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(lines.some((record) => record.action === "old"), false);
    assert.equal(lines.some((record) => record.action === "recent"), true);
    assert.equal(lines.some((record) => record.action === "new"), true);
  });
});
