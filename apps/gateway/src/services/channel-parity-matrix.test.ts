import { describe, expect, it } from "vitest";
import type { ChannelSetupDraft, IntegrationConnection } from "@goatcitadel/contracts";
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

function createConnection(catalogId: string, key: string, config: Record<string, unknown>): IntegrationConnection {
  return {
    connectionId: "11111111-1111-4111-8111-111111111111",
    catalogId,
    kind: "channel",
    key,
    label: key,
    enabled: true,
    status: "connected",
    config,
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

  it("keeps stale Signal inbound flags non-callable and strips them from edit normalization", () => {
    const signalRow = ADVERTISED_CHANNEL_PARITY_MATRIX.find((row) => row.id === "signal.bridge-outbound");
    expect(signalRow).toBeDefined();
    const signal = requireChannelSetupDefinition("channel.signal");
    const hydrated = signal.hydrate(
      createConnection("channel.signal", "signal", {
        ...signalRow?.config,
        inboundEnabled: true,
        pollIntervalSeconds: 5,
      }),
    );

    expect(hydrated.draft).not.toHaveProperty("inboundEnabled");
    expect(hydrated.draft).not.toHaveProperty("pollIntervalSeconds");
    expect(hydrated.hydration.warnings).toEqual([expect.stringContaining("blocked")]);
    expect(
      signal.validate(
        createDraft("channel.signal", {
          baseUrl: "http://127.0.0.1:8080",
          defaultRecipient: "+15557654321",
          inboundEnabled: true,
          pollIntervalSeconds: 5,
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fieldKey: "inboundEnabled", failureCategory: "malformed_value" }),
        expect.objectContaining({ fieldKey: "pollIntervalSeconds", failureCategory: "malformed_value" }),
      ]),
    );
  });

  it("keeps BlueBubbles callable setup distinct from Photon/Spectrum diagnostic metadata", () => {
    const definition = requireChannelSetupDefinition("channel.imessage");
    const blueBubbles = ADVERTISED_CHANNEL_PARITY_MATRIX.find((row) => row.id === "imessage.bluebubbles");
    const photon = ADVERTISED_CHANNEL_PARITY_MATRIX.find((row) => row.id === "imessage.photon-diagnostics");

    expect(blueBubbles?.callability).toBe("callable");
    expect(definition.validate(createDraft("channel.imessage", blueBubbles?.config ?? {}))).toEqual([]);
    expect(photon?.callability).toBe("diagnostic_only");
    expect(definition.validate(createDraft("channel.imessage", photon?.config ?? {}))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "imessage_photon_preview",
          fieldKey: "bridgeProvider",
          message: expect.stringContaining("blocks Photon sends"),
        }),
      ]),
    );
  });
});
