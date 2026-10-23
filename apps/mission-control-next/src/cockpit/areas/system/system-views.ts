/** System's tabs, in order. The tab row and the document title both read these labels, so they cannot drift. */
export const SYSTEM_VIEWS = [
  { id: "health", label: "Health", path: "/system" },
  { id: "runtime", label: "Runtime", path: "/system/runtime" },
  { id: "spend", label: "Spend", path: "/system/spend" },
  { id: "quality", label: "Quality", path: "/system/quality" },
  { id: "diagnostics", label: "Diagnostics", path: "/system/diagnostics" },
  { id: "activity", label: "Activity", path: "/system/activity" },
  { id: "sessions", label: "Sessions", path: "/system/sessions" },
  { id: "dashboards", label: "Dashboards", path: "/system/dashboards" },
  { id: "browser-sessions", label: "Browser sessions", path: "/system/browser-sessions" },
] as const;

/** Improvement is experimental: reachable by direct link, not a tab, but its page still needs a title. */
export const SYSTEM_IMPROVEMENT_VIEW = {
  id: "improvement",
  label: "Improvement",
  path: "/system/improvement",
} as const;
