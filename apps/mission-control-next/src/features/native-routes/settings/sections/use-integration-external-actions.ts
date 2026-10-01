import { useRef, useState } from "react";
import {
  canonicalJsonString,
  type ExternalConnectorServiceSummary,
  type ExternalConnectorActionSummary,
} from "@goatcitadel/contracts";
import {
  fetchExternalConnectorService,
  fetchExternalConnectorAction,
  fetchCapabilityProposal,
  updateExternalConnectorActionReviewState,
  updateExternalConnectorServiceReviewState,
  stageExternalConnectorAction,
} from "@goatcitadel/mission-control-shared/api/client";
import { getErrorMessage } from "../SettingsShared";
import { beginIntegrationMutation, useIntegrationConnectionMutation } from "../integration-connection-mutation";
import {
  assertExternalReviewReceipt,
  assertExternalStageReceipt,
  assertExternalReviewReadback,
  sameExternalService,
  type ExternalConnectorReview,
} from "./external-connector-review";
import type { IntegrationSettingsState } from "./use-integration-settings-state";

export function useIntegrationExternalActions(s: IntegrationSettingsState) {
  const [review, setReview] = useState<ExternalConnectorReview | null>(null);
  const reviewRef = useRef(review);
  reviewRef.current = review;
  const operationRef = useRef<object | null>(null);
  const key = `external-connectors:${s.activeWorkspaceId}`;
  const externalMutation = useIntegrationConnectionMutation(key);
  const prepare = (
    service: ExternalConnectorServiceSummary,
    status: ExternalConnectorReview["status"],
    action?: ExternalConnectorActionSummary,
  ) => {
    if (
      externalMutation.locked ||
      !s.isCurrent() ||
      !s.activeWorkspaceId.trim() ||
      service.callable !== false ||
      service.runtimePosture !== "catalog_only"
    )
      return;
    const listed = s.data?.externalConnectorServices.find(
      (item) => item.sourceId === service.sourceId && item.serviceId === service.serviceId,
    );
    if (
      !listed ||
      !sameExternalService(listed, service) ||
      (action && !listed.actions?.some((item) => canonicalJsonString(item) === canonicalJsonString(action)))
    )
      return;
    if (status === "staged" && (!action || action.reviewState.status === "staged" || action.reviewState.proposalId))
      return;
    setReview({ service, action, status, workspaceId: s.activeWorkspaceId, isCurrent: s.isCurrent });
  };
  const confirmExternalReview = async () => {
    const reviewed = review;
    if (!reviewed || !reviewed.isCurrent() || reviewRef.current !== reviewed) return;
    const operation = beginIntegrationMutation(key);
    if (!operation) return;
    const token = {};
    operationRef.current = token;
    const current = () => reviewed.isCurrent() && reviewRef.current === reviewed;
    s.setExternalConnectorBusyId(
      reviewed.action
        ? `action:${reviewed.service.sourceId}:${reviewed.service.serviceId}:${reviewed.action.actionId}`
        : `service:${reviewed.service.sourceId}:${reviewed.service.serviceId}`,
    );
    try {
      const service = await fetchExternalConnectorService(reviewed.service.sourceId, reviewed.service.serviceId, {
        workspaceId: reviewed.workspaceId,
      });
      if (!current()) return;
      const action = reviewed.action && service.actions.find((item) => item.actionId === reviewed.action!.actionId);
      if (
        !sameExternalService(service, reviewed.service) ||
        (reviewed.action && canonicalJsonString(action) !== canonicalJsonString(reviewed.action))
      )
        throw new Error("The external catalog or review state changed. Refresh and review the current owner evidence.");
      const readTarget = () =>
        reviewed.action
          ? fetchExternalConnectorAction(service.sourceId, service.serviceId, reviewed.action.actionId, {
              workspaceId: reviewed.workspaceId,
            })
          : fetchExternalConnectorService(service.sourceId, service.serviceId, { workspaceId: reviewed.workspaceId });
      let proposalId: string | undefined;
      if (reviewed.status === "staged" && reviewed.action) {
        const result = await operation.write(
          () =>
            stageExternalConnectorAction(service.sourceId, service.serviceId, reviewed.action!.actionId, {
              workspaceId: reviewed.workspaceId,
            }),
          async (receipt) => {
            assertExternalStageReceipt(reviewed, receipt);
            const [target, detail] = await Promise.all([
              readTarget(),
              fetchCapabilityProposal(receipt.proposal.proposalId),
            ]);
            assertExternalReviewReadback(reviewed, target, receipt.state);
            if (canonicalJsonString(detail.proposal) !== canonicalJsonString(receipt.proposal))
              throw new Error("The staged action and proposal could not be confirmed by their owners.");
          },
        );
        proposalId = result.proposal.proposalId;
      } else {
        const status = reviewed.status as "reviewed" | "hidden";
        await operation.write(
          () =>
            reviewed.action
              ? updateExternalConnectorActionReviewState(
                  service.sourceId,
                  service.serviceId,
                  reviewed.action.actionId,
                  { workspaceId: reviewed.workspaceId, status },
                )
              : updateExternalConnectorServiceReviewState(service.sourceId, service.serviceId, {
                  workspaceId: reviewed.workspaceId,
                  status,
                }),
          async (receipt) => {
            assertExternalReviewReceipt(reviewed, receipt);
            const target = await readTarget();
            assertExternalReviewReadback(reviewed, target, receipt);
          },
        );
      }
      if (!current()) return;
      setReview(null);
      s.setNotice({
        tone: "success",
        message: proposalId
          ? `Proposal ${proposalId} was confirmed. This external action remains non-callable.`
          : `${reviewed.action?.label ?? service.label} marked ${reviewed.status} for this workspace. It remains non-callable.`,
      });
      try {
        await s.reload();
      } catch {
        if (reviewed.isCurrent())
          s.setNotice({
            tone: "warning",
            message: "The owner acknowledged this review, but refreshing the catalog failed.",
          });
      }
    } catch (error) {
      if (current()) s.setNotice({ tone: "error", message: getErrorMessage(error) });
    } finally {
      operation.finish();
      if (operationRef.current === token) {
        operationRef.current = null;
        s.setExternalConnectorBusyId(null);
      }
    }
  };
  return {
    externalReview: review?.isCurrent() ? review : null,
    externalMutation,
    cancelExternalReview: () => setReview(null),
    confirmExternalReview,
    handleReviewExternalConnectorService: (service: ExternalConnectorServiceSummary, status: "reviewed" | "hidden") =>
      prepare(service, status),
    handleReviewExternalConnectorAction: (action: ExternalConnectorActionSummary, status: "reviewed" | "hidden") => {
      const service = s.data?.externalConnectorServices.find(
        (item) => item.sourceId === action.sourceId && item.serviceId === action.serviceId,
      );
      if (service) prepare(service, status, action);
    },
    handleStageExternalConnectorAction: (action: ExternalConnectorActionSummary) => {
      const service = s.data?.externalConnectorServices.find(
        (item) => item.sourceId === action.sourceId && item.serviceId === action.serviceId,
      );
      if (service) prepare(service, "staged", action);
    },
  };
}
