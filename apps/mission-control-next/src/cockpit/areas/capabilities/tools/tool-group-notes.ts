import type { ToolGroupId } from "@goatcitadel/contracts";

/**
 * What switching a group off does not stop, for the four groups where it would surprise someone (P2-R36). The switch
 * keeps the AI from calling a group's tools in chats. These groups also work in the background, or in chat apps, by a
 * path the switch doesn't govern, and a note under the switch says so rather than letting "Off" promise too much.
 * This is presentation copy only; what each group does is the Gateway's to say.
 */
export const TOOL_GROUP_NOTES: Readonly<Partial<Record<ToolGroupId, string>>> = {
  memory: "Switching off doesn't stop the memory GoatCitadel adds to chats on its own.",
  documents: "Switching off doesn't stop GoatCitadel reading files you attach to a chat.",
  subagents: "Switching off doesn't stop GoatCitadel splitting a plan into parts on its own.",
  messaging: "Replies in your chat apps keep working. Notifications to your chat apps pause while this is off.",
};
