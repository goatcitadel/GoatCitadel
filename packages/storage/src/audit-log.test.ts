import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { AuditLog, sanitizeForAudit } from "./audit-log.js";
import { runWithRequestAttribution } from "./request-attribution.js";

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

  it("redacts argv, headers, query tokens, and nested config payloads", async () => {
    const root = path.join(os.tmpdir(), `goatcitadel-audit-${randomUUID()}`);
    createdDirs.push(root);
    const log = new AuditLog(root);

    await log.append("tool_invocations", {
      action: "tool.invoke",
      argv: [
        "node",
        "tool.js",
        "--api-key",
        "sk-abcdefghijklmnopqrstuvwxyz0123456789",
        "--token=opaque-token-value",
        "--url",
        "https://example.test/hook?token=secret-token&ok=1",
      ],
      request: {
        headers: {
          Authorization: "Bearer short-token",
          "X-Trace": "trace-123",
        },
        config: {
          clientSecret: "client-secret-value",
          secretEnv: "CLIENT_SECRET",
        },
      },
    });

    const filePath = path.join(root, "tool_invocations.jsonl");
    const raw = fs.readFileSync(filePath, "utf8").trim();
    const record = JSON.parse(raw) as {
      argv: string[];
      request: {
        headers: { Authorization: string; "X-Trace": string };
        config: { clientSecret: string; secretEnv: string };
      };
    };

    assert.deepEqual(record.argv.slice(2), [
      "--api-key",
      "[REDACTED]",
      "--token=[REDACTED]",
      "--url",
      "https://example.test/hook?token=[REDACTED]&ok=1",
    ]);
    assert.equal(record.request.headers.Authorization, "[REDACTED]");
    assert.equal(record.request.headers["X-Trace"], "trace-123");
    assert.equal(record.request.config.clientSecret, "[REDACTED]");
    assert.equal(record.request.config.secretEnv, "CLIENT_SECRET");
  });

  it("scrubs secret-like strings without redacting env container keys", () => {
    const sanitized = sanitizeForAudit({
      message: [
        "key-abcdefghijklmnopqrstuvwxyz0123456789",
        "Basic abcdefghijklmnopqrstuvwxyz012345",
        "Authorization: Bearer short-token",
        "SERVICE_TOKEN=abcdefghijklmnopqrstuvwxyz012345",
        "keychain:local/provider/openai",
      ].join(" "),
      processEnv: {
        OPENAI_API_KEY: "sk-abcdefghijklmnopqrstuvwxyz0123456789",
      },
      execArgv: ["--password", "hunter2", "--client-secret=secret-value", { token: "abc123" }],
      commandArgs: ["--authorization=Bearer abcdefghijklmnopqrstuvwxyz012345"],
    });

    assert.equal(sanitized.message, "[REDACTED] [REDACTED] Authorization: [REDACTED] [REDACTED] [REDACTED]");
    assert.deepEqual(sanitized.processEnv, { OPENAI_API_KEY: "[REDACTED]" });
    assert.deepEqual(sanitized.execArgv, [
      "--password",
      "[REDACTED]",
      "--client-secret=[REDACTED]",
      { token: "[REDACTED]" },
    ]);
    assert.deepEqual(sanitized.commandArgs, ["--authorization=[REDACTED]"]);
  });

  it("writes degraded records when sanitized payloads still cannot be serialized", async () => {
    const root = path.join(os.tmpdir(), `goatcitadel-audit-${randomUUID()}`);
    createdDirs.push(root);
    const log = new AuditLog(root);
    const warn = mock.method(console, "warn", () => {});

    await runWithRequestAttribution(
      {
        correlationId: "corr-a",
        traceId: "trace-a",
        originSurface: "cowork",
        actorId: "operator",
        deviceId: "device-a",
        grantId: "grant-a",
        companionSessionId: "companion-a",
      },
      () => log.append("hooks", { action: "hook.invoke", value: 1n }),
    );

    const [record] = await log.list("hooks");
    assert.equal(record?.degraded, true);
    assert.equal(record?.correlationId, "corr-a");
    assert.equal(record?.traceId, "trace-a");
    assert.equal(record?.originSurface, "cowork");
    assert.equal(record?.actorId, "operator");
    assert.equal(record?.deviceId, "device-a");
    assert.equal(record?.grantId, "grant-a");
    assert.equal(record?.companionSessionId, "companion-a");
    assert.match(String(record?.serializationError), /BigInt/);
    assert.equal(warn.mock.callCount(), 1);
  });

  it("lists audit records defensively", async () => {
    const root = path.join(os.tmpdir(), `goatcitadel-audit-${randomUUID()}`);
    createdDirs.push(root);
    const log = new AuditLog(root);

    assert.deepEqual(await log.list("approvals"), []);

    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, "approvals.jsonl"),
      [
        JSON.stringify({ action: "approved" }),
        "not-json",
        "null",
        "42",
        JSON.stringify(["array"]),
        JSON.stringify({ action: "rejected" }),
        "",
      ].join("\r\n"),
    );

    assert.deepEqual(await log.list("approvals"), [{ action: "approved" }, { action: "rejected" }]);
  });

  it("returns an empty array when every audit row is malformed", async () => {
    const root = path.join(os.tmpdir(), `goatcitadel-audit-${randomUUID()}`);
    createdDirs.push(root);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, "policy_blocks.jsonl"),
      ["{not-json", "still-not-json", '["array"', ""].join("\r\n"),
    );

    const log = new AuditLog(root);
    assert.deepEqual(await log.list("policy_blocks"), []);
  });

  it("prunes aged audit lines when retention is configured", async () => {
    const root = path.join(os.tmpdir(), `goatcitadel-audit-${randomUUID()}`);
    createdDirs.push(root);
    const filePath = path.join(root, "tool_invocations.jsonl");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", action: "old" }),
        JSON.stringify({ timestamp: new Date().toISOString(), action: "recent" }),
        "",
      ].join("\n"),
    );
    process.env.GOAT_AUDIT_RETENTION_DAYS = "30";

    const log = new AuditLog(root);
    await log.append("tool_invocations", { action: "new" });

    const lines = fs
      .readFileSync(filePath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(
      lines.some((record) => record.action === "old"),
      false,
    );
    assert.equal(
      lines.some((record) => record.action === "recent"),
      true,
    );
    assert.equal(
      lines.some((record) => record.action === "new"),
      true,
    );
  });

  it("handles retention no-file, no-op, malformed, and invalid configuration paths", async () => {
    const root = path.join(os.tmpdir(), `goatcitadel-audit-${randomUUID()}`);
    createdDirs.push(root);
    const log = new AuditLog(root);

    process.env.GOAT_AUDIT_RETENTION_DAYS = "7";
    await log.append("policy_blocks", { action: "first" });
    assert.deepEqual(
      (await log.list("policy_blocks")).map((record) => record.action),
      ["first"],
    );

    const filePath = path.join(root, "policy_blocks.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({ timestamp: new Date().toISOString(), action: "recent" }),
        JSON.stringify({ timestamp: "not-a-date", action: "invalid-date" }),
        JSON.stringify({ action: "missing-timestamp" }),
        "not-json",
        "",
      ].join("\n"),
    );
    await log.append("policy_blocks", { action: "second" });
    assert.deepEqual(
      (await log.list("policy_blocks")).map((record) => record.action),
      ["recent", "invalid-date", "missing-timestamp", "second"],
    );

    process.env.GOAT_AUDIT_RETENTION_DAYS = "0";
    await log.append("policy_blocks", { action: "third" });
    assert.equal(
      (await log.list("policy_blocks")).some((record) => record.action === "third"),
      true,
    );
  });
});
