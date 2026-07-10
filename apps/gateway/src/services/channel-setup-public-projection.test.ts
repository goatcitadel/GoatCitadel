import { describe, expect, it } from "vitest";
import type { ChannelSetupDraft, ChannelSetupValidationResult } from "@goatcitadel/contracts";
import {
  preserveChannelSetupDraftSecretsForPublicUpdate,
  projectChannelSetupDraftForPublicResponse,
  projectChannelSetupValidationResultForPublicResponse,
} from "./channel-setup-public-projection.js";

function createDraft(): ChannelSetupDraft {
  return {
    draftId: "draft-1",
    catalogId: "channel.custom",
    lifecycleMode: "repair",
    label: "Custom channel",
    enabled: true,
    draft: {
      endpoint: "https://callback.example.test/token/channel-short?mode=events",
      channelId: "C-OLD",
    },
    contentVersion: "content-1",
    adapterVersion: "adapter-1",
    validationVersion: "validation-1",
    testVersion: "test-1",
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
  };
}

describe("channel setup public projection", () => {
  it("projects credential-bearing URL paths without mutating the raw draft", () => {
    const draft = createDraft();

    const projected = projectChannelSetupDraftForPublicResponse(draft);

    expect(projected.draft.endpoint).toBe("https://callback.example.test/token/[REDACTED]?mode=events");
    expect(draft.draft.endpoint).toBe("https://callback.example.test/token/channel-short?mode=events");
  });

  it("round-trips projected URL path markers while retaining safe draft and scalar edits", () => {
    const draft = createDraft();

    const update = preserveChannelSetupDraftSecretsForPublicUpdate(draft, {
      label: "Renamed channel",
      enabled: false,
      draft: {
        endpoint: "https://callback.example.test/token/[REDACTED]?mode=alerts",
        channelId: "C-NEXT",
      },
    });

    expect(update).toEqual({
      label: "Renamed channel",
      enabled: false,
      draft: {
        endpoint: "https://callback.example.test/token/channel-short?mode=alerts",
        channelId: "C-NEXT",
      },
    });
  });

  it("projects credential-bearing URLs embedded in validation DTO text", () => {
    const result: ChannelSetupValidationResult = {
      draftId: "draft-1",
      status: "error",
      levels: ["structural"],
      issues: [
        {
          key: "probe_failed",
          level: "error",
          message: "Probe failed",
          detail: "Inspect https://callback.example.test/secret/channel-short for details",
        },
      ],
      checkedAt: "2026-07-09T00:00:00.000Z",
    };

    const projected = projectChannelSetupValidationResultForPublicResponse(result);

    expect(projected.issues[0]?.detail).toBe("Inspect https://callback.example.test/secret/[REDACTED] for details");
    expect(result.issues[0]?.detail).toContain("channel-short");
  });
});
