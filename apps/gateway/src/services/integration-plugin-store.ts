import type { IntegrationPluginRecord } from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";

const INTEGRATION_PLUGINS_SETTING_KEY = "integration_plugins_v1";

type IntegrationPluginStorage = Pick<Storage, "systemSettings">;

export async function readIntegrationPlugins(storage: IntegrationPluginStorage): Promise<IntegrationPluginRecord[]> {
  const stored = (await storage.systemSettings.get<IntegrationPluginRecord[]>(INTEGRATION_PLUGINS_SETTING_KEY))?.value;
  if (!Array.isArray(stored)) {
    return [];
  }
  return stored.filter((item): item is IntegrationPluginRecord => Boolean(item?.pluginId));
}

export async function writeIntegrationPlugins(
  storage: IntegrationPluginStorage,
  plugins: IntegrationPluginRecord[],
): Promise<void> {
  await storage.systemSettings.set(INTEGRATION_PLUGINS_SETTING_KEY, plugins);
}
