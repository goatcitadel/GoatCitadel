import type { IntegrationPluginRecord } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";

const INTEGRATION_PLUGINS_SETTING_KEY = "integration_plugins_v1";

type IntegrationPluginStorage = Pick<Storage, "systemSettings">;

export function readIntegrationPlugins(storage: IntegrationPluginStorage): IntegrationPluginRecord[] {
  const stored = storage.systemSettings.get<IntegrationPluginRecord[]>(INTEGRATION_PLUGINS_SETTING_KEY)?.value;
  if (!Array.isArray(stored)) {
    return [];
  }
  return stored.filter((item): item is IntegrationPluginRecord => Boolean(item?.pluginId));
}

export function writeIntegrationPlugins(storage: IntegrationPluginStorage, plugins: IntegrationPluginRecord[]): void {
  storage.systemSettings.set(INTEGRATION_PLUGINS_SETTING_KEY, plugins);
}
