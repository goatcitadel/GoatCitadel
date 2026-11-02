import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import { pluginItemHref } from "./plugin-links";

/**
 * "From <plugin>" on a piece a plugin added, in the other tabs: a link to that plugin's panel on the Plugins tab, where
 * it is uninstalled. Which plugin a piece came from is GoatCitadel's to say; this only words and links it.
 */
export function FromPluginLink({
  plugin,
  className,
}: {
  plugin: { pluginId: string; name: string };
  className?: string;
}) {
  return (
    <NativeOwnerLink scope={plugin.pluginId} href={pluginItemHref(plugin.pluginId)} className={className}>
      {`From ${plugin.name}`}
    </NativeOwnerLink>
  );
}

/** The link that goes with a sentence about a plugin, such as GoatCitadel's refusal of a change to one of its pieces. */
export function OpenInPluginsLink({ pluginId, className }: { pluginId: string; className?: string }) {
  return (
    <NativeOwnerLink scope={pluginId} href={pluginItemHref(pluginId)} className={className}>
      Open in Plugins
    </NativeOwnerLink>
  );
}
