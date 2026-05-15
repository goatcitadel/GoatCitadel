import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { DEFAULT_PROMPT_PACK_POLICY_V2 } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { ApprovalInboxRepository } from "./approval-inbox-repo.js";
import { PromptPackRepository } from "./prompt-pack-repo.js";
import { createDatabase } from "./sqlite.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // Ignore cleanup noise from SQLite sidecar files.
    }
  }
});

function createDb(prefix: string): DatabaseClient {
  const dbPath = path.join(os.tmpdir(), `${prefix}-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  return createDatabase({ dbPath });
}

describe("storage loop 28 branch tails", () => {
  it("keeps prompt pack policy overrides honest when stored hash/source fields are absent", () => {
    const db = createDb("goatcitadel-loop28-prompt-pack");
    const repo = new PromptPackRepository(db);
    const { pack, tests } = repo.replacePackTests({
      packId: "pack-loop28",
      name: "Loop 28",
      sourceLabel: undefined,
      policySource: "pack_override",
      tests: [
        {
          code: "L28-1",
          title: "Default mode",
          prompt: "Cover default prompt-pack mapping",
          orderIndex: 1,
        },
      ],
    });

    assert.equal(pack.sourceLabel, undefined);
    assert.equal(pack.policySource, "pack_override");
    assert.deepEqual(pack.policyV2, DEFAULT_PROMPT_PACK_POLICY_V2);
    assert.equal(tests[0]?.mode, undefined);
    assert.equal(tests[0]?.toolTier, undefined);
    assert.equal(tests[0]?.diagnosticMetadata, undefined);

    db.prepare("UPDATE prompt_packs SET policy_v2_hash = '', policy_v2_json = ? WHERE pack_id = ?").run(
      "not-json",
      "pack-loop28",
    );
    const recovered = repo.getPack("pack-loop28");
    assert.equal(recovered.policySource, "pack_override");
    assert.deepEqual(recovered.policyV2, DEFAULT_PROMPT_PACK_POLICY_V2);
    const recoveredPolicyHash = recovered.policyHash ?? "";
    assert.ok(recoveredPolicyHash.length > 0);
  });

  it("handles approval inbox redelivery, resolved idempotency, filtering, and cleanup defaults", () => {
    const repo = new ApprovalInboxRepository(createDb("goatcitadel-loop28-approval-inbox"));
    const first = repo.receiveMcpApprovalDelivery({
      connectorId: "mcp:server-1",
      receiverId: "receiver-1",
      approvalId: "apr-1",
      tokenId: "tok-1",
      token: "grat_tok_1",
      approvalKind: "tool.invoke",
      riskLevel: "danger",
      approvalStatus: "pending",
      preview: { command: "run" },
      expiresAt: "2026-05-15T00:10:00.000Z",
      receivedAt: "2026-05-15T00:00:00.000Z",
    });
    const redelivered = repo.receiveMcpApprovalDelivery({
      connectorId: "mcp:server-1",
      receiverId: "receiver-1",
      approvalId: "apr-1",
      tokenId: "tok-1",
      token: "grat_tok_1",
      approvalKind: "tool.invoke",
      riskLevel: "danger",
      approvalStatus: "pending",
      preview: { command: "rerun" },
      expiresAt: "2026-05-15T00:20:00.000Z",
      receivedAt: "2026-05-15T00:05:00.000Z",
    });

    assert.equal(redelivered.inboxItemId, first.inboxItemId);
    assert.equal(redelivered.deliveryCount, 2);
    assert.deepEqual(redelivered.preview, { command: "rerun" });
    assert.equal(repo.listByReceiver("mcp", "receiver-1", { state: "pending", limit: 1 }).length, 1);
    assert.equal(repo.listByReceiver("mcp", "receiver-1").length, 1);
    assert.equal(repo.findByApprovalAndToken("apr-1", "tok-1")?.inboxItemId, first.inboxItemId);

    const resolved = repo.markResolved(first.inboxItemId, {
      state: "approved",
      approvalStatus: "approved",
      resolvedAt: "2026-05-15T00:06:00.000Z",
      resolvedBy: "operator",
      lastError: "denied by policy",
    });
    assert.equal(resolved.state, "approved");
    assert.equal(resolved.resolvedBy, "operator");
    assert.equal(resolved.lastError, "denied by policy");
    assert.equal(
      repo.receiveMcpApprovalDelivery({
        connectorId: "mcp:server-1",
        receiverId: "receiver-1",
        approvalId: "apr-1",
        tokenId: "tok-1",
        token: "grat_tok_1",
        approvalKind: "tool.invoke",
        riskLevel: "danger",
        approvalStatus: "pending",
        preview: { command: "ignored" },
        expiresAt: "2026-05-15T00:30:00.000Z",
        receivedAt: "2026-05-15T00:07:00.000Z",
      }).state,
      "approved",
    );
    assert.equal(repo.deleteByReceiver("mcp", "receiver-1"), 1);
    assert.equal(repo.deleteByReceiver("mcp", "receiver-1"), 0);
  });
});
