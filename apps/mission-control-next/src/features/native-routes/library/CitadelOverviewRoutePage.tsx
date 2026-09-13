import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, Castle, Hammer, Lock, RotateCcw, Save, Shield, Sparkles } from "lucide-react";
import type { Citadel, CitadelGatehouseSummary, CitadelTemplate } from "@goatcitadel/contracts";
import {
  archiveCitadel,
  createCitadelFromTemplate,
  getCitadel,
  getCitadelGatehouse,
  isApiRequestError,
  listCitadels,
  listCitadelTemplates,
  restoreCitadel,
  upsertCitadelCharter,
} from "@goatcitadel/mission-control-shared/api/client";
import { NativeCard, NativeDisclosureCard, NativeGrid, NativeList, NativePageFrame } from "../NativeRoutePageLayout";
import { CitadelBriefPanel } from "./CitadelBriefPanel";
import { EmptyState, NativeButton, NoticeBanner } from "../primitives";
import { getErrorMessage, humanizeEnumToken } from "../shared/native-helpers";
import { DetailInspector } from "../../../components/DetailInspector";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { useSessionDraft } from "./session-drafts";
import { useDraftLeave } from "./DraftLeaveDialog";
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
  const [view, setView] = useState(route.view ?? "charter");
  const [editing, setEditing] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState<{ id: string; label: string; expectedRevision: string } | null>(null);
  const lifecycleBusyRef = useRef(false);
  const [approvedRevision, setApprovedRevision] = useState<string | undefined>();
  const leave = useDraftLeave();
  const charterDraft = useSessionDraft(`charter:${activeCitadelId}:purpose`, state.citadel?.charter.purpose ?? "", state.citadel?.charter.updatedAt, { label: "Charter purpose", active: editing, available: Boolean(state.citadel), onSave: (): Promise<boolean> => handleSaveCharter() });
  const charterPurpose = charterDraft.value;
  const setCharterPurpose = charterDraft.setValue;
  useEffect(() => setView(route.view ?? "charter"), [route.view]);
  const [lifecycleAction, setLifecycleAction] = useState<"save" | "archive" | "restore" | null>(null);
  const [actionNotice, setActionNotice] = useState<{ tone: "success" | "error" | "warning"; message: string } | null>(null);

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
        return {
          citadel: {
            ...citadel,
            record: citadel.record ?? listed,
          },
          gatehouse,
        };
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

  const handleSaveCharter = async (): Promise<boolean> => {
    if (!charter || charterPurpose.trim().length === 0 || (charterDraft.hasRemoteChanges && approvedRevision !== charter.updatedAt)) {
      return false;
    }
    setLifecycleAction("save");
    setActionNotice(null);
    try {
      const saved = await upsertCitadelCharter(activeCitadelId, {
        purpose: charterPurpose.trim(),
        kind: charter.kind,
        goals: charter.goals,
        boundaries: charter.boundaries,
        successDefinition: charter.successDefinition,
        defaultChamberId: charter.defaultChamberId,
        riskPosture: charter.riskPosture,
        modelPolicyDefault: charter.modelPolicyDefault,
      });
      setState((current) =>
        current.citadel ? { ...current, citadel: { ...current.citadel, charter: saved } } : current,
      );
      if (charterDraft.acceptSaved(saved.purpose, saved.updatedAt, charterPurpose)) setEditing(false);
      setActionNotice({ tone: "success", message: "Citadel Charter saved." });
      return true;
    } catch (error) {
      setActionNotice({ tone: "error", message: getErrorMessage(error) });
      return false;
    } finally {
      setLifecycleAction(null);
    }
  };

  const refreshRecord = async (citadelId: string): Promise<boolean> => {
    try {
      const refreshed = await getCitadel(citadelId);
      setState((current) => current.citadel?.citadelId === citadelId
        ? { ...current, citadel: { ...current.citadel, record: refreshed.record } } : current);
      return true;
    } catch (error) { setActionNotice({ tone: "error", message: getErrorMessage(error) }); return false; }
  };
  const handleArchive = async () => {
    if (!confirmArchive || lifecycleBusyRef.current) return;
    const reviewed = confirmArchive;
    lifecycleBusyRef.current = true;
    setLifecycleAction("archive");
    setActionNotice(null);
    try {
      const record = await archiveCitadel(reviewed.id, reviewed.expectedRevision);
      setConfirmArchive(null);
      setState((current) => (current.citadel?.citadelId === reviewed.id ? { ...current, citadel: { ...current.citadel, record } } : current));
      setActionNotice({ tone: "success", message: "Citadel archived. Restore it before using it for new work." });
    } catch (error) {
      setConfirmArchive(null);
      if (isApiRequestError(error) && error.status === 409) {
        if (await refreshRecord(reviewed.id)) setActionNotice({ tone: "warning", message: "The Citadel changed. Review its current profile and open a new archive confirmation. Your Charter draft is preserved." });
      } else setActionNotice({ tone: "error", message: getErrorMessage(error) });
    } finally {
      lifecycleBusyRef.current = false;
      setLifecycleAction(null);
    }
  };

  const handleRestore = async () => {
    const reviewed = state.citadel?.record;
    if (!reviewed?.revision || lifecycleBusyRef.current) return;
    lifecycleBusyRef.current = true;
    setLifecycleAction("restore");
    setActionNotice(null);
    try {
      const record = await restoreCitadel(reviewed.citadelId, reviewed.revision);
      setState((current) => (current.citadel?.citadelId === reviewed.citadelId ? { ...current, citadel: { ...current.citadel, record } } : current));
      setActionNotice({ tone: "success", message: "Citadel restored." });
    } catch (error) {
      if (isApiRequestError(error) && error.status === 409) {
        if (await refreshRecord(reviewed.citadelId)) setActionNotice({ tone: "warning", message: "The Citadel changed. Review its current profile before restoring it again." });
      } else setActionNotice({ tone: "error", message: getErrorMessage(error) });
    } finally {
      lifecycleBusyRef.current = false;
      setLifecycleAction(null);
    }
  };

  return (
    <NativePageFrame
      icon={Castle}
      area="library"
      kicker={routeKicker(route)}
      title="Citadel"
      description={`How ${activeCitadelName} is governed as a Citadel — its Charter, Chambers, and Gatehouse posture. Active workspace: ${activeWorkspaceName}.`}
      loading={state.loading && !state.citadel}
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
          <NativeDisclosureCard id="citadel-defaults"
            title="Default Citadels"
            subtitle="Personal and Company are the two default starting points; both stay approval-governed until you connect Gates."
            className="mc-next-citadel-default-card"
            stats={[
              { label: "Defaults", value: templateState.error ? "Unavailable" : String(defaultTemplates.length) },
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
          </NativeDisclosureCard>
        </div>
      ) : (
        <>
          {actionNotice ? <NoticeBanner tone={actionNotice.tone} message={actionNotice.message} /> : null}
          <div className="mc-next-settings-button-row" role="group" aria-label="Citadel view">{(["charter", "chambers", "gatehouse"] as const).map((item) => <NativeButton key={item} variant="ghost" aria-pressed={view === item} onClick={() => leave.request(() => { setView(item); navigate({ ...route, view: item }); }, [charterDraft.key])}>{item[0]!.toUpperCase() + item.slice(1)}</NativeButton>)}</div>
          <NativeDisclosureCard id="citadel-brief" lazy title="Citadel brief"><CitadelBriefPanel citadelId={activeCitadelId} /></NativeDisclosureCard>
          <NativeGrid className="mc-next-calm-directory">
            {view === "charter" ? <NativeCard
              title="Charter"
              subtitle="The purpose and boundaries that define this Citadel."
              stats={
                charter
                  ? [
                      { label: "Kind", value: humanizeEnumToken(charter.kind) },
                      { label: "Posture", value: humanizeEnumToken(charter.riskPosture) },
                      {
                        label: "Lifecycle",
                        value: humanizeEnumToken(citadel?.record?.lifecycleStatus ?? "active"),
                      },
                    ]
                  : undefined
              }
            >
              {charter ? (
                <>
                  <p>{charter.purpose}</p>
                  <NativeButton variant="outline" onClick={() => setEditing(true)}>Edit Charter{charterDraft.isDirty ? " · Unsaved" : ""}</NativeButton>
                  <DetailInspector open={editing} title="Edit Charter" subtitle={charterDraft.isDirty ? "Unsaved changes" : activeCitadelName} onClose={() => leave.request(() => setEditing(false), [charterDraft.key])}>
                    {charterDraft.hasRemoteChanges && approvedRevision !== charter.updatedAt ? <><NoticeBanner tone="warning" message="The Charter changed after this draft began. Review the latest purpose before applying your draft." /><p>{charter.purpose}</p><NativeButton variant="outline" onClick={() => setApprovedRevision(charter.updatedAt)}>Apply draft to current Charter</NativeButton></> : null}
                  <label className="mc-next-mason-field">
                    <span>Purpose</span>
                    <textarea
                      aria-label="Purpose"
                      className="mc-next-settings-textarea"
                      value={charterPurpose}
                      rows={3}
                      onChange={(event) => setCharterPurpose(event.target.value)}
                    />
                  </label>
                  <div className="mc-next-settings-button-row">
                    <NativeButton
                      variant="default"
                      disabled={lifecycleAction !== null || charterPurpose.trim().length === 0}
                      onClick={() => void handleSaveCharter()}
                    >
                      <Save size={16} />
                      {lifecycleAction === "save" ? "Saving…" : "Save charter"}
                    </NativeButton>
                    {citadel?.record?.lifecycleStatus === "archived" ? (
                      <NativeButton
                        variant="outline"
                        disabled={lifecycleAction !== null}
                        onClick={() => void handleRestore()}
                      >
                        <RotateCcw size={16} />
                        {lifecycleAction === "restore" ? "Restoring…" : "Restore Citadel"}
                      </NativeButton>
                    ) : (
                      <NativeButton
                        variant="destructive"
                        disabled={lifecycleAction !== null}
                        onClick={() => citadel?.record?.revision && setConfirmArchive({ id: citadel.record.citadelId, label: citadel.record.name, expectedRevision: citadel.record.revision })}
                      >
                        <Archive size={16} />
                        {lifecycleAction === "archive" ? "Archiving…" : "Archive Citadel"}
                      </NativeButton>
                    )}
                  </div>
                  </DetailInspector>
                  <NativeList items={charterRows} emptyLabel="No goals or boundaries captured yet." density="compact" />
                </>
              ) : (
                <EmptyState size="compact" title="No Charter found." />
              )}
            </NativeCard> : null}

            {view === "chambers" ? <NativeCard
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
            </NativeCard> : null}

            {gatehouse && view === "gatehouse" ? (
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
                    { title: "Risk posture", body: humanizeEnumToken(gatehouse.riskPosture) },
                    { title: "Model policy", body: humanizeEnumToken(gatehouse.modelPolicyDefault) },
                    { title: "Sharing", body: humanizeEnumToken(gatehouse.sharingDefault) },
                    { title: "External writes", body: humanizeEnumToken(gatehouse.externalWritesDefault) },
                  ]}
                  density="compact"
                />
              </NativeCard>
            ) : null}
          </NativeGrid>
        </>
      )}

      {/* Rendered outside the posture grid: as a spanning (grid-column 1/-1)
          member it pinned the auto-fit track count at its maximum, leaving a
          permanently empty fourth track beside the three posture cards. */}
      {state.staged ? (
        <NativeGrid className="mc-next-calm-directory">
          <NativeDisclosureCard id="citadel-defaults"
            title="Default Citadels"
            subtitle="Personal and Company are the default operating spaces available from the Mason."
            className="mc-next-citadel-default-card mc-next-citadel-default-card-promoted"
            stats={[
              { label: "Defaults", value: templateState.error ? "Unavailable" : String(defaultTemplates.length) },
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
          </NativeDisclosureCard>
        </NativeGrid>
      ) : null}

      {state.staged ? (
        <p className="mc-next-citadel-footnote">
          <Shield size={12} aria-hidden="true" />
          Wards and Gates are evaluated deny-wins. <Lock size={12} aria-hidden="true" /> Sealed Chambers never widen
          access.
        </p>
      ) : null}
      {leave.dialog}
      <ConfirmModal open={confirmArchive !== null} title="Archive Citadel?" message={`Archive ${confirmArchive?.label ?? activeCitadelName}? Restore it before using it for new work.`} confirmLabel="Archive Citadel" danger pending={lifecycleAction === "archive"} disableDismiss={lifecycleAction === "archive"} onCancel={() => setConfirmArchive(null)} onConfirm={() => void handleArchive()} />
    </NativePageFrame>
  );
}
