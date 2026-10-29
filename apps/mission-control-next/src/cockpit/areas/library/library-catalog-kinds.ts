import type { CapabilityCatalogEntry, CapabilityKind } from "@goatcitadel/contracts";

/**
 * Which kinds the Library catalog lists. Skills and tools are listed in Capabilities, so the Library keeps what has no
 * home there: candidates, proposals, Code Mode and the entries a mesh publishes. This only narrows what the page
 * shows; the Gateway's catalog still holds every kind. A new kind fails to compile here until it is placed.
 */
const LISTED_IN_LIBRARY: Record<CapabilityKind, boolean> = {
  tool: false,
  skill: false,
  code_mode: true,
  proposal: true,
  candidate_skill: true,
  mesh_tool: true,
  mesh_mcp_server: true,
  mesh_skill: true,
};

export function isLibraryCapabilityKind(kind: string): boolean {
  return (LISTED_IN_LIBRARY as Record<string, unknown>)[kind] === true;
}

export function libraryCatalogItems(items: readonly CapabilityCatalogEntry[]): CapabilityCatalogEntry[] {
  return items.filter((item) => isLibraryCapabilityKind(item.kind));
}
