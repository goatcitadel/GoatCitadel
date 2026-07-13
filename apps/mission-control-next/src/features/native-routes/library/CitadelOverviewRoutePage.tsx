import { useEffect, useMemo, useState } from "react";
import { Castle, Hammer, Lock, Shield, Sparkles } from "lucide-react";
import type { Citadel, CitadelGatehouseSummary, CitadelTemplate } from "@goatcitadel/contracts";
import {
  createCitadelFromTemplate,
  getCitadel,
  getCitadelGatehouse,
  isApiRequestError,
  listCitadels,
  listCitadelTemplates,
} from "@goatcitadel/mission-control-shared/api/client";
import { NativeCard, NativeGrid, NativeList, NativePageFrame } from "../NativeRoutePageLayout";
import { EmptyState, NativeButton, NoticeBanner } from "../primitives";
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

interface TemplateState {
  loading: boolean;
  error: string | null;
  items: CitadelTemplate[];
  busyTemplateId: string | null;
}

const INITIAL: OverviewState = { loading: true, error: null, staged: false, citadel: null, gatehouse: null };
const INITIAL_TEMPLATES: TemplateState = { loading: true, error: null, items: [], busyTemplateId: null };
const DEFAULT_CITADEL_KINDS: Array<CitadelTemplate["kind"]> = ["personal", "company"];

function listSection(label: string, values: string[]): { title: string; body?: string } | null {
  return values.length > 0 ? { title: label, body: values.join(" · ") } : null;
}

function selectDefaultTemplates(templates: CitadelTemplate[]): CitadelTemplate[] {
  return DEFAULT_CITADEL_KINDS.flatMap((kind) => {
    const template = templates.find((item) => item.kind === kind);
    return template ? [template] : [];
  });
}

/**
 * The Citadel overview (spec §2 Charter + Chambers, §20 Gatehouse posture). Reads
 * the active Citadel as the parent operating world; workspaces remain functional
 * zones inside it.
 */
