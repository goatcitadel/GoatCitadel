import { describe, expect, it } from "vitest";
import type { ChannelSetupDraft } from "@goatcitadel/contracts";
import { describeChannelCapabilities } from "@goatcitadel/gateway-core";
import { ADVERTISED_CHANNEL_PARITY_MATRIX } from "../../../../scripts/verification/lib/channel-parity-matrix.mjs";
import { listChannelSetupDefinitions, requireChannelSetupDefinition } from "./channel-setup-definitions.js";

function createDraft(catalogId: string, draft: Record<string, unknown>): ChannelSetupDraft {
  return {
    draftId: "22222222-2222-4222-8222-222222222222",
    catalogId,
    lifecycleMode: "create",
    enabled: true,
    draft,
    contentVersion: "matrix.content.v1",
    adapterVersion: "matrix.adapter.v1",
    validationVersion: "matrix.validation.v1",
    testVersion: "matrix.test.v1",
    createdAt: "2026-07-13T20:00:00.000Z",
    updatedAt: "2026-07-13T20:00:00.000Z",
  };
}

describe("advertised channel parity runtime matrix", () => {
  it.each(ADVERTISED_CHANNEL_PARITY_MATRIX)(
    "$id matches the callable capability projection",
    ({ id, channelKey, config, expected }) => {
      const capabilities = describeChannelCapabilities(channelKey, config);

      expect(capabilities.setupReady, id).toBe(true);
      expect(capabilities.runtimePosture, id).toMatchObject({
        outboundTransport: expected.outboundTransport,
        lifecycle: expected.lifecycle,
      });
      expect(capabilities.inboundModes, id).toEqual(expected.inboundModes);
      expect(capabilities.supportedAttachmentSources, id).toEqual(expected.attachmentSources);
      expect(capabilities.runtimePosture.operatorSummary.length, id).toBeGreaterThan(0);
      expect(capabilities.supportedActions, id).toContain("channel.activity");
    },
  );

  it("keeps the advertised setup catalog and parity matrix in exact set equality", () => {
    const setupCatalogIds = [
      ...new Set(listChannelSetupDefinitions().map((definition) => definition.catalog.catalogId)),
    ].sort();
    const matrixCatalogIds = [...new Set(ADVERTISED_CHANNEL_PARITY_MATRIX.map((row) => row.catalogId))].sort();

    expect(matrixCatalogIds).toEqual(setupCatalogIds);
  });

  it("keeps the Google Chat webhook row outbound-only and the Chat app row inbound with default-deny setup", () => {
    const webhookRow = ADVERTISED_CHANNEL_PARITY_MATRIX.find((row) => row.id === "google-chat.webhook");
    const appRow = ADVERTISED_CHANNEL_PARITY_MATRIX.find((row) => row.id === "google-chat.app-service-account");
    const definition = requireChannelSetupDefinition("channel.google-chat");

    expect(webhookRow?.expected).toMatchObject({ inboundModes: ["none"], outboundTransport: "webhook" });
    expect(describeChannelCapabilities("google-chat", webhookRow?.config ?? {}).supportedActions).not.toContain(
      "channel.unsend",
    );
    expect(definition.validate(createDraft("channel.google-chat", { ...webhookRow?.config }))).toEqual([]);

    expect(appRow?.expected).toMatchObject({ inboundModes: ["webhook"], outboundTransport: "api" });
    expect(describeChannelCapabilities("google-chat", appRow?.config ?? {}).supportedActions).toEqual(
      expect.arrayContaining(["channel.send", "channel.reply", "channel.unsend"]),
    );
    const appDraft = createDraft("channel.google-chat", { ...appRow?.config });
    expect(definition.validate(appDraft)).toEqual([]);
    expect(definition.normalize(appDraft)).toMatchObject({ inboundAccessMode: "allowlist" });
  });
});
