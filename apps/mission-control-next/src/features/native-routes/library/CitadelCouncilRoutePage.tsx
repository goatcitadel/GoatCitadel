import { useEffect, useState } from "react";
import { Users } from "lucide-react";
import type { CitadelCouncilAssignment } from "@goatcitadel/contracts";
import { listCitadelCouncil } from "@goatcitadel/mission-control-shared/api/client";
import { NativeCard, NativeGrid, NativeList, NativePageFrame } from "../NativeRoutePageLayout";
import { getErrorMessage } from "../shared/native-helpers";
import type { NativeRoutePagesProps } from "../types";

interface CouncilState {
  loading: boolean;
  error: string | null;
  items: CitadelCouncilAssignment[];
}

/**
 * The Council (spec §16): which existing agents are seated in this Citadel. The
 * Council is a thin reference to the agents the workspace already owns — seating
 * an agent binds it to the Citadel, it does not duplicate the agent. Binding each
 * seat to a scoped grant ceiling is the policy-engine work tracked separately.
 */
export function CitadelCouncilRoutePage({ activeWorkspaceId, activeWorkspaceName }: NativeRoutePagesProps) {
  const [council, setCouncil] = useState<CouncilState>({ loading: true, error: null, items: [] });

  useEffect(() => {
    let cancelled = false;
    setCouncil((current) => ({ ...current, loading: true, error: null }));
    void listCitadelCouncil(activeWorkspaceId)
      .then((items) => {
        if (!cancelled) {
          setCouncil({ loading: false, error: null, items });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setCouncil({ loading: false, error: getErrorMessage(error), items: [] });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId]);

  return (
    <NativePageFrame
      icon={Users}
      area="library"
      kicker="Library · Council"
      title="Council"
      description={`Agents seated in the ${activeWorkspaceName} Citadel. Seats reference the agents this workspace already owns.`}
      loading={council.loading}
      error={council.error}
      releaseStatus="experimental"
    >
      <NativeGrid>
        <NativeCard
          title="Seated agents"
          subtitle="Each seat binds an existing agent to this Citadel by reference."
          stats={[{ label: "Seats", value: String(council.items.length) }]}
        >
          <NativeList
            items={council.items.map((assignment) => ({
              title: assignment.agentId,
              meta: assignment.assignmentId,
            }))}
            emptyLabel="No agents seated yet — seat one from the agents catalog to add it to this Citadel."
            density="compact"
          />
        </NativeCard>
      </NativeGrid>
      <p className="mc-next-citadel-footnote">
        <Users className="h-3 w-3" aria-hidden="true" />
        Seating an agent references it; it never copies the agent. Per-seat grant ceilings are enforced by the policy
        engine.
      </p>
    </NativePageFrame>
  );
}
