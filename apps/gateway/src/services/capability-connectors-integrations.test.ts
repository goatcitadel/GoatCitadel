import { describe, expect, it } from "vitest";
import type { IntegrationCatalogEntry } from "@goatcitadel/contracts";
import { createDefaultToolRegistry } from "@goatcitadel/policy-engine";
import { INTEGRATION_CATALOG } from "./integration-catalog.js";
import { CONNECTOR_INTEGRATION_CATALOG_IDS, isListedIntegration } from "./capability-connectors-integrations.js";

function catalogEntry(catalogId: string): IntegrationCatalogEntry {
  const entry = INTEGRATION_CATALOG.find((candidate) => candidate.catalogId === catalogId);
  if (!entry) {
    throw new Error(`${catalogId} is not in INTEGRATION_CATALOG`);
  }
  return entry;
}

describe("connector integration allowlist", () => {
  it("lists only catalog ids that exist and, for channels, have registry tools", () => {
    const toolNames = createDefaultToolRegistry()
      .list()
      .map((tool) => tool.name);

    for (const catalogId of CONNECTOR_INTEGRATION_CATALOG_IDS) {
      const entry = INTEGRATION_CATALOG.find((candidate) => candidate.catalogId === catalogId);
      expect(entry, `${catalogId} is in INTEGRATION_CATALOG`).toBeDefined();
      if (entry?.kind === "channel") {
        expect(
          toolNames.some((name) => name.startsWith(`${entry.key}.`)),
          `${catalogId} has a "${entry.key}.*" tool in the registry`,
        ).toBe(true);
      }
    }
  });

  it("lists every channel that has registry tools", () => {
    const toolNames = createDefaultToolRegistry()
      .list()
      .map((tool) => tool.name);
    const channelsWithTools = INTEGRATION_CATALOG.filter(
      (entry) => entry.kind === "channel" && toolNames.some((name) => name.startsWith(`${entry.key}.`)),
    );

    expect(channelsWithTools.length, "the registry has channel tools to compare against").toBeGreaterThan(0);
    for (const entry of channelsWithTools) {
      expect(
        CONNECTOR_INTEGRATION_CATALOG_IDS.has(entry.catalogId),
        `${entry.catalogId} has registry tools but is not listed`,
      ).toBe(true);
    }
  });

  it.each([
    "automation.gmail",
    "automation.imap-smtp",
    "automation.webhooks",
    "channel.discord",
    "channel.teams",
    "channel.signal",
    "channel.line",
    "channel.nextcloud-talk",
    "channel.google-chat",
  ])("lists %s", (catalogId) => {
    expect(isListedIntegration(catalogEntry(catalogId))).toBe(true);
  });

  it("skips model providers even when the id is in the set", () => {
    const provider = { ...catalogEntry("model_provider.openai"), catalogId: "automation.gmail" };

    expect(isListedIntegration(provider)).toBe(false);
  });

  it("skips catalog-only external connectors even when the id is in the set", () => {
    const external: IntegrationCatalogEntry = {
      ...catalogEntry("automation.gmail"),
      kind: "external_connector",
      externalConnector: {
        sourceId: "fixture-source",
        serviceId: "fixture-service",
        sourceCommit: "0000000",
        actionCount: 3,
        activeActionCount: 0,
        runtimePosture: "catalog_only",
        callable: false,
      },
    };

    expect(isListedIntegration(external)).toBe(false);
  });

  it.each(["productivity.notion", "channel.tui", "channel.webchat", "automation.cron", "model_provider.openai"])(
    "skips %s, which the AI cannot call through a connection",
    (catalogId) => {
      expect(isListedIntegration(catalogEntry(catalogId))).toBe(false);
    },
  );
});
