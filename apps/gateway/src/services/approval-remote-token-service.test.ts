import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Storage } from "@goatcitadel/storage";
import { hashSensitiveToken } from "./device-access-helpers.js";
import {
  consumeRemoteActionToken,
  consumeRemoteActionTokenById,
  type ApprovalRemoteTokenHost,
} from "./approval-remote-token-service.js";

const NOW = "2026-07-10T12:00:00.000Z";

interface Harness {
  storage: Storage;
  host: ApprovalRemoteTokenHost;
  deleteRemoteActionTokenSecretById: ReturnType<typeof vi.fn>;
  cleanup(): void;
}

function createHarness(): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-remote-token-claim-"));
  const storage = new Storage({
    dbPath: ":memory:",
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  const deleteRemoteActionTokenSecretById = vi.fn();
  return {
    storage,
    host: { storage, approvalRemoteTokenSecrets: { deleteById: deleteRemoteActionTokenSecretById } },
    deleteRemoteActionTokenSecretById,
    cleanup: () => {
      storage.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function issueApprovalToken(
  harness: Harness,
  rawToken: string,
  expiresAt = "2099-07-10T13:00:00.000Z",
  connectorId = "mission-control",
) {
  return harness.storage.remoteActionTokens.create({
    tokenHash: hashSensitiveToken(rawToken),
    actionType: "approval.resolve",
    approvalId: "approval-1",
    connectorId,
    mutation: { approvalId: "approval-1" },
    expiresAt,
  });
}

describe("approval remote token request claims", () => {
  const harnesses: Harness[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    for (const harness of harnesses.splice(0)) {
      harness.cleanup();
    }
    vi.useRealTimers();
  });

  it("resumes a raw-token claim only for the same request fingerprint", async () => {
    const harness = createHarness();
    harnesses.push(harness);
    issueApprovalToken(harness, "grat_raw_token");

    const first = await consumeRemoteActionToken(harness.host, " grat_raw_token ", "approval.resolve", {
      claimFingerprint: "sha256:approve-request",
      expectedConnectorId: "mission-control",
    });
    vi.setSystemTime(new Date("2026-07-10T12:05:00.000Z"));
    const resumed = await consumeRemoteActionToken(harness.host, "grat_raw_token", "approval.resolve", {
      claimFingerprint: "sha256:approve-request",
      expectedConnectorId: "mission-control",
    });

    expect(first.state).toBe("consumed");
    expect(resumed).toEqual(first);
    expect(resumed.consumedAt).toBe(first.consumedAt);
    expect(resumed.mutation).toEqual({
      approvalId: "approval-1",
      __remoteActionClaimFingerprint: "sha256:approve-request",
    });
    await expect(
      consumeRemoteActionToken(harness.host, "grat_raw_token", "approval.resolve", {
        claimFingerprint: "sha256:deny-request",
        expectedConnectorId: "mission-control",
      }),
    ).rejects.toThrow(/claimed by a different request/);
  });

  it("resumes the same request through the opaque token id", async () => {
    const harness = createHarness();
    harnesses.push(harness);
    const token = issueApprovalToken(harness, "grat_token_by_id");

    const first = await consumeRemoteActionTokenById(harness.host, ` ${token.tokenId} `, "approval.resolve", {
      claimFingerprint: "sha256:edited-request",
      expectedConnectorId: "mission-control",
    });
    const resumed = await consumeRemoteActionTokenById(harness.host, token.tokenId, "approval.resolve", {
      claimFingerprint: "sha256:edited-request",
      expectedConnectorId: "mission-control",
    });

    expect(first.state).toBe("consumed");
    expect(resumed).toEqual(first);
    await expect(
      consumeRemoteActionTokenById(harness.host, token.tokenId, "approval.resolve", {
        claimFingerprint: "sha256:other-edit",
        expectedConnectorId: "mission-control",
      }),
    ).rejects.toThrow(/claimed by a different request/);
  });

  it("rejects an opaque token id from the wrong connector before claiming it", async () => {
    const harness = createHarness();
    harnesses.push(harness);
    const token = issueApprovalToken(harness, "grat_connector_bound");

    await expect(
      consumeRemoteActionTokenById(harness.host, token.tokenId, "approval.resolve", {
        claimFingerprint: "sha256:wrong-connector",
        expectedConnectorId: "integration:other-channel",
      }),
    ).rejects.toThrow(/connector/i);
    expect(harness.storage.remoteActionTokens.get(token.tokenId).state).toBe("pending");
  });

  it("rejects a connector-bound raw token when the caller omits the connector binding", async () => {
    const harness = createHarness();
    harnesses.push(harness);
    const token = issueApprovalToken(
      harness,
      "grat_missing_connector_binding",
      "2099-07-10T13:00:00.000Z",
      "integration:conn-telegram",
    );

    await expect(
      consumeRemoteActionToken(harness.host, "grat_missing_connector_binding", "approval.resolve", {
        claimFingerprint: "sha256:missing-connector",
      }),
    ).rejects.toThrow(/connector binding/i);
    expect(harness.storage.remoteActionTokens.get(token.tokenId).state).toBe("pending");
  });

  it("rejects integration-bound raw tokens at the browser ingress while accepting browser tokens", async () => {
    const harness = createHarness();
    harnesses.push(harness);
    const integrationToken = issueApprovalToken(
      harness,
      "grat_integration_bound",
      "2099-07-10T13:00:00.000Z",
      "integration:conn-telegram",
    );
    const browserToken = issueApprovalToken(
      harness,
      "grat_browser_bound",
      "2099-07-10T13:00:00.000Z",
      "browser:mission-control",
    );

    await expect(
      consumeRemoteActionToken(harness.host, "grat_integration_bound", "approval.resolve", {
        expectedConnectorId: "browser:mission-control",
      }),
    ).rejects.toThrow(/connector/i);
    expect(harness.storage.remoteActionTokens.get(integrationToken.tokenId).state).toBe("pending");

    await expect(
      consumeRemoteActionToken(harness.host, "grat_browser_bound", "approval.resolve", {
        expectedConnectorId: "browser:mission-control",
      }),
    ).resolves.toMatchObject({ tokenId: browserToken.tokenId, state: "consumed" });
  });

  it("preserves strict single-use behavior when no claim fingerprint is supplied", async () => {
    const harness = createHarness();
    harnesses.push(harness);
    issueApprovalToken(harness, "grat_legacy_token");

    await expect(
      consumeRemoteActionToken(harness.host, "grat_legacy_token", "approval.resolve", {
        expectedConnectorId: "mission-control",
      }),
    ).resolves.toMatchObject({ state: "consumed" });
    await expect(
      consumeRemoteActionToken(harness.host, "grat_legacy_token", "approval.resolve", {
        expectedConnectorId: "mission-control",
      }),
    ).rejects.toThrow(/already been consumed/);
  });

  it("expires a pending token before any resumable claim can be recorded", async () => {
    const harness = createHarness();
    harnesses.push(harness);
    const token = issueApprovalToken(harness, "grat_expired_token", "2026-07-10T11:59:59.000Z");

    await expect(
      consumeRemoteActionToken(harness.host, "grat_expired_token", "approval.resolve", {
        claimFingerprint: "sha256:too-late",
        expectedConnectorId: "mission-control",
      }),
    ).rejects.toThrow(/has expired/);
    expect(harness.deleteRemoteActionTokenSecretById).toHaveBeenCalledWith(token.tokenId);
    expect(harness.storage.remoteActionTokens.get(token.tokenId)).toMatchObject({
      state: "expired",
      mutation: { approvalId: "approval-1" },
    });
    await expect(
      consumeRemoteActionTokenById(harness.host, token.tokenId, "approval.resolve", {
        claimFingerprint: "sha256:too-late",
        expectedConnectorId: "mission-control",
      }),
    ).rejects.toThrow(/has expired/);
  });

  it("keeps an expired token pending until keychain cleanup succeeds", async () => {
    const harness = createHarness();
    harnesses.push(harness);
    const token = issueApprovalToken(harness, "grat_expired_cleanup_retry", "2026-07-10T11:59:59.000Z");
    harness.deleteRemoteActionTokenSecretById.mockImplementationOnce(() => {
      throw new Error("keychain temporarily unavailable");
    });

    await expect(
      consumeRemoteActionToken(harness.host, "grat_expired_cleanup_retry", "approval.resolve", {
        expectedConnectorId: "mission-control",
      }),
    ).rejects.toThrow(/keychain temporarily unavailable/i);
    expect(harness.storage.remoteActionTokens.get(token.tokenId).state).toBe("pending");

    await expect(
      consumeRemoteActionToken(harness.host, "grat_expired_cleanup_retry", "approval.resolve", {
        expectedConnectorId: "mission-control",
      }),
    ).rejects.toThrow(/has expired/i);
    expect(harness.storage.remoteActionTokens.get(token.tokenId).state).toBe("expired");
    expect(harness.deleteRemoteActionTokenSecretById).toHaveBeenCalledTimes(2);
  });

  it("consumes a database-fresh token even when the host clock is far ahead", async () => {
    const harness = createHarness();
    harnesses.push(harness);
    const token = issueApprovalToken(harness, "grat_fast_host_clock");
    harness.storage.gatewaySql
      .prepare(
        "UPDATE remote_action_tokens SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 minute') WHERE token_id = ?",
      )
      .run(token.tokenId);
    vi.setSystemTime(new Date("2100-07-10T12:00:00.000Z"));

    const consumed = await consumeRemoteActionToken(harness.host, "grat_fast_host_clock", "approval.resolve", {
      claimFingerprint: "sha256:fast-host",
      expectedConnectorId: "mission-control",
    });

    expect(consumed.state).toBe("consumed");
    expect(harness.deleteRemoteActionTokenSecretById).not.toHaveBeenCalled();
  });

  it("rejects and expires a database-expired token even when the host clock is far behind", async () => {
    const harness = createHarness();
    harnesses.push(harness);
    const token = issueApprovalToken(harness, "grat_slow_host_clock");
    harness.storage.gatewaySql
      .prepare(
        "UPDATE remote_action_tokens SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minute') WHERE token_id = ?",
      )
      .run(token.tokenId);
    vi.setSystemTime(new Date("2000-07-10T12:00:00.000Z"));

    await expect(
      consumeRemoteActionToken(harness.host, "grat_slow_host_clock", "approval.resolve", {
        claimFingerprint: "sha256:slow-host",
        expectedConnectorId: "mission-control",
      }),
    ).rejects.toThrow(/has expired/);
    expect(harness.storage.remoteActionTokens.get(token.tokenId).state).toBe("expired");
    expect(harness.deleteRemoteActionTokenSecretById).toHaveBeenCalledWith(token.tokenId);
  });
});
