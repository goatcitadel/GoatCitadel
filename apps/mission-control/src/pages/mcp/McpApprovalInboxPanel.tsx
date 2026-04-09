import type { ApprovalInboxItemRecord } from "@goatcitadel/contracts";
import { ActionButton } from "../../components/ActionButton";
import { Panel } from "../../components/Panel";
import { GCSelect } from "../../components/ui";
import { summarizeApprovalPreview } from "./mcp-page-helpers";

type ApprovalInboxFilterState = "all" | ApprovalInboxItemRecord["state"];

interface McpApprovalInboxPanelProps {
  selectedStatus: "disconnected" | "connecting" | "connected" | "error";
  inboxFilterState: ApprovalInboxFilterState;
  setInboxFilterState: (value: ApprovalInboxFilterState) => void;
  inboxBusy: boolean;
  inboxError: string | null;
  inboxItems: ApprovalInboxItemRecord[];
  pendingInboxActionId: string | null;
  onRefresh: () => Promise<void>;
  onResolve: (item: ApprovalInboxItemRecord, decision: "approve" | "reject") => Promise<void>;
}

export function McpApprovalInboxPanel(props: McpApprovalInboxPanelProps) {
  const {
    selectedStatus,
    inboxFilterState,
    setInboxFilterState,
    inboxBusy,
    inboxError,
    inboxItems,
    pendingInboxActionId,
    onRefresh,
    onResolve,
  } = props;

  return (
    <Panel
      title="Approval Inbox"
      subtitle="Resolve non-browser approval deliveries that arrive through the internal MCP approval inbox."
    >
      <div className="controls-row">
        <label htmlFor="approvalInboxState">State</label>
        <GCSelect
          id="approvalInboxState"
          value={inboxFilterState}
          onChange={(value) => setInboxFilterState(value as ApprovalInboxFilterState)}
          options={[
            { value: "pending", label: "pending" },
            { value: "all", label: "all" },
            { value: "approved", label: "approved" },
            { value: "rejected", label: "rejected" },
            { value: "edited", label: "edited" },
            { value: "expired", label: "expired" },
            { value: "failed", label: "failed" },
          ]}
        />
        <ActionButton label="Refresh Inbox" pending={inboxBusy} onClick={() => void onRefresh()} />
      </div>
      <p className="office-subtitle">
        This inbox is the internal non-browser receiver for durable approval actions. Each item keeps token state,
        delivery count, and terminal resolution details for later debugging.
      </p>
      {selectedStatus !== "connected" ? (
        <p className="office-subtitle">Connect this server before loading approval inbox items.</p>
      ) : null}
      {inboxError ? <p className="error">{inboxError}</p> : null}
      <div className="stack-md">
        {inboxItems.map((item) => (
          <div key={item.inboxItemId} className="prompt-lab-run-summary">
            <p>
              <strong>{item.approvalKind}</strong>
              <span className="token-chip" style={{ marginLeft: 8 }}>
                {item.state}
              </span>
              <span className="token-chip" style={{ marginLeft: 8 }}>
                {item.riskLevel}
              </span>
              <span className="token-chip" style={{ marginLeft: 8 }}>
                deliveries {item.deliveryCount}
              </span>
            </p>
            <p className="office-subtitle">{summarizeApprovalPreview(item.preview)}</p>
            <p className="office-subtitle">
              Approval {item.approvalId} | token {item.tokenId} | expires {new Date(item.expiresAt).toLocaleString()}
            </p>
            {item.lastError ? <p className="office-subtitle">Last error: {item.lastError}</p> : null}
            {item.state === "pending" ? (
              <div className="actions">
                <ActionButton
                  label="Approve"
                  pending={pendingInboxActionId === item.inboxItemId}
                  disabled={pendingInboxActionId !== null && pendingInboxActionId !== item.inboxItemId}
                  onClick={() => void onResolve(item, "approve")}
                />
                <ActionButton
                  label="Reject"
                  pending={pendingInboxActionId === item.inboxItemId}
                  disabled={pendingInboxActionId !== null && pendingInboxActionId !== item.inboxItemId}
                  danger
                  onClick={() => void onResolve(item, "reject")}
                />
              </div>
            ) : (
              <p className="office-subtitle">
                Resolved {item.resolvedAt ? new Date(item.resolvedAt).toLocaleString() : "pending timestamp"}
                {item.resolvedBy ? ` by ${item.resolvedBy}` : ""}
              </p>
            )}
          </div>
        ))}
        {!inboxBusy && inboxItems.length === 0 && selectedStatus === "connected" ? (
          <p className="office-subtitle">No approval inbox items matched the current filter.</p>
        ) : null}
      </div>
    </Panel>
  );
}
