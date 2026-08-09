import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
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

  it("serializes concurrent appends on the same audit stream", async () => {
    const root = path.join(os.tmpdir(), `goatcitadel-audit-${randomUUID()}`);
    createdDirs.push(root);
    const log = new AuditLog(root);
    const filePath = path.join(root, "tool_invocations.jsonl");
    const originalAppendFile = fsPromises.appendFile.bind(fsPromises);
    let auditWriteCount = 0;
    const appendFileMock = mock.method(
      fsPromises,
      "appendFile",
      async (...args: Parameters<typeof fsPromises.appendFile>) => {
        if (String(args[0]) === filePath) {
          auditWriteCount += 1;
        }
        return await originalAppendFile(...args);
      },
    );

    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        log.append("tool_invocations", {
          action: "tool.invoke",
          index,
        }),
      ),
    );

    const records = await log.list("tool_invocations");
    assert.equal(records.length, 40);
    assert.deepEqual(
      records.map((record) => record.index),
      Array.from({ length: 40 }, (_, index) => index),
    );
    assert.equal(auditWriteCount, 1);
    appendFileMock.mock.restore();
  });

  it("dedupes delivery IDs within one durable audit batch", async () => {
    const root = path.join(os.tmpdir(), `goatcitadel-audit-${randomUUID()}`);
    createdDirs.push(root);
    const log = new AuditLog(root);
    const deliveryId = "approval-observability:approval-batch:create-audit";

    await Promise.all([
      log.append("approvals", { event: "approval.create", sequence: 1 }, { deliveryId }),
      log.append("approvals", { event: "approval.create", sequence: 2 }, { deliveryId }),
      log.append("approvals", { event: "approval.resolve", sequence: 3 }),
    ]);

    const records = await log.list("approvals");
    assert.deepEqual(
      records.map((record) => record.sequence),
      [1, 3],
    );
  });

  it("dedupes a durable delivery id across logger instances and preserves captured attribution", async () => {
    const root = path.join(os.tmpdir(), `goatcitadel-audit-${randomUUID()}`);
    createdDirs.push(root);
    const delivery = {
      deliveryId: "approval-observability:approval-1:create-audit",
      occurredAt: "2026-07-10T10:00:00.000Z",
      attribution: {
        correlationId: "corr-original",
        traceId: "trace-original",
        actorId: "operator-original",
      },
    };

    await new AuditLog(root).append("approvals", { event: "approval.create", approvalId: "approval-1" }, delivery);
    await runWithRequestAttribution({ actorId: "wrong-retry-actor" }, () =>
      new AuditLog(root).append("approvals", { event: "approval.create", approvalId: "approval-1" }, delivery),
    );

    const records = await new AuditLog(root).list("approvals");
    assert.equal(records.length, 1);
    assert.deepEqual(records[0], {
      timestamp: "2026-07-10T10:00:00.000Z",
      event: "approval.create",
      approvalId: "approval-1",
      correlationId: "corr-original",
      traceId: "trace-original",
      actorId: "operator-original",
      eventId: delivery.deliveryId,
      deliveryId: delivery.deliveryId,
    });
  });

  it("waits for a cross-process audit lock before appending", async () => {
    const root = path.join(os.tmpdir(), `goatcitadel-audit-${randomUUID()}`);
    createdDirs.push(root);
    const filePath = path.join(root, "tool_invocations.jsonl");
    const lockDir = `${filePath}.lock`;
    await fsPromises.mkdir(lockDir, { recursive: true });
    const log = new AuditLog(root);

    const append = log.append("tool_invocations", {
      action: "tool.invoke",
      index: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(fs.existsSync(filePath), false);

    await fsPromises.rm(lockDir, { recursive: true, force: true });
    await append;

    const records = await log.list("tool_invocations");
    assert.deepEqual(
      records.map((record) => record.index),
      [1],
    );
    assert.equal(fs.existsSync(lockDir), false);
  });

  it("removes stale cross-process audit locks before appending", async () => {
    const root = path.join(os.tmpdir(), `goatcitadel-audit-${randomUUID()}`);
    createdDirs.push(root);
    const filePath = path.join(root, "policy_blocks.jsonl");
    const lockDir = `${filePath}.lock`;
    await fsPromises.mkdir(lockDir, { recursive: true });
    const staleTime = new Date(Date.now() - 120_000);
    await fsPromises.utimes(lockDir, staleTime, staleTime);
    const log = new AuditLog(root);

    await log.append("policy_blocks", { action: "policy.blocked" });

    const records = await log.list("policy_blocks");
    assert.equal(records[0]?.action, "policy.blocked");
    assert.equal(fs.existsSync(lockDir), false);
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
        "Basic dXNlcjpwYXNz",
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

    assert.equal(sanitized.message, "[REDACTED] Basic [REDACTED] Authorization: [REDACTED]");
    assert.deepEqual(sanitized.processEnv, { OPENAI_API_KEY: "[REDACTED]" });
    assert.deepEqual(sanitized.execArgv, [
      "--password",
      "[REDACTED]",
      "--client-secret=[REDACTED]",
      { token: "[REDACTED]" },
    ]);
    assert.deepEqual(sanitized.commandArgs, ["--authorization=[REDACTED]"]);
  });

  it("uses canonical structured redaction for compound keys without mutating the audit source", () => {
    const circular: Record<string, unknown> = { visible: "ok" };
    circular.self = circular;
    const source = {
      webhookUrl: "https://hooks.example.test/services/team/short-path-secret",
      authorization: "Bearer short",
      DATABASE_PASSWORD: "hunter2",
      tokenEnv: "AUDIT_TOKEN",
      tokenId: "audit-token-id",
      tokenBudget: 256,
      circular,
    };

    const sanitized = sanitizeForAudit(source);

    assert.deepEqual(sanitized, {
      webhookUrl: "[REDACTED]",
      authorization: "[REDACTED]",
      DATABASE_PASSWORD: "[REDACTED]",
      tokenEnv: "AUDIT_TOKEN",
      tokenId: "audit-token-id",
      tokenBudget: 256,
      circular: { visible: "ok", self: "[Circular]" },
    });
    assert.equal(source.webhookUrl, "https://hooks.example.test/services/team/short-path-secret");
    assert.equal(source.authorization, "Bearer short");
    assert.equal(source.DATABASE_PASSWORD, "hunter2");
    assert.equal(circular.self, circular);
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

  it("serializes retention pruning with concurrent appends", async () => {
    const root = path.join(os.tmpdir(), `goatcitadel-audit-${randomUUID()}`);
    createdDirs.push(root);
    const filePath = path.join(root, "approvals.jsonl");
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

    const originalWriteFile = fsPromises.writeFile.bind(fsPromises);
    let activePruneWrites = 0;
    let maxActivePruneWrites = 0;
    const writeFileMock = mock.method(
      fsPromises,
      "writeFile",
      async (...args: Parameters<typeof fsPromises.writeFile>) => {
        activePruneWrites += 1;
        maxActivePruneWrites = Math.max(maxActivePruneWrites, activePruneWrites);
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));
          await originalWriteFile(...args);
        } finally {
          activePruneWrites -= 1;
        }
      },
    );

    const log = new AuditLog(root);
    const appendedActions = Array.from({ length: 25 }, (_, index) => `concurrent-${index}`);
    await Promise.all(appendedActions.map((action) => log.append("approvals", { action })));

    const records = await log.list("approvals");
    const actions = records.map((record) => record.action);
    assert.equal(maxActivePruneWrites, 1);
    assert.equal(actions.includes("old"), false);
    assert.equal(actions.includes("recent"), true);
    for (const action of appendedActions) {
      assert.equal(actions.includes(action), true, `missing ${action}`);
    }
    assert.equal(writeFileMock.mock.callCount(), 1);
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
