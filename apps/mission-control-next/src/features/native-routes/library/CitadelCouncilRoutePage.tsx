import { useCitadelAccessReview } from "./useCitadelAccessReview";
import { CitadelAccessReview } from "./CitadelAccessReview";
import "./citadel-confirmation.css";
import { useEffect, useId, useState } from "react";
import { Plus, Trash2, Users } from "lucide-react";
import type { AgentProfileRecord } from "@goatcitadel/contracts";
import {
  assignCitadelCouncilAgent,
  fetchAgents,
  unassignCitadelCouncilAgent,
} from "@goatcitadel/mission-control-shared/api/client";
import { IdentifierChip } from "@goatcitadel/mission-control-shared/components/IdentifierChip";
import { NativeCard, NativeDisclosureCard, NativeGrid, NativeList, NativePageFrame } from "../NativeRoutePageLayout";
import { NativeButton, NoticeBanner } from "../primitives";
import { getErrorMessage } from "../shared/native-helpers";
import { DetailInspector } from "../../../components/DetailInspector";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { routeKicker } from "@next/app/route-model";
import type { NativeRoutePagesProps } from "../types";

interface CouncilState {
  loading: boolean;
  error: string | null;
  agents: AgentProfileRecord[];
}

/**
 * The Council (spec §16): which existing agents are seated in this Citadel. The
 * Council is a thin reference to the agents the workspace already owns — seating
 * an agent binds it to the Citadel, it does not duplicate the agent. Binding each
 * seat to a scoped grant ceiling is the policy-engine work tracked separately.
 */
