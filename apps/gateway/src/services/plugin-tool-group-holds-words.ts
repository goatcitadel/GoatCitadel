/**
 * Chat's plain words while GoatCitadel can't read which tool groups plugins keep off: the plugin records couldn't be
 * read, so the policy engine keeps every tool in a group a plugin could hold off (`plugin_tool_group_holds_unavailable`)
 * until they can be. Chat's failure guidance, its base prompt and its capability scout all say it in these words, so the
 * copy guard reads this file.
 */

/** The one plain sentence, said wherever such a tool's denial reaches Chat. */
export const PLUGIN_HOLDS_UNREADABLE =
  "GoatCitadel can't read which tool groups plugins keep off, so it keeps those tools off until it can.";

/** The "Why:" line for a tool that is off for that reason: no approval or other input lifts it. */
export function pluginHoldsUnreadableGuidance(tool: string): string {
  return `${tool} is off. ${PLUGIN_HOLDS_UNREADABLE} This is not a pending approval, and different input will not help; tell the operator which tool you needed.`;
}

/** The closing line when every block was that. */
export const PLUGIN_HOLDS_UNREADABLE_CLOSING =
  "Once GoatCitadel can read which tool groups plugins keep off, ask again and I'll retry.";

/** Added to another closing when only some blocks were that. */
export const PLUGIN_HOLDS_UNREADABLE_ALSO =
  "GoatCitadel keeps the other tools off until it can read which tool groups plugins keep off.";

/** The base prompt's remedy for a write-and-run tool that is off for that reason: nothing lifts it in this turn. */
export const PLUGIN_HOLDS_UNREADABLE_REMEDY = `try again later: ${PLUGIN_HOLDS_UNREADABLE}`;
