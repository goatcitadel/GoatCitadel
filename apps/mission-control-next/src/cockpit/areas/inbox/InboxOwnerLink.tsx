import type { OperatorInboxItem } from "@goatcitadel/contracts";
import { resolveCockpitContinuation } from "../../app/cockpit-compatibility";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";

/** The cockpit area a resolved destination belongs to, named the way the navigation names it (IN-19). */
const AREA_NAMES: Readonly<Record<string, string>> = {
  chat: "Chat",
  inbox: "Inbox",
  work: "Work",
  library: "Library",
  system: "System",
  settings: "Settings",
};

/** Items whose own detail opens in the Inbox; their link leads to the conversation or run they came from. */
const DECISION_KINDS: readonly string[] = [
  "approval",
  "user_input",
  "change_plan",
  "memory_proposal",
  "document_proposal",
  "capability_proposal",
  "improvement_proposal",
];

export function InboxOwnerLink({ item, workspaceId }: { item: OperatorInboxItem; workspaceId: string }) {
  const className = "inline-flex min-h-9 items-center text-sm font-medium text-accent hover:underline";
  if (!item.href.startsWith("/") || item.href.startsWith("//")) return null;
  let destination: URL;
  try {
    destination = new URL(item.href, "http://cockpit.invalid");
    if (
      destination.origin !== "http://cockpit.invalid" ||
      destination.pathname !== item.href.split(/[?#]/u, 1)[0] ||
      /[\\\r\n]/u.test(item.href)
    )
      return null;
  } catch {
    return null;
  }
  const carried = new URLSearchParams(window.location.search);
  let area: string | undefined;
  if (DECISION_KINDS.includes(item.kind)) {
    // The Inbox already shows these items (Details), so the link goes where the request came from: its conversation or run.
    const { sessionId, runId } = item.source;
    if (sessionId) {
      destination.pathname = "/chat";
      destination.search = "";
      area = "Chat";
    } else if (runId && (item.kind === "approval" || item.kind === "user_input")) {
      destination.pathname = "/work/runs/" + encodeURIComponent(runId);
      destination.search = "";
      destination.searchParams.set("runId", runId);
      area = "Work";
    } else return null;
    // The page's own selection (an open approval or item) is not this link's context.
    carried.delete("item");
    carried.delete("approvalId");
  } else if (item.kind === "task_deliverable" && item.source.taskId) {
    destination.pathname = "/work/tasks/" + encodeURIComponent(item.source.taskId);
    destination.searchParams.set("taskId", item.source.taskId);
    area = "Work";
  } else if (["failed_run", "dead_letter", "completed_background_run"].includes(item.kind) && item.source.runId) {
    destination.pathname = "/work/runs/" + encodeURIComponent(item.source.runId);
    destination.searchParams.set("runId", item.source.runId);
    area = "Work";
  }
  // A conversation link names the conversation and turn only; the page's own run and task are not its context.
  const names =
    area === "Chat" ? (["sessionId", "turnId"] as const) : (["sessionId", "turnId", "runId", "taskId"] as const);
  if (area === "Chat") {
    carried.delete("runId");
    carried.delete("taskId");
  }
  for (const key of names) {
    const value = item.source[key];
    if (value !== undefined) destination.searchParams.set(key, value);
  }
  const owner = resolveCockpitContinuation(destination.pathname + destination.search + destination.hash, {
    search: carried.toString(),
    hash: window.location.hash,
    workspaceId: item.source.workspaceId,
  });
  if (owner.kind !== "native")
    return (
      <span role="status" className="text-xs text-fg-muted">
        No page for this item&apos;s source yet
      </span>
    );
  const resolvedArea = area ?? AREA_NAMES[new URL(owner.href, "http://cockpit.invalid").pathname.split("/")[1] ?? ""];
  return (
    <NativeOwnerLink
      href={owner.href}
      scope={[workspaceId, item.source.workspaceId, item.id]}
      className={className}
      data-inbox-owner
    >
      {resolvedArea ? `Open in ${resolvedArea}` : "Open source"}
    </NativeOwnerLink>
  );
}
