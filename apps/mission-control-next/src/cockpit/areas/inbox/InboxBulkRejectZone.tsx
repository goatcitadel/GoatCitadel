import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApprovalBulkReject } from "./ApprovalBulkReject";
import { useInstallationPendingApprovals } from "./installation-pending-approvals";

/**
 * The installation-wide rejection, kept apart from everyday decisions at the bottom of the Inbox. The page mounts it
 * once this workspace has open decisions and keeps it for the visit (IN-R01), so a rejection receipt survives the
 * re-read that empties the page; it also needs at least one approval pending somewhere in the installation, or a
 * rejection just made. A flat section: the red is on its one button.
 */
export function InboxBulkRejectZone() {
  const queryClient = useQueryClient();
  const pending = useInstallationPendingApprovals();
  const [rejected, setRejected] = useState(false);
  if (!pending.data?.items.length && !rejected) return null;
  // A bulk rejection settles pending records everywhere: the Inbox projection, the nav badge and every approval
  // read (all under the approvals topic) must re-read.
  function afterBulkRejection() {
    setRejected(true);
    void queryClient.invalidateQueries({ queryKey: ["approvals"] });
  }
  return (
    <section aria-labelledby="inbox-bulk-reject-heading" className="grid gap-2 border-t border-line-subtle pt-4">
      <h2 id="inbox-bulk-reject-heading" className="font-medium text-fg">
        Reject everything pending
      </h2>
      <p className="text-sm text-fg-secondary">
        This applies to every workspace in the installation, not only the one selected here.
      </p>
      <div>
        <ApprovalBulkReject onResolved={afterBulkRejection} />
      </div>
    </section>
  );
}
