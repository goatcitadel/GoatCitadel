import { TOOL_GROUPS, type CapabilityToolBlock, type ToolGroupId } from "@goatcitadel/contracts";

/** The Tools tab, without a panel open. */
export const TOOLS_HREF = "/capabilities/tools";

/**
 * The inspector source of a group's panel. It must never start with the Connectors panel's `capabilities:`: the
 * Connectors tab reads every source that does as one of its connectors, and a Tools panel would be taken for one.
 */
export const TOOL_PANEL_SOURCE_PREFIX = "capabilities-tools:";

/** The part of `?item=` that tells a tool group from a connector. */
const ITEM_PREFIX = "group:";

function toolGroupIdOf(value: string | null | undefined): ToolGroupId | undefined {
  return TOOL_GROUPS.find((group) => group.id === value)?.id;
}

/** The address that opens one group's panel. */
export function toolGroupItemHref(groupId: ToolGroupId): string {
  return `${TOOLS_HREF}?item=${encodeURIComponent(`${ITEM_PREFIX}${groupId}`)}`;
}

/**
 * The group an address names with `?item=group:<id>`, or undefined for anything else, an unknown id included. Whether
 * the loaded list holds the group is for the list to say.
 */
export function toolGroupIdFromSearch(search: string | undefined): ToolGroupId | undefined {
  const item = new URLSearchParams(search ?? "").get("item");
  return item?.startsWith(ITEM_PREFIX) ? toolGroupIdOf(item.slice(ITEM_PREFIX.length)) : undefined;
}

/** The inspector source of one group's panel. */
export function toolPanelSource(groupId: ToolGroupId): string {
  return `${TOOL_PANEL_SOURCE_PREFIX}${groupId}`;
}

/** The group inside an inspector source, or undefined when the source is another panel's (a connector's included). */
export function toolGroupIdFromSource(source: string | undefined): ToolGroupId | undefined {
  return source?.startsWith(TOOL_PANEL_SOURCE_PREFIX)
    ? toolGroupIdOf(source.slice(TOOL_PANEL_SOURCE_PREFIX.length))
    : undefined;
}

// Where each rule that blocks a tool is changed in Settings. Every hash is one SettingsArea accepts (a test renders
// each one), so a link never lands on "this link does not match a section".
const PERMISSION_PROFILE_HREF = "/settings/safety#permission-profile";
const APPROVAL_MODE_HREF = "/settings/safety#approval-mode";
const WRITE_ROOTS_HREF = "/settings/safety#filesystem-write-roots";
const CITADEL_WARDS_HREF = "/settings/citadel#citadel-wards";

/** Where the detailed safety rules live, for the pointer under the tool list. */
export const SAFETY_RULES_HREF = PERMISSION_PROFILE_HREF;

/**
 * Where to change the rule that blocks a tool. Your safety rules are the deny list: the folders Files may write to
 * are where that list is edited for the file tools, and the permission profile is where it is explained for the rest.
 * The install's own setup shows beside the approval mode. A sixth block fails to compile here.
 */
export function toolBlockHref(block: CapabilityToolBlock, groupId: ToolGroupId): string {
  switch (block) {
    case "safety_rules":
      return groupId === "files" ? WRITE_ROOTS_HREF : PERMISSION_PROFILE_HREF;
    case "permission_profile":
      return PERMISSION_PROFILE_HREF;
    case "grant":
    case "install_profile":
      return APPROVAL_MODE_HREF;
    case "citadel_ward":
      return CITADEL_WARDS_HREF;
  }
}