export function CitadelOverviewRoutePage({
  route,
  activeWorkspaceId,
  activeWorkspaceName,
  activeCitadelId = activeWorkspaceId,
  activeCitadelName = activeWorkspaceName,
  navigate,
}: NativeRoutePagesProps) {
  const [state, setState] = useState<OverviewState>(INITIAL);
  const [templateState, setTemplateState] = useState<TemplateState>(INITIAL_TEMPLATES);

  useEffect(() => {
    let cancelled = false;
    setState((current) => ({ ...current, loading: true, error: null }));
    void listCitadels("active", 500)
      .then(async ({ items }) => {
        const listed = items.find((item) => item.citadelId === activeCitadelId || item.slug === activeCitadelId);
        if (!listed || listed.hasCharter === false) {
          return null;
        }
        const [citadel, gatehouse] = await Promise.all([
          getCitadel(activeCitadelId),
          getCitadelGatehouse(activeCitadelId),
        ]);
        return { citadel, gatehouse };
      })
      .then((loaded) => {
        if (!cancelled) {
          if (!loaded) {
            setState({ loading: false, error: null, staged: false, citadel: null, gatehouse: null });
          } else {
            setState({
              loading: false,
              error: null,
              staged: true,
              citadel: loaded.citadel,
              gatehouse: loaded.gatehouse,
            });
          }
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
  }, [activeCitadelId]);

  useEffect(() => {
    let cancelled = false;
    setTemplateState((current) => ({ ...current, loading: true, error: null }));
    void listCitadelTemplates()
      .then((items) => {
        if (!cancelled) {
          setTemplateState({ loading: false, error: null, items, busyTemplateId: null });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setTemplateState({ loading: false, error: getErrorMessage(error), items: [], busyTemplateId: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const { citadel, gatehouse } = state;
  const defaultTemplates = useMemo(() => selectDefaultTemplates(templateState.items), [templateState.items]);
  const charter = citadel?.charter ?? null;
  const charterRows = charter
    ? [
        listSection("Goals", charter.goals),
        listSection("Boundaries", charter.boundaries),
        listSection("Success", charter.successDefinition),
      ].filter((row): row is { title: string; body?: string } => row !== null)
    : [];

  const handleCreateFromTemplate = async (template: CitadelTemplate) => {
    setTemplateState((current) => ({ ...current, error: null, busyTemplateId: template.id }));
    try {
      const nextCitadel = await createCitadelFromTemplate(activeCitadelId, template.id);
      let nextGatehouse: Gatehouse | null = null;
      try {
        nextGatehouse = await getCitadelGatehouse(activeCitadelId);
      } catch (error: unknown) {
        if (!isApiRequestError(error) || error.status !== 404) {
          throw error;
        }
      }
      setState({ loading: false, error: null, staged: true, citadel: nextCitadel, gatehouse: nextGatehouse });
    } catch (error: unknown) {
      setTemplateState((current) => ({ ...current, error: getErrorMessage(error) }));
    } finally {
      setTemplateState((current) => ({ ...current, busyTemplateId: null }));
    }
  };

  return (
    <NativePageFrame
      icon={Castle}
      area="library"
      kicker={routeKicker(route)}
      title="Citadel"
      description={`How ${activeCitadelName} is governed as a Citadel — its Charter, Chambers, and Gatehouse posture. Active workspace: ${activeWorkspaceName}.`}
      loading={state.loading}
      error={state.error}
    >
      {!state.staged ? (
        <div className="mc-next-citadel-defaults">
          <EmptyState
            icon={<Castle size={20} />}
            title={`${activeCitadelName} needs a Charter`}
            description="A Citadel becomes operational once it has a Charter. Start with one of the default operating spaces, or use the Mason for a custom Blueprint."
            primaryAction={
              <NativeButton variant="outline" onClick={() => navigate({ area: "library", section: "citadel" })}>
                <Hammer size={16} />
                Open the Mason
              </NativeButton>
            }
          />
          <NativeCard
            title="Default Citadels"
            subtitle="Personal and Company are the two default starting points; both stay approval-governed until you connect Gates."
            className="mc-next-citadel-default-card"
            stats={[
              { label: "Defaults", value: String(defaultTemplates.length || 2) },
              { label: "Posture", value: "governed" },
            ]}
          >
            {templateState.error ? <NoticeBanner tone="warning" message={templateState.error} /> : null}
            {templateState.loading ? (
              <EmptyState size="compact" title="Loading default Citadels..." />
            ) : defaultTemplates.length > 0 ? (
              <div className="mc-next-citadel-template-grid">
                {defaultTemplates.map((template) => (
                  <article key={template.id} className="mc-next-citadel-template-card">
                    <header>
                      <span>{template.kind}</span>
                      <strong>{template.name}</strong>
                    </header>
                    <p>{template.description}</p>
                    <NativeButton
                      onClick={() => void handleCreateFromTemplate(template)}
                      disabled={templateState.busyTemplateId !== null}
                    >
                      <Sparkles size={16} />
                      {templateState.busyTemplateId === template.id ? "Creating..." : "Use template"}
                    </NativeButton>
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState size="compact" title="Default Citadel templates are unavailable." />
            )}
          </NativeCard>
        </div>
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
                <NativeList items={charterRows} emptyLabel="No goals or boundaries captured yet." density="compact" />
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
          <NativeCard
            title="Default Citadels"
            subtitle="Personal and Company are the default operating spaces available from the Mason."
            className="mc-next-citadel-default-card mc-next-citadel-default-card-promoted"
            stats={[
              { label: "Defaults", value: String(defaultTemplates.length || 2) },
              { label: "Active", value: charter?.kind ?? "workspace" },
            ]}
          >
            {templateState.error ? <NoticeBanner tone="warning" message={templateState.error} /> : null}
            {templateState.loading ? (
              <EmptyState size="compact" title="Loading default Citadels..." />
            ) : defaultTemplates.length > 0 ? (
              <div className="mc-next-citadel-template-grid">
                {defaultTemplates.map((template) => (
                  <article key={template.id} className="mc-next-citadel-template-card">
                    <header>
                      <span>{template.kind}</span>
                      <strong>{template.name}</strong>
                    </header>
                    <p>{template.description}</p>
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState size="compact" title="Default Citadel templates are unavailable." />
            )}
            <NativeButton
              variant="outline"
              onClick={() => navigate({ area: "library", section: "citadel", theme: route.theme })}
            >
              <Hammer size={16} />
              Open the Mason
            </NativeButton>
          </NativeCard>
        </NativeGrid>
      )}

      {state.staged ? (
        <p className="mc-next-citadel-footnote">
          <Shield size={12} aria-hidden="true" />
          Wards and Gates are evaluated deny-wins. <Lock size={12} aria-hidden="true" /> Sealed Chambers never widen
          access.
        </p>
      ) : null}
    </NativePageFrame>
  );
}
