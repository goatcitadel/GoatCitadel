import { describe, expect, it } from "vitest";
import type { ChannelSetupDraft, ChannelSetupTestResult, IntegrationConnection } from "@goatcitadel/contracts";
import {
  buildChannelSetupRecentTestSignature,
  resolveReusableChannelSetupTestResult,
} from "./channel-setup-test-cache.js";

describe("channel setup recent-test cache", () => {
  it("reuses a cached non-error result when the effective connection shape matches", () => {
    const draft = createDraft();
    const connection = createConnection();
    const result = createTestResult("warn");
    const cache = new Map([
      [
        draft.draftId,
        {
          signature: buildChannelSetupRecentTestSignature(draft, connection, draft.testVersion),
          result,
        },
      ],
    ]);

    const reusable = resolveReusableChannelSetupTestResult({
      cache,
      draft,
      connection,
      testVersion: draft.testVersion,
    });

    expect(reusable).toBe(result);
    expect(cache.size).toBe(1);
  });

  it("rebinds reusable evidence when only the draft revision advanced", () => {
    const draft = createDraft();
    const connection = createConnection();
    const result = createTestResult("ok", draft.revision - 1);
    const cache = new Map([
      [
        draft.draftId,
        {
          signature: buildChannelSetupRecentTestSignature(draft, connection, draft.testVersion),
          result,
        },
      ],
    ]);

    const reusable = resolveReusableChannelSetupTestResult({
      cache,
      draft,
      connection,
      testVersion: draft.testVersion,
    });

    expect(reusable).not.toBe(result);
    expect(reusable).toEqual({ ...result, draftRevision: draft.revision });
    expect(cache.size).toBe(1);
  });

  it("invalidates a stale cached result when the effective connection config changes", () => {
    const draft = createDraft();
    const originalConnection = createConnection();
    const cache = new Map([
      [
        draft.draftId,
        {
          signature: buildChannelSetupRecentTestSignature(draft, originalConnection, draft.testVersion),
          result: createTestResult("ok"),
        },
      ],
    ]);
    const changedConnection = createConnection({
      config: {
        token: "xoxb-test",
        channelId: "C999",
      },
    });

    const reusable = resolveReusableChannelSetupTestResult({
      cache,
      draft,
      connection: changedConnection,
      testVersion: draft.testVersion,
    });

    expect(reusable).toBeUndefined();
    expect(cache.has(draft.draftId)).toBe(false);
  });

  it("never reuses cached error results", () => {
    const draft = createDraft();
    const connection = createConnection();
    const cache = new Map([
      [
        draft.draftId,
        {
          signature: buildChannelSetupRecentTestSignature(draft, connection, draft.testVersion),
          result: createTestResult("error"),
        },
      ],
    ]);

    const reusable = resolveReusableChannelSetupTestResult({
      cache,
      draft,
      connection,
      testVersion: draft.testVersion,
    });

    expect(reusable).toBeUndefined();
    expect(cache.has(draft.draftId)).toBe(true);
  });
});

function createDraft(): ChannelSetupDraft {
  return {
    draftId: "draft-1",
    revision: 3,
    catalogId: "slack",
    lifecycleMode: "create",
    label: "Slack Alerts",
    enabled: true,
    draft: {},
    secretState: {},
    contentVersion: "content-v1",
    adapterVersion: "adapter-v1",
    validationVersion: "validation-v1",
    testVersion: "test-v1",
    createdAt: "2026-03-29T08:00:00.000Z",
    updatedAt: "2026-03-29T08:05:00.000Z",
  };
}

function createConnection(overrides?: Partial<IntegrationConnection>): IntegrationConnection {
  return {
    connectionId: "conn-1",
    catalogId: "slack",
    kind: "channel",
    key: "slack",
    label: "Slack Alerts",
    enabled: true,
    status: "connected",
    config: {
      token: "xoxb-test",
      channelId: "C123",
    },
    createdAt: "2026-03-29T08:00:00.000Z",
    updatedAt: "2026-03-29T08:12:00.000Z",
    ...overrides,
  };
}

function createTestResult(status: ChannelSetupTestResult["status"], draftRevision = 3): ChannelSetupTestResult {
  return {
    draftId: "draft-1",
    draftRevision,
    status,
    levels: ["structural", "semantic", "live-auth", "live-send"],
    issues: [],
    checkedAt: "2026-03-29T08:12:00.000Z",
    recommendedNextAction: "Finalize the connection.",
  };
}
