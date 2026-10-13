import type { IntegrationChannelService } from "./integration-channel-service.js";
import type { ChannelSetupHost } from "./channel-setup-service.js";
import * as channelSetupService from "./channel-setup-service.js";
import { INTEGRATION_CATALOG, getIntegrationFormSchema } from "./integration-catalog.js";
import { projectIntegrationConfigurationGuidance } from "./integration-configuration-guidance.js";
/** Optional author guidance annotates existing fields; it cannot create runtime authority. */
export function createChannelSetupGuidancePort(
  integrationChannel: Pick<IntegrationChannelService, "listIntegrationPlugins">,
  channelSetupDeps: ChannelSetupHost,
) {
  return {
    getChannelSetupDefinition: async (catalogId: string) => {
      const definition = channelSetupService.getChannelSetupDefinition(channelSetupDeps, catalogId);
      const catalog = INTEGRATION_CATALOG.find((entry) => entry.catalogId === catalogId);
      const guidance =
        catalog?.formSchema &&
        projectIntegrationConfigurationGuidance(
          catalog.formSchema,
          catalog,
          catalog.pluginId ? await integrationChannel.listIntegrationPlugins() : [],
        ).configurationGuidance;
      return guidance ? { ...definition, configurationGuidance: { ...guidance, supportedFieldKeys: [] } } : definition;
    },
    listChannelSetupDefinitions: async () => {
      const plugins = await integrationChannel.listIntegrationPlugins();
      return channelSetupService.listChannelSetupDefinitions(channelSetupDeps).map((definition) => {
        const catalog = INTEGRATION_CATALOG.find((entry) => entry.catalogId === definition.catalog.catalogId);
        const guidance =
          catalog?.formSchema &&
          projectIntegrationConfigurationGuidance(catalog.formSchema, catalog, plugins).configurationGuidance;
        return guidance
          ? { ...definition, configurationGuidance: { ...guidance, supportedFieldKeys: [] } }
          : definition;
      });
    },
  };
}

export function createIntegrationFormGuidancePort(
  integrationChannel: Pick<IntegrationChannelService, "listIntegrationPlugins">,
) {
  return {
    getIntegrationFormSchema: async (catalogId: string) => {
      if (catalogId.startsWith("external_connector.")) {
        throw new Error(
          `External connector catalog entries are review-only and do not expose connection forms: ${catalogId}`,
        );
      }
      const schema = getIntegrationFormSchema(catalogId);
      if (!schema) {
        throw new Error(`Unknown integration catalog id: ${catalogId}`);
      }
      const catalog = INTEGRATION_CATALOG.find((entry) => entry.catalogId === catalogId);
      return projectIntegrationConfigurationGuidance(
        schema,
        catalog,
        catalog?.pluginId ? await integrationChannel.listIntegrationPlugins() : [],
      );
    },
  };
}
