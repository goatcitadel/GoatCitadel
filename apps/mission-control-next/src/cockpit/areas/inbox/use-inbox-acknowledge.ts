import { useRef, useState } from "react";
import type { OperatorInboxItem } from "@goatcitadel/contracts";
import { markOperatorInboxUpdatesRead } from "@goatcitadel/mission-control-shared/api/operator-inbox";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { getGatewayAccessRevision, getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { inboxUpdateVersion, markInboxUpdateViewed } from "./inbox-viewed-updates";

/**
 * Acknowledging Inbox updates: records the read receipt where the read scope keeps it (this browser, or the operator
 * on the Gateway) and says in a notice when some could not be saved. A scope, installation or access change while
 * the write is running stops further writes.
 */
export function useInboxAcknowledge({
  workspaceId,
  installation,
  accessRevision,
  readScope,
  isViewed,
  refetch,
}: {
  workspaceId: string;
  installation: string;
  accessRevision: number;
  readScope: string;
  isViewed: (item: OperatorInboxItem) => boolean;
  refetch: () => Promise<unknown>;
}) {
  const [readNotice, setReadNotice] = useState("");
  const [reading, setReading] = useState(false);
  const latestWorkspace = useRef(workspaceId);
  latestWorkspace.current = workspaceId;

  async function acknowledge(items: OperatorInboxItem[]) {
    if (reading) return;
    const updates = items.filter((item) => inboxUpdateVersion(item, workspaceId) && !isViewed(item));
    if (!updates.length) return;
    setReading(true);
    setReadNotice("");
    try {
      if (readScope === "browser_local") {
        const saved = await Promise.all(
          updates.map((item) =>
            markInboxUpdateViewed(
              installation,
              workspaceId,
              item,
              () =>
                latestWorkspace.current === workspaceId &&
                getGatewayApiBaseUrl() === installation &&
                getGatewayAccessRevision() === accessRevision,
            ),
          ),
        );
        const failed = saved.some((value) => !value);
        if (failed) setReadNotice("Read storage unavailable. Unacknowledged updates remain unread.");
      } else if (readScope === "operator") {
        let skipped = 0;
        for (let offset = 0; offset < updates.length; offset += 200) {
          if (
            getGatewayAccessRevision() !== accessRevision ||
            getGatewayApiBaseUrl() !== installation ||
            latestWorkspace.current !== workspaceId
          )
            break;
          const result = await markOperatorInboxUpdatesRead(
            workspaceId,
            updates.slice(offset, offset + 200).map((item) => ({ id: item.id, version: item.version! })),
          );
          skipped += result.skipped.length;
        }
        if (skipped)
          setReadNotice(
            `${plural(skipped, "update was", "updates were")} not acknowledged. Changed or unavailable updates remain unread.`,
          );
        await refetch();
      } else setReadNotice("Read storage unavailable. Unacknowledged updates remain unread.");
    } catch {
      setReadNotice("Read status could not be saved. Refresh to check current receipts.");
    } finally {
      setReading(false);
    }
  }

  return { acknowledge, readNotice, reading };
}
