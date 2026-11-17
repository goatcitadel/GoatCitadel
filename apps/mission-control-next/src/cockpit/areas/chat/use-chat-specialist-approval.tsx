import { useQuery } from "@tanstack/react-query";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import {
  getGatewayAccessRevision,
  getGatewayCallerScopeRevision,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { specialistApprovalCode } from "../inbox/load-specialist-approval-code";
import { Button } from "../../ui/Button";

export function useChatSpecialistApproval(workspaceId: string, reviewedApproval: ApprovalRequest | undefined) {
  // A Code Mode run approval is approved only against the exact code and target it reads back (as the Inbox does).
  const specialistTarget =
    reviewedApproval?.status === "pending" && reviewedApproval.kind === "code_mode.run" ? reviewedApproval : undefined;
  const specialistQuery = useQuery({
    queryKey: ["approvals", "specialist", workspaceId, specialistTarget],
    queryFn: async ({ signal }) => {
      const installation = getGatewayApiBaseUrl();
      const access = getGatewayAccessRevision();
      const caller = getGatewayCallerScopeRevision();
      const assertCurrent = () => {
        signal.throwIfAborted();
        if (
          installation !== getGatewayApiBaseUrl() ||
          access !== getGatewayAccessRevision() ||
          caller !== getGatewayCallerScopeRevision()
        )
          throw new DOMException("Approval access changed.", "AbortError");
      };
      const { readSpecialistEvidence, specialistEvidenceMatches } = await specialistApprovalCode.load();
      assertCurrent();
      const evidence = await readSpecialistEvidence(specialistTarget!);
      assertCurrent();
      return specialistEvidenceMatches(specialistTarget!, evidence) ? evidence : null;
    },
    enabled: Boolean(specialistTarget),
    retry: false,
    staleTime: 0,
  });
  const specialistEvidence =
    specialistTarget && !specialistQuery.isError && specialistQuery.data ? specialistQuery.data : undefined;
  // Until the evidence matches, Approve stays disabled: say why, as the Inbox detail does, and offer a fresh read.
  const specialistChecking = !specialistQuery.isError && (specialistQuery.isPending || specialistQuery.isFetching);
  const specialistStatus =
    specialistTarget && !specialistEvidence ? (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <p role={specialistChecking ? "status" : "alert"} className={specialistChecking ? "text-fg-muted" : ""}>
          {specialistChecking
            ? "Checking the specialist review…"
            : specialistQuery.error
              ? describeApiError(specialistQuery.error).summary
              : "The specialist review is unavailable or changed. Check again before approving."}
        </p>
        {specialistChecking ? null : (
          // A read that failed after an earlier answer stays failed while it is read again, so the button
          // waits for that read, as in the Inbox detail.
          <Button
            type="button"
            size="sm"
            disabled={specialistQuery.isFetching}
            onClick={() => void specialistQuery.refetch()}
          >
            Check again
          </Button>
        )}
      </div>
    ) : null;
  return { specialistEvidence, specialistStatus };
}
