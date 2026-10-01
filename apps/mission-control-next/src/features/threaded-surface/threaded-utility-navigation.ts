import { FileText, Folder, PanelRight, Play, Settings2 } from "lucide-react";

export type ThreadedUtilityPanelId =
  | "preview"
  | "context"
  | "artifacts"
  | "session"
  | "trace"
  | "assist"
  | "diff"
  | "terminal"
  | "files"
  | "background"
  | "plan"
  | "status";

export type ThreadedUtilityTabId = "activity" | "context" | "outputs" | "settings";

export type ThreadedUtilityTabMeta = {
  id: ThreadedUtilityTabId;
  panel: ThreadedUtilityPanelId;
  label: string;
  icon: typeof PanelRight;
};

export const UTILITY_TAB_ITEMS: ThreadedUtilityTabMeta[] = [
  { id: "activity", panel: "preview", label: "Activity", icon: Play },
  { id: "context", panel: "context", label: "Context", icon: FileText },
  { id: "outputs", panel: "artifacts", label: "Outputs", icon: Folder },
  { id: "settings", panel: "session", label: "Chat settings", icon: Settings2 },
];

export function getUtilityTab(panel: ThreadedUtilityPanelId): ThreadedUtilityTabId {
  if (panel === "context") return "context";
  if (panel === "artifacts" || panel === "diff" || panel === "files") return "outputs";
  if (panel === "session" || panel === "assist") return "settings";
  return "activity";
}
