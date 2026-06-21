import { describe, expect, it } from "vitest";
import type {
  CapabilityProposalRecord,
  ExternalConnectorReviewStatePatchInput,
  ExternalConnectorReviewStateRecord,
  ExternalConnectorSourceId,
} from "@goatcitadel/contracts";
import { ExternalConnectorCatalogService } from "./external-connector-catalog-service.js";

describe("ExternalConnectorCatalogService", () => {
  it("projects the pinned MSCR snapshot as dormant integration catalog entries", () => {
    const service = createService();

    const source = service.listSources()[0];
    expect(source).toMatchObject({
      sourceId: "mscr",
      commit: "ccadd673b87c38ec66154e6433d954a3c7707d01",
      serviceCount: 17,
      actionCount: 857,
    });

    const notion = service.getService("mscr", "notion", "default");
    expect(notion.actionCount).toBe(19);
    expect(notion.callable).toBe(false);
    expect(notion.actions[0]?.callable).toBe(false);

    const catalogEntry = service
      .listIntegrationCatalogEntries()
      .find((entry) => entry.catalogId === "external_connector.mscr.notion");
    expect(catalogEntry).toMatchObject({
      kind: "external_connector",
      maturity: "disabled",
      runtimeAvailability: "blocked",
      externalConnector: {
        sourceId: "mscr",
        serviceId: "notion",
        runtimePosture: "catalog_only",
        callable: false,
      },
    });
  });

  it("stages actions as capability proposals while keeping them non-callable", () => {
    const createdProposals: CapabilityProposalRecord[] = [];
    const service = createService(createdProposals);

    const result = service.stageAction(
      { sourceId: "mscr", serviceId: "notion", actionId: "append-block-children" },
      { workspaceId: "default" },
    );

    expect(result.action.callable).toBe(false);
    expect(result.state.status).toBe("staged");
    expect(result.state.proposalId).toBe(result.proposal.proposalId);
    expect(createdProposals[0]?.payload).toMatchObject({
      sourceKind: "external_connector_catalog",
      runtimePosture: "catalog_only",
      callable: false,
      service: { serviceId: "notion" },
      action: { actionId: "append-block-children" },
    });
  });
});

function createService(createdProposals: CapabilityProposalRecord[] = []): ExternalConnectorCatalogService {
  const states = new Map<string, ExternalConnectorReviewStateRecord>();
  return new ExternalConnectorCatalogService({
    reviewStates: {
      list(query = {}) {
        return [...states.values()].filter((state) => {
          return (
            state.workspaceId === (query.workspaceId ?? "default") &&
            (!query.sourceId || state.sourceId === query.sourceId) &&
            (!query.serviceId || state.serviceId === query.serviceId)
          );
        });
      },
      find(input) {
        return states.get(stateKey(input.workspaceId, input.sourceId, input.serviceId, input.actionId));
      },
      upsert(lookup, patch: ExternalConnectorReviewStatePatchInput) {
        const key = stateKey(lookup.workspaceId, lookup.sourceId, lookup.serviceId, lookup.actionId);
        const current = states.get(key);
        const now = "2026-06-21T10:00:00.000Z";
        const next: ExternalConnectorReviewStateRecord = {
          workspaceId: lookup.workspaceId ?? "default",
          sourceId: lookup.sourceId,
          serviceId: lookup.serviceId,
          actionId: lookup.actionId,
          status: patch.status ?? current?.status ?? "reviewed",
          pinned: patch.pinned ?? current?.pinned ?? false,
          note: patch.note === undefined ? current?.note : (patch.note ?? undefined),
          proposalId: patch.proposalId === undefined ? current?.proposalId : (patch.proposalId ?? undefined),
          createdAt: current?.createdAt ?? now,
          updatedAt: now,
        };
        states.set(key, next);
        return next;
      },
    },
    createCapabilityProposal(input) {
      const now = "2026-06-21T10:00:00.000Z";
      const proposal: CapabilityProposalRecord = {
        proposalId: `proposal-${createdProposals.length + 1}`,
        proposalKind: input.proposalKind,
        status: "proposed",
        title: input.title,
        summary: input.summary,
        payload: input.payload,
        createdAt: now,
        updatedAt: now,
      };
      createdProposals.push(proposal);
      return proposal;
    },
  });
}

function stateKey(
  workspaceId: string | undefined,
  sourceId: ExternalConnectorSourceId,
  serviceId: string,
  actionId?: string,
): string {
  return `${workspaceId ?? "default"}:${sourceId}:${serviceId}:${actionId ?? ""}`;
}
