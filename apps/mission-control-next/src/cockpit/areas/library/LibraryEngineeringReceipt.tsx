import { useQuery } from "@tanstack/react-query";
import type { EngineeringLearningRecord, EngineeringLearningAction } from "@goatcitadel/contracts";
import { fetchApprovalReplay } from "@goatcitadel/mission-control-shared/api/approvals";
import { fetchEngineeringLearning } from "@goatcitadel/mission-control-shared/api/engineering-learnings";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useLibraryOperation } from "./use-library-operation";
import { Callout } from "../../ui/Callout";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
export function LibraryEngineeringReceipt({ approvalId, item, action }: { approvalId: string; item: EngineeringLearningRecord; action: EngineeringLearningAction }) {
 const access = useLibraryOperation(JSON.stringify(["engineering-receipt", item.workspaceId, approvalId]));
 const query = useQuery({ queryKey: ["library", "engineering-receipt", access.identity, approvalId], queryFn: async () => {
  const replay = await fetchApprovalReplay(approvalId);
  if (replay.approval.approvalId !== approvalId || replay.approval.kind !== "engineering_learning.lifecycle" || replay.approval.linkage?.workspaceId !== item.workspaceId || replay.approval.payload.learningId !== item.learningId || replay.approval.payload.action !== action || replay.approval.payload.expectedProvenanceHash !== item.provenanceHash) throw new Error("The approval is not bound to the reviewed learning and provenance.");
  const current = await fetchEngineeringLearning(item.learningId); if (current.workspaceId !== item.workspaceId) throw new Error("The current learning belongs to a different workspace.");
  const effect = replay.effects.find(effect => effect.approvalId === approvalId && effect.effectKind === "engineering_learning_lifecycle_apply" && effect.result.learningId === item.learningId && effect.result.action === action);
  return { approval: replay.approval, current, effect };
 }, retry: false, staleTime: 0 });
 const data = query.data;
 return <section aria-label="Engineering learning effect receipt" className="grid gap-2">{query.isFetching ? <p role="status">Checking original learning effect and current record…</p> : null}{query.error ? <Callout tone="warning">Current learning effect is not verified. {describeApiError(query.error).summary}</Callout> : data && !query.isFetching ? <><p>Decision: {data.approval.status}. {data.approval.status === "approved" && data.effect?.status === "completed" ? "Original learning effect completed with the exact learning and action." : "No completed learning effect is confirmed by this receipt."}</p><p>Current learning: {data.current.status}. This readback is separate from the original effect.</p><TechnicalDetails label="Learning effect provenance"><p>{data.effect?.effectId} · {data.effect?.status} · {data.effect?.completedAt}</p><p>Current provenance: {data.current.provenanceHash}</p></TechnicalDetails></> : null}</section>;
}