export function CitadelCouncilRoutePage({
  route,
  navigate,
  activeWorkspaceId,
  activeWorkspaceName,
  activeCitadelId = activeWorkspaceId,
  activeCitadelName = activeWorkspaceName,
}: NativeRoutePagesProps) {
  const access = useCitadelAccessReview(activeCitadelId);
  const [catalog, setCatalog] = useState<CouncilState>({ loading: true, error: null, agents: [] });
  const council = { ...catalog, items: access.snapshot?.council ?? [] };
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [selectedSeatId, setSelectedSeatId] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<{ agentId: string; revision: string; citadelId: string } | null>(null);
  const selectedSeat = council.items.find((item) => item.assignmentId === selectedSeatId);
  const selectedProfile = council.agents.find((agent) => agent.agentId === selectedSeat?.agentId);
  const [notice, setNotice] = useState<string | null>(null);
  const selectAgentId = useId();
  const removeReasonId = useId();

  useEffect(() => {
    let cancelled = false;
    setCatalog({ loading: true, error: null, agents: [] });
    setPendingRemoval(null); setSelectedSeatId(null); setSelectedAgentId(""); setNotice(null);
    void fetchAgents("active", 300).then((agents) => {
      if (!cancelled) setCatalog({ loading: false, error: null, agents: agents.items });
    }).catch((error: unknown) => {
      if (!cancelled) setCatalog({ loading: false, error: getErrorMessage(error), agents: [] });
    });
    return () => {
      cancelled = true;
    };
  }, [activeCitadelId]);

  useEffect(() => {
    const seated = new Set(council.items.map((item) => item.agentId));
    const firstAvailable = council.agents.find((agent) => !seated.has(agent.agentId));
    setSelectedAgentId((current) =>
      current && council.agents.some((agent) => agent.agentId === current) ? current : (firstAvailable?.agentId ?? ""),
    );
  }, [council.agents, council.items]);

  const handleSeatAgent = async () => {
    if (!selectedAgentId || !access.snapshot) return;
    const expectedRevision = access.snapshot.revision;
    setNotice(null);
    const saved = await access.run(expectedRevision, () => assignCitadelCouncilAgent(activeCitadelId, selectedAgentId, expectedRevision));
    if (saved) setNotice("Agent seated in this Citadel.");
  };

  const handleRemoveSeat = async () => {
    if (!pendingRemoval || pendingRemoval.citadelId !== activeCitadelId) return;
    setNotice(null);
    const saved = await access.run(pendingRemoval.revision, () => unassignCitadelCouncilAgent(activeCitadelId, pendingRemoval.agentId, pendingRemoval.revision));
    if (!access.isCurrent()) return;
    setPendingRemoval(null);
    if (saved) setNotice("Agent removed from this Citadel Council.");
  };

  const seatedAgentIds = new Set(council.items.map((item) => item.agentId));
  const removeDisabled = !access.ready || !selectedAgentId || !seatedAgentIds.has(selectedAgentId);
  const removeDisabledReason = !selectedAgentId
    ? "Select a seated agent before removing a Council seat."
    : "The selected agent is not currently seated in this Council.";

  return (
    <NativePageFrame
      icon={Users}
      area="library"
      kicker={routeKicker(route)}
      title="Council"
      description={`Agents seated in the ${activeCitadelName} Citadel. Seats reference agents by id without duplicating their profiles.`}
      loading={council.loading || (access.loading && !access.reviewRequired)}
      error={council.error ?? (!access.snapshot && !access.reviewRequired ? access.error : null)}
    >
      {access.error && (!access.reviewRequired || !access.snapshot) ? <NoticeBanner tone="error" message={access.error} /> : null}
      {access.reviewRequired ? <CitadelAccessReview snapshot={access.snapshot} onAccept={access.acceptReview} /> : null}
      {access.snapshot?.structure.record?.lifecycleStatus === "archived" ? <p>Restore this Citadel before changing access rules.</p> : null}
      <NativeGrid className="mc-next-calm-directory">
        <NativeCard
          title="Seated agents"
          subtitle="Each seat binds an existing agent to this Citadel by reference."
          stats={[{ label: "Seats", value: String(council.items.length) }]}
          actions={
            <NativeDisclosureCard id="council-manage" title="Manage Council seats"><div className="mc-next-settings-actions">
              <label className="mc-next-mason-field" htmlFor={selectAgentId}>
                <span>Council agent</span>
                <select
                  aria-label="Council agent"
                  id={selectAgentId}
                  className="mc-next-settings-input"
                  value={selectedAgentId}
                  onChange={(event) => setSelectedAgentId(event.target.value)}
                >
                  <option value="">Select agent</option>
                  {council.agents.map((agent) => (
                    <option key={agent.agentId} value={agent.agentId}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              </label>
              <NativeButton type="button" variant="secondary" onClick={handleSeatAgent} disabled={!selectedAgentId || !access.ready || council.loading || Boolean(council.error) || seatedAgentIds.has(selectedAgentId)}>
                <Plus size={16} aria-hidden="true" />
                Seat
              </NativeButton>
              <NativeButton
                type="button"
                variant="secondary"
                className="mc-next-council-remove"
                onClick={() => { if (access.snapshot) setPendingRemoval({ agentId: selectedAgentId, revision: access.snapshot.revision, citadelId: activeCitadelId }); }}
                disabled={removeDisabled}
                aria-describedby={removeDisabled ? removeReasonId : undefined}
              >
                <Trash2 size={16} aria-hidden="true" />
                Remove
              </NativeButton>
              {removeDisabled ? (
                <span id={removeReasonId} className="mc-next-council-remove-reason">
                  {removeDisabledReason}
                </span>
              ) : null}
            </div></NativeDisclosureCard>
          }
        >
          {notice ? <p className="mc-next-citadel-footnote">{notice}</p> : null}
          <NativeList
            items={council.items.map((assignment) => ({
              title: council.agents.find((agent) => agent.agentId === assignment.agentId)?.name ?? assignment.agentId,
              body: council.agents.find((agent) => agent.agentId === assignment.agentId)?.roleId ?? "Profile unavailable",
              actions: (
                <NativeButton variant="outline" aria-label={`Inspect ${council.agents.find((agent) => agent.agentId === assignment.agentId)?.name ?? assignment.agentId}`} onClick={() => setSelectedSeatId(assignment.assignmentId)}>Details</NativeButton>
              ),
            }))}
            emptyLabel="No agents seated yet — seat one from the agents catalog to add it to this Citadel."
            density="compact"
          />
        </NativeCard>
      </NativeGrid>
      <DetailInspector open={Boolean(selectedSeat)} title={selectedProfile?.name ?? "Council seat"} subtitle={selectedProfile?.roleId ?? "Profile unavailable"} onClose={() => setSelectedSeatId(null)}>
        {selectedSeat ? <>
          <p>{selectedProfile?.summary ?? "Existing agent reference. Seat membership does not indicate a running agent."}</p>
          <div className="mc-next-identifier-stack"><IdentifierChip value={selectedSeat.agentId} label="Agent" /><IdentifierChip value={selectedSeat.assignmentId} label="Seat" /></div>
          <dl className="mc-next-native-facts">{Object.entries(selectedSeat).filter(([key]) => !["agentId", "assignmentId"].includes(key)).map(([key, value]) => <div key={key}><dt>{key.replace(/([A-Z])/g, " $1")}</dt><dd>{String(value ?? "Unavailable")}</dd></div>)}</dl>
          <NativeButton variant="outline" onClick={() => navigate({ area: "library", section: "agents" })}>Open agent catalog</NativeButton>
        </> : null}
      </DetailInspector>
      <ConfirmModal className="mc-next-citadel-confirmation" pending={access.busy} cancelDisabled={access.busy} disableDismiss={access.busy} open={pendingRemoval !== null} title="Remove Council seat?" message={`Remove ${council.agents.find((agent) => agent.agentId === pendingRemoval?.agentId)?.name ?? pendingRemoval?.agentId} from ${activeCitadelName}? The agent profile will remain available.`} confirmLabel="Remove seat" danger onConfirm={() => void handleRemoveSeat()} onCancel={() => setPendingRemoval(null)} />
      <p className="mc-next-citadel-footnote">
        <Users size={12} aria-hidden="true" />
        Seating an agent references it; it never copies the agent. Per-seat grant ceilings are enforced by the policy
        engine.
      </p>
    </NativePageFrame>
  );
}
