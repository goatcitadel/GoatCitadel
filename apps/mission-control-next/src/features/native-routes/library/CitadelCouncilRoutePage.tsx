import { useEffect, useId, useState } from "react";
import { Plus, Trash2, Users } from "lucide-react";
import type { AgentProfileRecord, CitadelCouncilAssignment } from "@goatcitadel/contracts";
import {
  assignCitadelCouncilAgent,
  fetchAgents,
  listCitadelCouncil,
  unassignCitadelCouncilAgent,
} from "@goatcitadel/mission-control-shared/api/client";
import { NativeCard, NativeGrid, NativeList, NativePageFrame } from "../NativeRoutePageLayout";
import { NativeButton } from "../primitives/NativeButton";
import { getErrorMessage } from "../shared/native-helpers";
import { routeKicker } from "@next/app/route-model";
import type { NativeRoutePagesProps } from "../types";

interface CouncilState {
  loading: boolean;
  error: string | null;
  items: CitadelCouncilAssignment[];
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
  activeWorkspaceId,
  activeWorkspaceName,
  activeCitadelId = activeWorkspaceId,
  activeCitadelName = activeWorkspaceName,
}: NativeRoutePagesProps) {
  const [council, setCouncil] = useState<CouncilState>({ loading: true, error: null, items: [], agents: [] });
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const selectAgentId = useId();
  const removeReasonId = useId();

  useEffect(() => {
    let cancelled = false;
    setCouncil((current) => ({ ...current, loading: true, error: null }));
    void Promise.all([listCitadelCouncil(activeCitadelId), fetchAgents("active", 300)])
      .then(([items, agents]) => {
        if (!cancelled) {
          setCouncil({ loading: false, error: null, items, agents: agents.items });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setCouncil({ loading: false, error: getErrorMessage(error), items: [], agents: [] });
        }
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

  const reloadCouncil = async () => {
    const [items, agents] = await Promise.all([listCitadelCouncil(activeCitadelId), fetchAgents("active", 300)]);
    setCouncil({ loading: false, error: null, items, agents: agents.items });
  };

  const handleSeatAgent = async () => {
    if (!selectedAgentId) {
      return;
    }
    try {
      await assignCitadelCouncilAgent(activeCitadelId, selectedAgentId);
      setNotice("Agent seated in this Citadel.");
      await reloadCouncil();
    } catch (error) {
      setNotice(getErrorMessage(error));
    }
  };

  const handleRemoveSeat = async () => {
    if (!selectedAgentId) {
      return;
    }
    try {
      await unassignCitadelCouncilAgent(activeCitadelId, selectedAgentId);
      setNotice("Agent removed from this Citadel Council.");
      await reloadCouncil();
    } catch (error) {
      setNotice(getErrorMessage(error));
    }
  };

  const seatedAgentIds = new Set(council.items.map((item) => item.agentId));
  const removeDisabled = !selectedAgentId || !seatedAgentIds.has(selectedAgentId);
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
      loading={council.loading}
      error={council.error}
    >
      <NativeGrid>
        <NativeCard
          title="Seated agents"
          subtitle="Each seat binds an existing agent to this Citadel by reference."
          stats={[{ label: "Seats", value: String(council.items.length) }]}
          actions={
            <div className="mc-next-settings-actions">
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
              <NativeButton type="button" variant="secondary" onClick={handleSeatAgent} disabled={!selectedAgentId}>
                <Plus size={16} aria-hidden="true" />
                Seat
              </NativeButton>
              <NativeButton
                type="button"
                variant="secondary"
                className="mc-next-council-remove"
                onClick={handleRemoveSeat}
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
            </div>
          }
        >
          {notice ? <p className="mc-next-citadel-footnote">{notice}</p> : null}
          <NativeList
            items={council.items.map((assignment) => ({
              title: council.agents.find((agent) => agent.agentId === assignment.agentId)?.name ?? assignment.agentId,
              meta: assignment.assignmentId,
              body: assignment.agentId,
            }))}
            emptyLabel="No agents seated yet — seat one from the agents catalog to add it to this Citadel."
            density="compact"
          />
        </NativeCard>
      </NativeGrid>
      <p className="mc-next-citadel-footnote">
        <Users size={12} aria-hidden="true" />
        Seating an agent references it; it never copies the agent. Per-seat grant ceilings are enforced by the policy
        engine.
      </p>
    </NativePageFrame>
  );
}
