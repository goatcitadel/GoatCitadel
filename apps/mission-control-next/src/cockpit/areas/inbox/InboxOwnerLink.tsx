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
  let label: string | undefined;
  if (item.kind === "approval" && item.source.approvalId) {
    destination.pathname = "/inbox/approvals/" + encodeURIComponent(item.source.approvalId);
    destination.searchParams.set("approvalId", item.source.approvalId);
    destination.searchParams.delete("item");
    carried.delete("item");
    // The Inbox itself owns approvals; this link focuses the exact record.
    label = "Open approval";
  } else if (item.kind === "task_deliverable" && item.source.taskId) {
    destination.pathname = "/work/tasks/" + encodeURIComponent(item.source.taskId);
    destination.searchParams.set("taskId", item.source.taskId);
    area = "Work";
  } else if (["failed_run", "dead_letter", "completed_background_run"].includes(item.kind) && item.source.runId) {
    destination.pathname = "/work/runs/" + encodeURIComponent(item.source.runId);
    destination.searchParams.set("runId", item.source.runId);
    area = "Work";
  } else if (
    [
      "user_input",
      "change_plan",
      "memory_proposal",
      "document_proposal",
      "capability_proposal",
      "improvement_proposal",
    ].includes(item.kind)
  ) {
    // These native detail owners re-read the exact canonical record before offering any action.
    destination.pathname = "/inbox";
    destination.searchParams.set("item", item.id);
    // A linked-item selector replaces a previously selected approval, not its unrelated page context.
    destination.searchParams.delete("approvalId");
    carried.delete("approvalId");
    area = "Inbox";
  }
  for (const key of ["sessionId", "turnId", "runId", "taskId"] as const) {
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
      {label ?? (resolvedArea ? `Open in ${resolvedArea}` : "Open source")}
    </NativeOwnerLink>
  );
}
