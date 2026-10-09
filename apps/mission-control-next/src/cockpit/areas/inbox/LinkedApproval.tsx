import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { ScopeSwitcher } from "../../app/ScopeSwitcher";
import { Button } from "../../ui/Button";
import { InboxApprovalDetail } from "./InboxApprovalDetail";
import { nullWhenMissing } from "./inbox-record-read";

/** Resolve a canonical record, including records outside the bounded pending projection. */
export function LinkedApproval({ approvalId }: { approvalId: string }) {
  const { search, hash } = useCockpitRoute();
  const { activeWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const installation = getGatewayApiBaseUrl();
  const access = useProjectAccess(workspaceId);
  const [scopeOpen, setScopeOpen] = useState(false);
  const query = useQuery({
    queryKey: ["approvals", "linked-record", installation, workspaceId, approvalId, access.identity],
    // This endpoint enforces actor authorization even without a workspace filter.
    queryFn: ({ signal }) => nullWhenMissing(fetchApproval(approvalId, { signal })),
    staleTime: 0,
  });
  if (query.isPending || (query.isFetching && !query.data)) return <p role="status">Loading the linked approval…</p>;
  if (query.isError) return <p role="alert">{describeApiError(query.error).summary}</p>;
  const approval = query.data;
  if (!approval) return <p role="status">Approval not found.</p>;
  const recordWorkspace = approval.linkage?.workspaceId;
  const parameters = new URLSearchParams(search);
  parameters.set("approvalId", approvalId);
  if (recordWorkspace) parameters.set("workspaceId", recordWorkspace);
  const href = `/inbox?${parameters}${hash}`;
  if (recordWorkspace && recordWorkspace !== workspaceId)
    return (
      <section className="space-y-3" aria-label="Approval workspace review">
        <p>
          This approval belongs to workspace {recordWorkspace}. Review and select that workspace before opening its
          details.
        </p>
        <Button onClick={() => setScopeOpen(true)}>Review workspace</Button>
        <ScopeSwitcher hideTrigger open={scopeOpen} onOpenChange={setScopeOpen} destination={href} />
      </section>
    );
  return (
    <InboxApprovalDetail
      workspaceId={workspaceId}
      ownerChecking={query.isFetching}
      item={{
        id: `approval:${approvalId}`,
        kind: "approval",
        group: "needs_decision",
        title: "Linked approval",
        summary: "Review the current approval",
        createdAt: approval.createdAt,
        source: { workspaceId, approvalId },
        href,
      }}
    />
  );
}
