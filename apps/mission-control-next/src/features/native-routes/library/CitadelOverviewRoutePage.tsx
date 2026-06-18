import { useEffect, useState } from "react";
import { Castle, Hammer, Lock, Shield } from "lucide-react";
import type { Citadel, CitadelGatehouseSummary } from "@goatcitadel/contracts";
import { getCitadel, getCitadelGatehouse, isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import { NativeCard, NativeGrid, NativeList, NativePageFrame } from "../NativeRoutePageLayout";
import { EmptyState, NativeButton } from "../primitives";
import { getErrorMessage } from "../shared/native-helpers";
import { routeKicker } from "@next/app/route-model";
import type { NativeRoutePagesProps } from "../types";

type Gatehouse = CitadelGatehouseSummary & { wardCount: number };

interface OverviewState {
  loading: boolean;
  error: string | null;
  /** False when the active workspace has no Charter yet (i.e. it is not a Citadel). */
  staged: boolean;
  citadel: Citadel | null;
  gatehouse: Gatehouse | null;
}

const INITIAL: OverviewState = { loading: true, error: null, staged: false, citadel: null, gatehouse: null };

function listSection(label: string, values: string[]): { title: string; body?: string } | null {
  return values.length > 0 ? { title: label, body: values.join(" · ") } : null;
}

/**
 * The Citadel overview (spec §2 Charter + Chambers, §20 Gatehouse posture). Reads
 * the active workspace *as* a Citadel — the workspace becomes a Citadel the moment
 * it has a Charter, so a workspace with none routes the operator to the Mason.
 */
export function CitadelOverviewRoutePage({ route, activeWorkspaceId, activeWorkspaceName, navigate }: NativeRoutePagesProps) {
  const [state, setState] = useState<OverviewState>(INITIAL);

  useEffect(() => {
    let cancelled = false;
    setState((current) => ({ ...current, loading: true, error: null }));
    void Promise.all([getCitadel(activeWorkspaceId), getCitadelGatehouse(activeWorkspaceId)])
      .then(([citadel, gatehouse]) => {
        if (!cancelled) {
          setState({ loading: false, error: null, staged: true, citadel, gatehouse });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        if (isApiRequestError(error) && error.status === 404) {
          setState({ loading: false, error: null, staged: false, citadel: null, gatehouse: null });
        } else {
          setState({ loading: false, error: getErrorMessage(error), staged: false, citadel: null, gatehouse: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId]);

  const { citadel, gatehouse } = state;
  const charter = citadel?.charter ?? null;
  const charterRows = charter
    ? [
        listSection("Goals", charter.goals),
        listSection("Boundaries", charter.boundaries),
        listSection("Success", charter.successDefinition),
      ].filter((row): row is { title: string; body?: string } => row !== null)
    : [];

  return (
    <NativePageFrame
      icon={Castle}
      area="library"
      kicker={routeKicker(route)}
      title="Citadel"
      description={`How ${activeWorkspaceName} is governed as a Citadel — its Charter, Chambers, and Gatehouse posture.`}
      loading={state.loading}
      error={state.error}    >
      {!state.staged ? (
        <EmptyState
          icon={<Castle className="h-5 w-5" />}
          title={`${activeWorkspaceName} isn't a Citadel yet`}
          description="A workspace becomes a Citadel once it has a Charter. The Mason can stage one for you — nothing is connected or activated until you confirm."
          primaryAction={
            <NativeButton
              variant="default"
              onClick={() => navigate({ area: "library", section: "citadel" })}
            >
              <Hammer className="h-4 w-4" />
              Open the Mason
            </NativeButton>
          }
        />
      ) : (
        <NativeGrid>
          <NativeCard
            title="Charter"
            subtitle="The purpose and boundaries that define this Citadel."
            stats={
              charter
                ? [
                    { label: "Kind", value: charter.kind },
                    { label: "Posture", value: charter.riskPosture },
                  ]
                : undefined
            }
          >
            {charter ? (
              <>
                <p className="mc-next-citadel-purpose">{charter.purpose}</p>
                <NativeList
                  items={charterRows}
                  emptyLabel="No goals or boundaries captured yet."
                  density="compact"
                />
              </>
            ) : (
              <EmptyState size="compact" title="No Charter found." />
            )}
          </NativeCard>

          <NativeCard
            title="Chambers"
            subtitle="Areas of work, each with its own sensitivity. Sealed Chambers stay restricted."
            stats={[
              { label: "Chambers", value: String(gatehouse?.chamberCount ?? citadel?.chambers.length ?? 0) },
              { label: "Sealed", value: String(gatehouse?.sealedChamberCount ?? 0) },
            ]}
          >
            <NativeList
              items={(citadel?.chambers ?? []).map((chamber) => ({
                title: chamber.name,
                meta: chamber.sealed ? `${chamber.sensitivity} · sealed` : chamber.sensitivity,
              }))}
              emptyLabel="No Chambers yet."
              density="compact"
            />
          </NativeCard>

          {gatehouse ? (
            <NativeCard
              title="Gatehouse"
              subtitle="The default posture every Chamber inherits until a Ward overrides it."
              stats={[
                { label: "Wards", value: String(gatehouse.wardCount) },
                { label: "Sealed", value: String(gatehouse.sealedChamberCount) },
              ]}
            >
              <NativeList
                items={[
                  { title: "Risk posture", body: gatehouse.riskPosture },
                  { title: "Model policy", body: gatehouse.modelPolicyDefault },
                  { title: "Sharing", body: gatehouse.sharingDefault },
                  { title: "External writes", body: gatehouse.externalWritesDefault },
                ]}
                density="compact"
              />
            </NativeCard>
          ) : null}
        </NativeGrid>
      )}

      {state.staged ? (
        <p className="mc-next-citadel-footnote">
          <Shield className="h-3 w-3" aria-hidden="true" />
          Wards and Gates are evaluated deny-wins. <Lock className="h-3 w-3" aria-hidden="true" /> Sealed Chambers
          never widen access.
        </p>
      ) : null}
    </NativePageFrame>
  );
}
