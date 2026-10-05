import { useEffect, useState } from "react";
import { Archive, Castle, Hammer, Lock, RotateCcw, Save, Shield, Sparkles } from "lucide-react";
import { NativeCard, NativeDisclosureCard, NativeGrid, NativeList, NativePageFrame } from "../NativeRoutePageLayout";
import { CitadelBriefPanel } from "./CitadelBriefPanel";
import { EmptyState, NativeButton, NoticeBanner } from "../primitives";
import { humanizeEnumToken } from "../shared/native-helpers";
import { DetailInspector } from "../../../components/DetailInspector";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { CHECKING_FOR_CHANGES } from "../settings/use-directory-lifecycle";
import { useCitadelOverview } from "./use-citadel-overview";
import { routeKicker } from "@next/app/route-model";
import type { NativeRoutePagesProps } from "../types";
import "./citadel-confirmation.css";

function listSection(label: string, values: string[]): { title: string; body?: string } | null {
  return values.length > 0 ? { title: label, body: values.join(" · ") } : null;
}

export function CitadelOverviewRoutePage({
  route,
  activeWorkspaceId,
  activeWorkspaceName,
  activeCitadelId = activeWorkspaceId,
  activeCitadelName = activeWorkspaceName,
  navigate,
}: NativeRoutePagesProps) {
  const [view, setView] = useState(route.view ?? "charter");
  const control = useCitadelOverview(activeCitadelId, JSON.stringify([route.view, view]));
  const {
    state,
    templateState,
    defaultTemplates,
    charterDraft,
    editing,
    leave,
    lifecycle,
    lifecycleTarget,
    lifecycleLocked,
    lifecycleMessage,
  } = control;
  const { citadel, gatehouse } = state;
  const charter = citadel?.charter ?? null;
  const charterPurpose = charterDraft.value;
  const setCharterPurpose = control.changePurpose;
  const setEditing = (open: boolean) => (open ? control.openEditor() : control.closeEditor());
  const lifecycleAction = control.pending ? "save" : null;
  const actionNotice = control.notice;
  const handleCreateFromTemplate = control.requestTemplate;
  const handleSaveCharter = control.requestCharter;
  useEffect(() => setView(route.view ?? "charter"), [route.view]);
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
      description={`How ${activeCitadelName} is governed as a Citadel — its Charter, Chambers, and Gatehouse posture. Active workspace: ${activeWorkspaceName}.`}
      loading={state.loading && !state.citadel}
      error={state.error}
    >
      {actionNotice ? <NoticeBanner tone={actionNotice.tone} message={actionNotice.message} /> : null}
      {control.attempt.message ? (
        <NoticeBanner tone={control.locked ? "warning" : "info"} message={control.attempt.message} />
      ) : null}
      {lifecycle.notice || lifecycleMessage ? (
        <NoticeBanner tone={lifecycleLocked ? "warning" : "info"} message={lifecycle.notice ?? lifecycleMessage!} />
      ) : null}
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
          <NativeDisclosureCard
            id="citadel-defaults"
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
                    <details className="mc-next-inline-disclosure">
                      <summary>Template contents</summary>
                      <NativeList
                        items={[
                          { title: "Purpose", body: template.purpose },
                          { title: "Goals", body: template.goals.join(" · ") },
                          { title: "Boundaries", body: template.boundaries.join(" · ") },
                          { title: "Success", body: template.successDefinition.join(" · ") },
                          { title: "Risk posture", body: humanizeEnumToken(template.riskPosture ?? "balanced") },
                          {
                            title: "Model policy",
                            body: humanizeEnumToken(template.modelPolicyDefault ?? "hybrid_guarded"),
                          },
                          {
                            title: "Chambers",
                            body: template.chambers
                              .map(
                                (chamber) =>
                                  `${chamber.name} (${humanizeEnumToken(chamber.sensitivity ?? "private")}${chamber.sealed ? ", sealed" : ""})`,
                              )
                              .join(" · "),
                          },
                        ]}
                        emptyLabel="No template contents available."
                        density="compact"
                      />
                    </details>
                    <NativeButton
                      onClick={() => void handleCreateFromTemplate(template)}
                      disabled={
                        control.locked ||
                        lifecycleLocked ||
                        state.loading ||
                        !state.snapshot ||
                        state.snapshot.record?.lifecycleStatus === "archived"
                      }
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
          <div className="mc-next-settings-button-row" role="group" aria-label="Citadel view">
            {(["charter", "chambers", "gatehouse"] as const).map((item) => (
              <NativeButton
                key={item}
                variant="ghost"
                aria-pressed={view === item}
                onClick={() =>
                  leave.request(() => {
                    setView(item);
                    navigate({ ...route, view: item });
                  }, [charterDraft.key])
                }
              >
                {item[0]!.toUpperCase() + item.slice(1)}
              </NativeButton>
            ))}
          </div>
          <NativeDisclosureCard id="citadel-brief" lazy title="Citadel brief">
            <CitadelBriefPanel citadelId={activeCitadelId} />
          </NativeDisclosureCard>
          <NativeGrid className="mc-next-calm-directory">
            {view === "charter" ? (
              <NativeCard
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
                    <NativeButton variant="outline" disabled={control.pending} onClick={() => setEditing(true)}>
                      Edit Charter{charterDraft.isDirty ? " · Unsaved" : ""}
                    </NativeButton>
                    <DetailInspector
                      open={editing}
                      title="Edit Charter"
                      subtitle={charterDraft.isDirty ? "Unsaved changes" : activeCitadelName}
                      onClose={control.closeEditor}
                    >
                      {charterDraft.hasRemoteChanges ? (
                        <>
                          <NoticeBanner
                            tone="warning"
                            message="The Citadel changed after this draft began. Review the current Charter and Chambers before applying your draft."
                          />
                          <p>{charter.purpose}</p>
                          <p>Chambers: {citadel?.chambers.map((chamber) => chamber.name).join(", ") || "None"}</p>
                          <NativeButton variant="outline" onClick={charterDraft.rebaseToCurrent}>
                            Apply draft to current Charter
                          </NativeButton>
                        </>
                      ) : null}
                      <label className="mc-next-mason-field">
                        <span>Purpose</span>
                        <textarea
                          aria-label="Purpose"
                          className="mc-next-settings-textarea"
                          value={charterPurpose}
                          rows={3}
                          disabled={control.locked}
                          onChange={(event) => setCharterPurpose(event.target.value)}
                        />
                      </label>
                      <div className="mc-next-settings-button-row">
                        <NativeButton
                          variant="default"
                          disabled={
                            control.locked ||
                            lifecycleLocked ||
                            charterPurpose.trim().length === 0 ||
                            charterDraft.hasRemoteChanges ||
                            citadel?.record?.lifecycleStatus === "archived"
                          }
                          onClick={() => void handleSaveCharter()}
                        >
                          <Save size={16} />
                          {lifecycleAction === "save" ? "Saving…" : "Save charter"}
                        </NativeButton>
                        {citadel?.record?.lifecycleStatus === "archived" ? (
                          <NativeButton
                            variant="outline"
                            disabled={control.locked || !lifecycleTarget || lifecycleLocked}
                            onClick={() => lifecycleTarget && lifecycle.request(lifecycleTarget)}
                          >
                            <RotateCcw size={16} />
                            {lifecycle.pending ? "Restoring…" : "Restore Citadel"}
                          </NativeButton>
                        ) : (
                          <NativeButton
                            variant="destructive"
                            disabled={control.locked || !lifecycleTarget || lifecycleLocked}
                            onClick={() => lifecycleTarget && lifecycle.request(lifecycleTarget)}
                          >
                            <Archive size={16} />
                            {lifecycle.pending ? "Archiving…" : "Archive Citadel"}
                          </NativeButton>
                        )}
                      </div>
                    </DetailInspector>
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
            ) : null}

            {view === "chambers" ? (
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
            ) : null}

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
          <NativeDisclosureCard
            id="citadel-defaults"
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
      <ConfirmModal
        className="mc-next-citadel-confirmation"
        open={Boolean(control.review)}
        title={control.review?.kind === "template" ? "Apply this Citadel template?" : "Save this Charter?"}
        message={
          control.review
            ? `${activeCitadelName} · ${activeCitadelId} · Reviewed structure revision ${control.review.before.revision}. ${control.review.kind === "template" ? `${control.review.template.name} · template revision ${control.review.template.revision}. Create the template Charter and add its Chambers; the default Chamber is cleared. Connections and grants retain their existing setup steps.` : `Purpose: ${control.review.input.purpose}. Other Charter fields and Chambers keep their reviewed values.`}`
            : ""
        }
        confirmLabel={control.review?.kind === "template" ? "Apply template" : "Confirm Charter save"}
        pending={control.pending}
        disableDismiss={control.pending}
        onCancel={control.cancelReview}
        onConfirm={() => void control.confirm()}
      />
      <ConfirmModal
        className="mc-next-citadel-confirmation"
        open={Boolean(lifecycle.review)}
        title={lifecycle.review?.action === "restore" ? "Restore Citadel?" : "Archive Citadel?"}
        message={`${lifecycle.review?.record.name ?? activeCitadelName} · ${lifecycle.review?.kind === "citadel" ? lifecycle.review.record.citadelId : ""} · Reviewed profile revision ${lifecycle.review?.record.revision ?? "Unavailable"}. ${lifecycle.review?.action === "restore" ? "Restore this record to the active directory. Your current selection stays as saved." : "The record stays in the archived directory. Stored work and your Charter draft are retained; any retained Citadel profile edit draft will be discarded after confirmation."}${lifecycle.checking ? ` ${CHECKING_FOR_CHANGES}` : ""}`}
        confirmLabel={lifecycle.review?.action === "restore" ? "Restore Citadel" : "Archive Citadel"}
        confirmDisabled={!lifecycle.available}
        danger={lifecycle.review?.action === "archive"}
        pending={lifecycle.pending}
        disableDismiss={lifecycle.pending}
        onCancel={lifecycle.cancel}
        onConfirm={() => void lifecycle.confirm()}
      />
    </NativePageFrame>
  );
}
