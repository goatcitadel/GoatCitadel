// How a plugin's prompt packs are named and labelled when they are saved. The inspection shows these and the install
// saves them, from the same functions, so the panel shows the name that gets saved.

/** The id an install gives a plugin's prompt pack. Only that install creates a pack with it. */
export function pluginPromptPackId(pluginId: string, pieceId: string): string {
  return `plugin-${pluginId}-${pieceId}`;
}

/** The source label a plugin's prompt pack is saved with. */
export function pluginPromptPackSourceLabel(pluginName: string): string {
  return `Plugin ${pluginName}`;
}

/**
 * The name each of a plugin's prompt packs is saved under, by piece id: its own name, unless two of the plugin's packs
 * would share one (ignoring case and the spaces at either end). Then each of those gets its piece id as well, as
 * "<name> · <piece id>", so every pack the plugin adds has a name of its own.
 */
export function distinctPluginPromptPackNames(
  packs: readonly { readonly pieceId: string; readonly name: string }[],
): Map<string, string> {
  const uses = new Map<string, number>();
  for (const pack of packs) uses.set(nameKey(pack.name), (uses.get(nameKey(pack.name)) ?? 0) + 1);
  return new Map(
    packs.map((pack) => [
      pack.pieceId,
      (uses.get(nameKey(pack.name)) ?? 0) > 1 ? `${pack.name.trim()} · ${pack.pieceId}` : pack.name,
    ]),
  );
}

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}
