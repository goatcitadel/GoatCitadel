/** Work's tabs, in order. The tab row and the document title both read these labels, so they cannot drift. */
export const WORK_VIEWS = [
  { id: "board", label: "Board", href: "/work" },
  { id: "history", label: "History", href: "/work/history" },
  { id: "schedules", label: "Schedules", href: "/work/schedules" },
  { id: "archive", label: "Archived tasks", href: "/work/archive" },
  { id: "automation", label: "Automation designer", href: "/work/automation" },
] as const;
