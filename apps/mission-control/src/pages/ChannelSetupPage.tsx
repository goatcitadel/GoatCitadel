import { useEffect, useMemo, useState } from "react";
import type {
  ChannelSetupDefinition,
  ChannelSetupDraft,
  ChannelSetupFieldDefinition,
  ChannelSetupIssue,
  ChannelSetupRichBlock,
  ChannelSetupStepDefinition,
  ChannelSetupTestResult,
  ChannelSetupValidationResult,
  IntegrationCatalogEntry,
  IntegrationConnection,
} from "@goatcitadel/contracts";
import "../styles/integrations.css";
import {
  createChannelRepairDraft,
  createChannelRotateSecretDraft,
  createChannelSetupDraft,
  fetchChannelSetupDefinition,
  fetchChannelSetupDefinitions,
  fetchChannelSetupDrafts,
  fetchIntegrationCatalog,
  fetchIntegrationConnections,
  finalizeChannelSetupDraft,
  retestChannelConnection,
  testChannelSetupDraft,
  updateChannelSetupDraft,
  validateChannelSetupDraft,
} from "../api/client";
import { ActionButton } from "../components/ActionButton";
import { CardSkeleton } from "../components/CardSkeleton";
import { FieldHelp } from "../components/FieldHelp";
import { Panel } from "../components/Panel";
import { StatusChip } from "../components/StatusChip";
import { GCEmptyState } from "../components/ui/GCEmptyState";
import { recordClientDiagnostic } from "../state/dev-diagnostics-store";

type BusyAction =
  | "start"
  | "save"
  | "validate"
  | "test"
  | "finalize"
  | "repair"
  | "rotate"
  | "retest"
  | null;

export function ChannelSetupPage() {
  const [catalog, setCatalog] = useState<IntegrationCatalogEntry[]>([]);
  const [connections, setConnections] = useState<IntegrationConnection[]>([]);
  const [guidedDefinitions, setGuidedDefinitions] = useState<ChannelSetupDefinition[]>([]);
  const [selectedCatalogId, setSelectedCatalogId] = useState("");
  const [definition, setDefinition] = useState<ChannelSetupDefinition | null>(null);
  const [definitionError, setDefinitionError] = useState<string | null>(null);
  const [definitionLoading, setDefinitionLoading] = useState(false);
  const [draft, setDraft] = useState<ChannelSetupDraft | null>(null);
  const [recentDrafts, setRecentDrafts] = useState<ChannelSetupDraft[]>([]);
  const [validation, setValidation] = useState<ChannelSetupValidationResult | null>(null);
  const [testResult, setTestResult] = useState<ChannelSetupTestResult | null>(null);
  const [currentStepId, setCurrentStepId] = useState("");
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pageNotice, setPageNotice] = useState<string | null>(null);
  const [manualJsonOpen, setManualJsonOpen] = useState(false);
  const [manualJsonText, setManualJsonText] = useState("{}");
  const [manualJsonError, setManualJsonError] = useState<string | null>(null);
  const [isInitialLoading, setIsInitialLoading] = useState(true);

  const guidedCatalogIds = useMemo(
    () => new Set(guidedDefinitions.map((item) => item.catalog.catalogId)),
    [guidedDefinitions],
  );

  const guidedChannelLabels = useMemo(() => (
    guidedDefinitions
      .map((item) => item.catalog.label)
      .sort((left, right) => left.localeCompare(right))
      .join(", ")
  ), [guidedDefinitions]);

  useEffect(() => {
    void loadPage();
  }, []);

  useEffect(() => {
    if (!selectedCatalogId) {
      setDefinition(null);
      setDefinitionError(null);
      setRecentDrafts([]);
      return;
    }
    if (!guidedCatalogIds.has(selectedCatalogId)) {
      setDefinition(null);
      setDefinitionError(null);
      setRecentDrafts([]);
      return;
    }
    void loadDefinition(selectedCatalogId);
    void loadDrafts(selectedCatalogId);
  }, [guidedCatalogIds, selectedCatalogId]);

  const visibleSteps = useMemo(() => {
    if (!definition) {
      return [];
    }
    return definition.wizard.steps.filter((step) => isStepVisible(step, draft?.draft));
  }, [definition, draft?.draft]);

  const selectedCatalog = catalog.find((item) => item.catalogId === selectedCatalogId) ?? null;
  const currentStep = visibleSteps.find((step) => step.id === currentStepId) ?? null;

  useEffect(() => {
    if (visibleSteps.length === 0) {
      setCurrentStepId("");
      return;
    }
    if (!visibleSteps.some((step) => step.id === currentStepId)) {
      setCurrentStepId(
        definition && draft
          ? findResumeStepId(definition, draft)
          : (visibleSteps[0]?.id ?? ""),
      );
    }
  }, [visibleSteps, currentStepId, definition, draft]);

  useEffect(() => {
    if (!draft) {
      setManualJsonText("{}");
      return;
    }
    setManualJsonText(JSON.stringify(draft.draft, null, 2));
  }, [draft]);

  useEffect(() => {
    if (!draft || !definition || !currentStep) {
      return;
    }
    trackWizardEvent("channel_step_viewed", {
      draftId: draft.draftId,
      catalogId: draft.catalogId,
      archetype: definition.wizard.archetype,
      tier: definition.telemetry.tier,
      lifecycleMode: draft.lifecycleMode,
      contentVersion: definition.wizard.contentVersion,
      validationVersion: definition.validation.validationVersion,
      testVersion: definition.testing.testVersion,
      stepId: currentStep.id,
      manualModeUsed: manualJsonOpen,
      });
  }, [currentStep?.id, definition?.catalog.catalogId, draft?.draftId, manualJsonOpen]);

  useEffect(() => {
    if (!manualJsonOpen || !draft || !definition) {
      return;
    }
    trackWizardEvent("channel_guided_to_manual_switched", {
      draftId: draft.draftId,
      catalogId: draft.catalogId,
      archetype: definition.wizard.archetype,
      tier: definition.telemetry.tier,
      lifecycleMode: draft.lifecycleMode,
      stepId: currentStepId,
      manualModeUsed: true,
    });
  }, [manualJsonOpen, draft?.draftId, definition?.catalog.catalogId, currentStepId]);

  async function loadPage() {
    setIsInitialLoading(true);
    try {
      const [catalogResponse, connectionResponse, setupDefinitionResponse] = await Promise.all([
        fetchIntegrationCatalog("channel"),
        fetchIntegrationConnections("channel"),
        fetchChannelSetupDefinitions(),
      ]);
      setCatalog(catalogResponse.items);
      setConnections(connectionResponse.items);
      setGuidedDefinitions(setupDefinitionResponse.items);
      if (!selectedCatalogId) {
        const guidedIds = new Set(setupDefinitionResponse.items.map((item) => item.catalog.catalogId));
        const preferred = catalogResponse.items.find((item) => (
          item.catalogId === "channel.discord" && guidedIds.has(item.catalogId)
        )) ?? catalogResponse.items.find((item) => guidedIds.has(item.catalogId))
          ?? catalogResponse.items[0];
        setSelectedCatalogId(preferred?.catalogId ?? "");
      }
      setPageError(null);
    } catch (error) {
      setPageError((error as Error).message);
    } finally {
      setIsInitialLoading(false);
    }
  }

  async function loadDefinition(catalogId: string): Promise<ChannelSetupDefinition | null> {
    setDefinitionLoading(true);
    setDefinitionError(null);
    try {
      const next = await fetchChannelSetupDefinition(catalogId);
      setDefinition(next);
      return next;
    } catch (error) {
      setDefinition(null);
      setDefinitionError((error as Error).message);
      return null;
    } finally {
      setDefinitionLoading(false);
    }
  }

  async function loadDrafts(catalogId: string) {
    try {
      const response = await fetchChannelSetupDrafts({ catalogId, limit: 12 });
      setRecentDrafts(response.items);
    } catch {
      setRecentDrafts([]);
    }
  }

  async function startDraft(
    mode: "create" | "edit" | "repair" | "rotate_secret",
    connection?: IntegrationConnection,
    preferredStepId?: string,
  ) {
    const catalogId = connection?.catalogId ?? selectedCatalogId;
    if (!catalogId) {
      return;
    }
    setBusyAction(mode === "create" ? "start" : mode === "repair" ? "repair" : mode === "rotate_secret" ? "rotate" : "start");
    setPageNotice(null);
    setPageError(null);
    try {
      const activeDefinition = definition?.catalog.catalogId === catalogId ? definition : await loadDefinition(catalogId);
      if (!activeDefinition) {
        throw new Error("Guided setup is not available for this channel yet.");
      }
      const created = mode === "repair" && connection
        ? await createChannelRepairDraft(connection.connectionId)
        : mode === "rotate_secret" && connection
          ? await createChannelRotateSecretDraft(connection.connectionId)
          : await createChannelSetupDraft({
            catalogId,
            connectionId: connection?.connectionId,
            lifecycleMode: mode,
          });
      setSelectedCatalogId(catalogId);
      setDraft(created);
      upsertRecentDraft(created);
      setValidation(null);
      setTestResult(null);
      setPageNotice(connection
        ? `${titleCaseLifecycle(created.lifecycleMode)} draft ready for ${connection.label}.`
        : `Guided setup started for ${activeDefinition.catalog.label}.`);
      setCurrentStepId(preferredStepId ?? findStartStepId(activeDefinition, created.lifecycleMode));
      trackWizardEvent("channel_wizard_started", {
        draftId: created.draftId,
        catalogId,
        archetype: activeDefinition.wizard.archetype,
        tier: activeDefinition.telemetry.tier,
        lifecycleMode: created.lifecycleMode,
        contentVersion: activeDefinition.wizard.contentVersion,
        validationVersion: activeDefinition.validation.validationVersion,
        testVersion: activeDefinition.testing.testVersion,
        manualModeUsed: false,
      });
    } catch (error) {
      setPageError((error as Error).message);
    } finally {
      setBusyAction(null);
    }
  }

  async function saveDraftState(nextDraftState?: ChannelSetupDraft) {
    const activeDraft = nextDraftState ?? draft;
    if (!activeDraft) {
      return null;
    }
    const updated = await updateChannelSetupDraft(activeDraft.draftId, {
      label: activeDraft.label,
      enabled: activeDraft.enabled,
      draft: activeDraft.draft,
    });
    setDraft(updated);
    upsertRecentDraft(updated);
    return updated;
  }

  async function handleSaveDraft() {
    if (!draft) {
      return;
    }
    setBusyAction("save");
    setPageNotice(null);
    setPageError(null);
    try {
      await saveDraftState();
      setPageNotice("Draft saved.");
      if (draft && definition) {
        trackWizardEvent("channel_step_completed", {
          draftId: draft.draftId,
          catalogId: draft.catalogId,
          archetype: definition.wizard.archetype,
          tier: definition.telemetry.tier,
          lifecycleMode: draft.lifecycleMode,
          contentVersion: definition.wizard.contentVersion,
          stepId: currentStepId,
          manualModeUsed: manualJsonOpen,
        });
      }
    } catch (error) {
      setPageError((error as Error).message);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleValidate() {
    if (!draft) {
      return;
    }
    setBusyAction("validate");
    setPageNotice(null);
    setPageError(null);
    try {
      if (draft && definition) {
        trackWizardEvent("channel_validation_started", {
          draftId: draft.draftId,
          catalogId: draft.catalogId,
          archetype: definition.wizard.archetype,
          tier: definition.telemetry.tier,
          lifecycleMode: draft.lifecycleMode,
          validationVersion: definition.validation.validationVersion,
          stepId: currentStepId,
          manualModeUsed: manualJsonOpen,
        });
      }
      const persisted = await saveDraftState();
      if (!persisted) {
        return;
      }
      const result = await validateChannelSetupDraft(persisted.draftId);
      setValidation(result);
      setPageNotice(result.status === "ok" ? "Validation passed." : "Validation completed with follow-up items.");
      if (definition) {
        trackWizardEvent(result.status === "error" ? "channel_validation_failed" : "channel_step_completed", {
          draftId: persisted.draftId,
          catalogId: persisted.catalogId,
          archetype: definition.wizard.archetype,
          tier: definition.telemetry.tier,
          lifecycleMode: persisted.lifecycleMode,
          validationVersion: definition.validation.validationVersion,
          stepId: currentStepId,
          failureCategory: result.issues.find((issue) => issue.failureCategory)?.failureCategory,
          manualModeUsed: manualJsonOpen,
        });
      }
    } catch (error) {
      setPageError((error as Error).message);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleTest() {
    if (!draft) {
      return;
    }
    setBusyAction("test");
    setPageNotice(null);
    setPageError(null);
    try {
      if (draft && definition) {
        trackWizardEvent("channel_retest_started", {
          draftId: draft.draftId,
          catalogId: draft.catalogId,
          archetype: definition.wizard.archetype,
          tier: definition.telemetry.tier,
          lifecycleMode: draft.lifecycleMode,
          testVersion: definition.testing.testVersion,
          stepId: currentStepId,
          manualModeUsed: manualJsonOpen,
        });
      }
      const persisted = await saveDraftState();
      if (!persisted) {
        return;
      }
      const result = await testChannelSetupDraft(persisted.draftId);
      setTestResult(result);
      setPageNotice(result.status === "ok" ? "Live test passed." : "Test completed with follow-up items.");
      if (definition) {
        trackWizardEvent(result.status === "error" ? "channel_test_failed" : "channel_retest_completed", {
          draftId: persisted.draftId,
          catalogId: persisted.catalogId,
          archetype: definition.wizard.archetype,
          tier: definition.telemetry.tier,
          lifecycleMode: persisted.lifecycleMode,
          testVersion: definition.testing.testVersion,
          stepId: currentStepId,
          failureCategory: result.issues.find((issue) => issue.failureCategory)?.failureCategory,
          manualModeUsed: manualJsonOpen,
        });
      }
    } catch (error) {
      setPageError((error as Error).message);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleFinalize() {
    if (!draft) {
      return;
    }
    setBusyAction("finalize");
    setPageNotice(null);
    setPageError(null);
    try {
      if (draft && definition) {
        trackWizardEvent("channel_finalize_started", {
          draftId: draft.draftId,
          catalogId: draft.catalogId,
          archetype: definition.wizard.archetype,
          tier: definition.telemetry.tier,
          lifecycleMode: draft.lifecycleMode,
          stepId: currentStepId,
          manualModeUsed: manualJsonOpen,
        });
      }
      const persisted = await saveDraftState();
      if (!persisted) {
        return;
      }
      const result = await finalizeChannelSetupDraft(persisted.draftId);
      setValidation(result.validation);
      setTestResult(result.test ?? null);
      setPageNotice(`${result.connection.label} is ready.`);
      await loadPage();
      await loadDrafts(result.connection.catalogId);
      if (definition) {
        trackWizardEvent("channel_finalize_succeeded", {
          draftId: persisted.draftId,
          catalogId: persisted.catalogId,
          archetype: definition.wizard.archetype,
          tier: definition.telemetry.tier,
          lifecycleMode: persisted.lifecycleMode,
          stepId: currentStepId,
          manualModeUsed: manualJsonOpen,
        });
      }
    } catch (error) {
      setPageError((error as Error).message);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRetest(connection: IntegrationConnection) {
    setBusyAction("retest");
    setPageNotice(null);
    setPageError(null);
    try {
      const result = await retestChannelConnection(connection.connectionId);
      setTestResult(result);
      setPageNotice(result.status === "ok" ? `Re-test passed for ${connection.label}.` : `Re-test completed for ${connection.label}.`);
      trackWizardEvent(result.status === "error" ? "channel_test_failed" : "channel_retest_completed", {
        catalogId: connection.catalogId,
        lifecycleMode: "retest",
        failureCategory: result.issues.find((issue) => issue.failureCategory)?.failureCategory,
      });
    } catch (error) {
      setPageError((error as Error).message);
    } finally {
      setBusyAction(null);
    }
  }

  function updateDraft(mutator: (current: ChannelSetupDraft) => ChannelSetupDraft) {
    setDraft((current) => current ? mutator(current) : current);
    setValidation(null);
    setTestResult(null);
  }

  function handleFieldChange(fieldKey: string, value: unknown) {
    updateDraft((current) => ({
      ...current,
      draft: {
        ...current.draft,
        [fieldKey]: value,
      },
    }));
  }

  function applyManualJson() {
    if (!draft) {
      return;
    }
    try {
      const parsed = JSON.parse(manualJsonText) as Record<string, unknown>;
      updateDraft((current) => ({ ...current, draft: parsed }));
      setManualJsonError(null);
      setPageNotice("Manual JSON applied to the draft.");
    } catch (error) {
      setManualJsonError((error as Error).message);
    }
  }

  function resumeDraft(nextDraft: ChannelSetupDraft) {
    const activeDefinition = definition?.catalog.catalogId === nextDraft.catalogId ? definition : null;
    setSelectedCatalogId(nextDraft.catalogId);
    setDraft(nextDraft);
    setValidation(null);
    setTestResult(null);
    setManualJsonOpen(false);
    setCurrentStepId(
      activeDefinition
        ? findResumeStepId(activeDefinition, nextDraft)
        : "",
    );
    trackWizardEvent("channel_draft_resumed", {
      draftId: nextDraft.draftId,
      catalogId: nextDraft.catalogId,
      lifecycleMode: nextDraft.lifecycleMode,
      manualModeUsed: false,
    });
  }

  function upsertRecentDraft(nextDraft: ChannelSetupDraft) {
    setRecentDrafts((current) => [nextDraft, ...current.filter((item) => item.draftId !== nextDraft.draftId)]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 12));
  }

  function trackWizardEvent(event: string, context: Record<string, unknown>) {
    recordClientDiagnostic({
      level: "info",
      category: "integrations",
      event,
      message: `Channel setup event: ${event}`,
      route: "/integrations/channels",
      context,
    });
  }

  function jumpToFieldCollection() {
    if (!definition) {
      return;
    }
    const target = definition.wizard.steps.find((step) => step.kind === "field-collection")?.id
      ?? definition.wizard.steps[0]?.id
      ?? "";
    if (!draft) {
      void startDraft("create", undefined, target);
      return;
    }
    setCurrentStepId(target);
  }

  return (
    <div className="stack-lg">
      {pageError ? <div className="channel-setup-banner channel-setup-banner-error">{pageError}</div> : null}
      {pageNotice ? <div className="channel-setup-banner channel-setup-banner-success">{pageNotice}</div> : null}
      {isInitialLoading ? <LoadingState /> : (
        <ChannelSetupContent
          catalog={catalog}
          connections={connections}
          guidedCatalogIds={guidedCatalogIds}
          guidedChannelLabels={guidedChannelLabels}
          selectedCatalog={selectedCatalog}
          selectedCatalogId={selectedCatalogId}
          onSelectCatalog={(catalogId) => {
            setSelectedCatalogId(catalogId);
            setDraft(null);
            setValidation(null);
            setTestResult(null);
          }}
          definition={definition}
          definitionError={definitionError}
          definitionLoading={definitionLoading}
          draft={draft}
          recentDrafts={recentDrafts}
          validation={validation}
          testResult={testResult}
          currentStep={currentStep}
          currentStepId={currentStepId}
          visibleSteps={visibleSteps}
          busyAction={busyAction}
          manualJsonOpen={manualJsonOpen}
          manualJsonText={manualJsonText}
          manualJsonError={manualJsonError}
          setCurrentStepId={setCurrentStepId}
          setManualJsonOpen={setManualJsonOpen}
          setManualJsonText={setManualJsonText}
          onStartDraft={startDraft}
          onSaveDraft={handleSaveDraft}
          onResumeDraft={resumeDraft}
          onValidate={handleValidate}
          onTest={handleTest}
          onFinalize={handleFinalize}
          onRetest={handleRetest}
          onFieldChange={handleFieldChange}
          onApplyManualJson={applyManualJson}
          onJumpToFieldCollection={jumpToFieldCollection}
        />
      )}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="stack-lg">
      <CardSkeleton lines={3} />
      <CardSkeleton lines={6} />
    </div>
  );
}

function ChannelSetupContent(props: {
  catalog: IntegrationCatalogEntry[];
  connections: IntegrationConnection[];
  guidedCatalogIds: Set<string>;
  guidedChannelLabels: string;
  selectedCatalog: IntegrationCatalogEntry | null;
  selectedCatalogId: string;
  onSelectCatalog: (catalogId: string) => void;
  definition: ChannelSetupDefinition | null;
  definitionError: string | null;
  definitionLoading: boolean;
  draft: ChannelSetupDraft | null;
  recentDrafts: ChannelSetupDraft[];
  validation: ChannelSetupValidationResult | null;
  testResult: ChannelSetupTestResult | null;
  currentStep: ChannelSetupStepDefinition | null;
  currentStepId: string;
  visibleSteps: ChannelSetupStepDefinition[];
  busyAction: BusyAction;
  manualJsonOpen: boolean;
  manualJsonText: string;
  manualJsonError: string | null;
  setCurrentStepId: (stepId: string) => void;
  setManualJsonOpen: (value: boolean | ((current: boolean) => boolean)) => void;
  setManualJsonText: (value: string) => void;
  onStartDraft: (mode: "create" | "edit" | "repair" | "rotate_secret", connection?: IntegrationConnection) => Promise<void>;
  onSaveDraft: () => Promise<void>;
  onResumeDraft: (draft: ChannelSetupDraft) => void;
  onValidate: () => Promise<void>;
  onTest: () => Promise<void>;
  onFinalize: () => Promise<void>;
  onRetest: (connection: IntegrationConnection) => Promise<void>;
  onFieldChange: (fieldKey: string, value: unknown) => void;
  onApplyManualJson: () => void;
  onJumpToFieldCollection: () => void;
}) {
  return (
    <div className="split-grid channel-setup-shell">
      <div className="stack-md">
        <Panel title="Available guided channels" subtitle={`Guided flows are available for ${props.guidedChannelLabels || "the current rollout set"}. Other channels stay on the legacy/manual path for now.`}>
          <div className="channel-setup-catalog">
            {props.catalog.map((item) => {
              const selected = item.catalogId === props.selectedCatalogId;
              const supported = props.guidedCatalogIds.has(item.catalogId);
              return (
                <button
                  key={item.catalogId}
                  type="button"
                  className={`channel-setup-catalog-item${selected ? " selected" : ""}`}
                  onClick={() => props.onSelectCatalog(item.catalogId)}
                >
                  <div className="channel-setup-catalog-top">
                    <strong>{item.label}</strong>
                    <StatusChip tone={supported ? "success" : "muted"}>{supported ? "Guided" : "Manual for now"}</StatusChip>
                  </div>
                  <FieldHelp>{item.description}</FieldHelp>
                </button>
              );
            })}
          </div>
          <div className="channel-setup-start-bar">
            <ActionButton
              label={props.definition ? `Set up ${props.selectedCatalog?.label ?? "channel"}` : "Guided setup coming later"}
              disabled={!props.definition || props.busyAction !== null}
              pending={props.busyAction === "start"}
              onClick={() => void props.onStartDraft("create")}
              variant="primary"
            />
          </div>
        </Panel>

        {props.recentDrafts.length > 0 ? (
          <Panel title="Recent drafts" subtitle="Resume an in-progress setup instead of starting over.">
            <div className="channel-setup-connection-list">
              {props.recentDrafts.map((item) => (
                <article key={item.draftId} className="channel-setup-connection-card">
                  <div className="channel-setup-connection-head">
                    <div className="stack-sm">
                      <strong>{item.label ?? props.selectedCatalog?.label ?? item.catalogId}</strong>
                      <FieldHelp>{titleCaseLifecycle(item.lifecycleMode)} · Updated {new Date(item.updatedAt).toLocaleString()}</FieldHelp>
                    </div>
                    <StatusChip tone={item.lastFailureCategory ? "warning" : "success"}>
                      {item.lastFailureCategory ? "Needs attention" : "Draft ready"}
                    </StatusChip>
                  </div>
                  <div className="channel-setup-connection-actions">
                    <ActionButton
                      label="Resume Draft"
                      disabled={props.busyAction !== null}
                      onClick={() => props.onResumeDraft(item)}
                    />
                  </div>
                </article>
              ))}
            </div>
          </Panel>
        ) : null}

        <Panel title="Existing channel connections" subtitle="Use edit, repair, rotate-secret, and re-test without abandoning the guided flow.">
          {props.connections.length === 0 ? (
            <GCEmptyState
              title="No channel connections yet"
              subtitle="Start with Discord or Telegram to exercise the new guided setup flow."
            />
          ) : (
            <div className="channel-setup-connection-list">
              {props.connections.map((connection) => (
                <article key={connection.connectionId} className="channel-setup-connection-card">
                  <div className="channel-setup-connection-head">
                    <div className="stack-sm">
                      <strong>{connection.label}</strong>
                      <FieldHelp>{connection.catalogId}</FieldHelp>
                    </div>
                    <StatusChip tone={connection.status === "connected" ? "success" : connection.status === "error" ? "critical" : "warning"}>
                      {connection.status}
                    </StatusChip>
                  </div>
                  <div className="channel-setup-connection-actions">
                    <ActionButton label="Edit" disabled={props.busyAction !== null} onClick={() => void props.onStartDraft("edit", connection)} />
                    <ActionButton label="Repair" disabled={props.busyAction !== null} pending={props.busyAction === "repair"} onClick={() => void props.onStartDraft("repair", connection)} />
                    <ActionButton label="Rotate Secret" disabled={props.busyAction !== null} pending={props.busyAction === "rotate"} onClick={() => void props.onStartDraft("rotate_secret", connection)} />
                    <ActionButton label="Re-test" disabled={props.busyAction !== null} pending={props.busyAction === "retest"} onClick={() => void props.onRetest(connection)} />
                  </div>
                </article>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <div className="stack-md">
        {!props.selectedCatalog ? (
          <Panel title="Select a channel">
            <GCEmptyState title="Pick a channel to begin" subtitle="The wizard shell will appear here." />
          </Panel>
        ) : props.definitionLoading ? (
          <CardSkeleton lines={8} />
        ) : !props.definition ? (
          <Panel title={props.selectedCatalog.label} subtitle="Guided setup is not available for this channel yet.">
            <GCEmptyState
              title="Manual path only for now"
              subtitle={props.definitionError ?? "This channel will move into the new wizard framework in a later phase."}
              action={<span className="token-chip">Guided coverage: {props.guidedChannelLabels || "Current rollout set only"}</span>}
            />
          </Panel>
        ) : (
          <Panel
            title={`${props.definition.catalog.label} setup wizard`}
            subtitle={props.definition.wizard.introSummary}
            actions={props.draft ? (
              <div className="channel-setup-header-actions">
                <ActionButton label="I already have the values" disabled={props.busyAction !== null} onClick={() => props.onJumpToFieldCollection()} />
                <ActionButton
                  label={props.manualJsonOpen ? "Hide Manual JSON" : "Manual JSON"}
                  disabled={!props.draft || props.busyAction !== null}
                  onClick={() => props.setManualJsonOpen((current) => !current)}
                />
              </div>
            ) : undefined}
          >
            <div className="channel-setup-definition-meta">
              <StatusChip tone="success">{props.definition.telemetry.tier.replace("_", " ").toUpperCase()}</StatusChip>
              <StatusChip>{props.definition.wizard.archetype.replace(/_/g, " ")}</StatusChip>
              <StatusChip>{props.definition.wizard.estimatedMinutes} min</StatusChip>
              <StatusChip>{props.definition.wizard.difficulty}</StatusChip>
            </div>
            <WizardShell {...props} />
          </Panel>
        )}
      </div>
    </div>
  );
}

function WizardShell(props: Parameters<typeof ChannelSetupContent>[0]) {
  return (
    <div className="channel-setup-shell-grid">
      <aside className="channel-setup-stepper">
        {props.draft ? (
          <>
            <div className="channel-setup-lifecycle">
              <span className="channel-setup-lifecycle-label">{titleCaseLifecycle(props.draft.lifecycleMode)}</span>
              <FieldHelp>{lifecycleDescription(props.draft.lifecycleMode)}</FieldHelp>
            </div>
            <ol className="channel-setup-step-list">
              {props.visibleSteps.map((step, index) => (
                <li key={step.id}>
                  <button
                    type="button"
                    className={`channel-setup-step-button${step.id === props.currentStepId ? " active" : ""}${getStepCompletionState(step, props.draft, props.validation, props.testResult) === "complete" ? " complete" : ""}`}
                    onClick={() => props.setCurrentStepId(step.id)}
                  >
                    <span>{getStepCompletionState(step, props.draft, props.validation, props.testResult) === "complete" ? "✓" : index + 1}</span>
                    <div>
                      <strong>{step.title}</strong>
                      <FieldHelp>{describeStepStatus(step, props.draft, props.validation, props.testResult)}</FieldHelp>
                    </div>
                  </button>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <>
            <div className="channel-setup-lifecycle">
              <span className="channel-setup-lifecycle-label">Create</span>
              <FieldHelp>Guided first-time setup</FieldHelp>
            </div>
            <ol className="channel-setup-step-list">
              {props.visibleSteps.map((step, index) => (
                <li key={step.id}>
                  <button
                    type="button"
                    className={`channel-setup-step-button${index === 0 ? " active" : ""}`}
                    disabled
                  >
                    <span>{index + 1}</span>
                    <div>
                      <strong>{step.title}</strong>
                      <FieldHelp>{describeStepStatus(step, null, null, null)}</FieldHelp>
                    </div>
                  </button>
                </li>
              ))}
            </ol>
          </>
        )}
      </aside>

      <div className="channel-setup-main">
        {!props.draft ? (
          <WizardPreviewPanel {...props} />
        ) : !props.currentStep ? (
          <GCEmptyState title="Wizard ready" subtitle="Start with the guided setup button or choose an existing connection action." />
        ) : (
          <WizardStepPanel {...props} />
        )}
      </div>

      <aside className="channel-setup-help">
        {props.definition?.volatility.officialDocsUrl ? (
          <Panel title="Official reference" padding="compact">
            <a href={props.definition.volatility.officialDocsUrl} target="_blank" rel="noreferrer">
              {props.definition.volatility.officialDocsUrl}
            </a>
            <FieldHelp>
              Last reviewed {props.definition.volatility.lastReviewedAt}. Volatility {props.definition.volatility.volatility}; deprecation risk {props.definition.volatility.deprecationRisk}.
            </FieldHelp>
          </Panel>
        ) : null}
        {props.currentStep?.troubleshooting && props.currentStep.troubleshooting.length > 0 ? (
          <Panel title="Troubleshooting" padding="compact">
            <div className="stack-sm">
              {props.currentStep.troubleshooting.map((item) => (
                <div key={item.id} className="channel-setup-troubleshooting-item">
                  <strong>{item.title}</strong>
                  <FieldHelp>{item.body}</FieldHelp>
                  {item.nextSteps && item.nextSteps.length > 0 ? (
                    <ul className="channel-setup-inline-list">
                      {item.nextSteps.map((step) => <li key={step}>{step}</li>)}
                    </ul>
                  ) : null}
                </div>
              ))}
            </div>
          </Panel>
        ) : null}
        {props.draft?.hydration?.warnings && props.draft.hydration.warnings.length > 0 ? (
          <Panel title="Edit and repair notes" padding="compact" tone="warning">
            <ul className="channel-setup-inline-list">
              {props.draft.hydration.warnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          </Panel>
        ) : null}
        <Panel title="Shared guidance primitives" padding="compact">
          <ul className="channel-setup-inline-list">
            <li>What this value is</li>
            <li>Why we need it</li>
            <li>Where to find it</li>
            <li>What it should look like</li>
            <li>Common mistakes</li>
            <li>Sensitive handling</li>
          </ul>
        </Panel>
      </aside>
    </div>
  );
}

function WizardPreviewPanel(props: Parameters<typeof ChannelSetupContent>[0]) {
  if (!props.definition) {
    return null;
  }

  return (
    <div className="stack-md">
      <header className="channel-setup-step-header">
        <div>
          <p className="section-title-eyebrow">Guided Setup</p>
          <h3>{props.definition.wizard.steps[0]?.title ?? "Overview"}</h3>
          <FieldHelp>{props.definition.wizard.introSummary}</FieldHelp>
        </div>
      </header>

      {renderRichBlocks(props.definition.wizard.steps[0]?.body)}

      {props.definition.wizard.prerequisites.length > 0 ? (
        <Panel title="Prerequisites" padding="compact">
          <ul className="channel-setup-inline-list">
            {props.definition.wizard.prerequisites.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </Panel>
      ) : null}

      <div className="channel-setup-footer">
        <div />
        <div className="channel-setup-footer-actions">
          <ActionButton
            label={`Start guided setup for ${props.definition.catalog.label}`}
            disabled={props.busyAction !== null}
            pending={props.busyAction === "start"}
            onClick={() => void props.onStartDraft("create")}
            variant="primary"
          />
          <ActionButton
            label="I already have the values"
            disabled={props.busyAction !== null}
            onClick={() => props.onJumpToFieldCollection()}
          />
        </div>
      </div>
    </div>
  );
}

function WizardStepPanel(props: Parameters<typeof ChannelSetupContent>[0]) {
  if (!props.draft || !props.currentStep) {
    return null;
  }

  const currentIndex = props.visibleSteps.findIndex((step) => step.id === props.currentStepId);
  const previous = props.visibleSteps[currentIndex - 1];
  const next = props.visibleSteps[currentIndex + 1];

  return (
    <div className="stack-md">
      <header className="channel-setup-step-header">
        <div>
          <p className="section-title-eyebrow">Current Step</p>
          <h3>{props.currentStep.title}</h3>
          {props.currentStep.description ? <FieldHelp>{props.currentStep.description}</FieldHelp> : null}
        </div>
      </header>

      {renderRichBlocks(props.currentStep.body)}

      {props.currentStep.checklist && props.currentStep.checklist.length > 0 ? (
        <div className="channel-setup-checklist">
          {props.currentStep.checklist.map((item) => (
            <div key={item.id} className="channel-setup-check-item">
              <strong>{item.label}</strong>
              {item.detail ? <FieldHelp>{item.detail}</FieldHelp> : null}
            </div>
          ))}
        </div>
      ) : null}

      {props.currentStep.fields && props.currentStep.fields.length > 0 ? (
        <div className="channel-setup-fields">
          {props.currentStep.fields.map((field) => (
            <FieldCard
              key={field.key}
              field={field}
              value={props.draft?.draft[field.key]}
              hydrationState={props.draft?.hydration?.fieldState[field.key]}
              onChange={(value) => props.onFieldChange(field.key, value)}
            />
          ))}
        </div>
      ) : null}

      {props.manualJsonOpen ? (
        <div className="channel-setup-manual-json">
          <label htmlFor="channel-manual-json"><strong>Manual JSON</strong></label>
          <textarea
            id="channel-manual-json"
            className="full-textarea"
            rows={10}
            value={props.manualJsonText}
            onChange={(event) => props.setManualJsonText(event.target.value)}
          />
          {props.manualJsonError ? <FieldHelp className="channel-setup-error-text">{props.manualJsonError}</FieldHelp> : null}
          <ActionButton label="Apply JSON" onClick={() => props.onApplyManualJson()} />
        </div>
      ) : null}

      {props.validation ? <ResultPanel title="Validation" result={props.validation} /> : null}
      {props.testResult ? <ResultPanel title="Test Result" result={props.testResult} /> : null}

      <footer className="channel-setup-footer">
        <ActionButton label="Back" disabled={props.busyAction !== null || !previous} onClick={() => previous ? props.setCurrentStepId(previous.id) : undefined} />
        <div className="channel-setup-footer-actions">
          <ActionButton label="Save Draft" pending={props.busyAction === "save"} disabled={props.busyAction !== null} onClick={() => void props.onSaveDraft()} />
          <ActionButton label="Validate" pending={props.busyAction === "validate"} disabled={props.busyAction !== null} onClick={() => void props.onValidate()} />
          <ActionButton label="Test" pending={props.busyAction === "test"} disabled={props.busyAction !== null} onClick={() => void props.onTest()} />
          <ActionButton label="Finalize" pending={props.busyAction === "finalize"} disabled={props.busyAction !== null} onClick={() => void props.onFinalize()} variant="primary" />
          <ActionButton label="Next" disabled={props.busyAction !== null || !next} onClick={() => next ? props.setCurrentStepId(next.id) : undefined} />
        </div>
      </footer>
    </div>
  );
}

function FieldCard({
  field,
  value,
  hydrationState,
  onChange,
}: {
  field: ChannelSetupFieldDefinition;
  value: unknown;
  hydrationState?: "configured" | "missing" | "needs_replacement" | "unknown";
  onChange: (value: unknown) => void;
}) {
  const stringValue = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  return (
    <div className="channel-setup-field-card">
      <div className="channel-setup-field-head">
        <label htmlFor={`channel-setup-${field.key}`}>
          <strong>{field.label}</strong>
          {field.required ? " *" : ""}
        </label>
        {field.sensitive ? <StatusChip tone="warning">Sensitive</StatusChip> : null}
      </div>
      <FieldHelp>{field.explanation}</FieldHelp>
      {field.whyNeeded ? <FieldHelp><strong>Why we need it:</strong> {field.whyNeeded}</FieldHelp> : null}
      <FieldInput field={field} value={stringValue} onChange={onChange} />
      {hydrationState === "configured" && !stringValue ? (
        <FieldHelp className="channel-setup-configured-note">Configured already. Enter a new value only if you need to replace it.</FieldHelp>
      ) : null}
      {field.whereToFind && field.whereToFind.length > 0 ? (
        <div className="channel-setup-field-meta">
          <strong>Where to find it</strong>
          {renderRichBlocks(field.whereToFind)}
        </div>
      ) : null}
      {field.looksLike ? (
        <div className="channel-setup-field-meta">
          <strong>What it should look like</strong>
          <code>{field.looksLike}</code>
        </div>
      ) : null}
      {field.commonMistakes && field.commonMistakes.length > 0 ? (
        <div className="channel-setup-field-meta">
          <strong>Common mistakes</strong>
          <ul className="channel-setup-inline-list">
            {field.commonMistakes.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      ) : null}
      {field.canChangeLater ? <FieldHelp>You can update this later without recreating the entire connection.</FieldHelp> : null}
    </div>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: ChannelSetupFieldDefinition;
  value: string;
  onChange: (value: unknown) => void;
}) {
  if (field.type === "select") {
    return (
      <select
        id={`channel-setup-${field.key}`}
        value={value || String(field.defaultValue ?? "")}
        onChange={(event) => onChange(event.target.value)}
      >
        {!field.required ? <option value="">Select…</option> : null}
        {(field.options ?? []).map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    );
  }

  if (field.type === "boolean") {
    return (
      <label>
        <input
          id={`channel-setup-${field.key}`}
          type="checkbox"
          checked={value === "true"}
          onChange={(event) => onChange(event.target.checked)}
        />{" "}
        Enabled
      </label>
    );
  }

  if (field.type === "textarea") {
    return (
      <textarea
        id={`channel-setup-${field.key}`}
        className="full-textarea"
        rows={4}
        value={value}
        placeholder={field.placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  return (
    <input
      id={`channel-setup-${field.key}`}
      type={field.type === "secret" ? "password" : "text"}
      value={value}
      placeholder={field.placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function ResultPanel({
  title,
  result,
}: {
  title: string;
  result: ChannelSetupValidationResult | ChannelSetupTestResult;
}) {
  return (
    <Panel title={title} padding="compact" tone={result.status === "error" ? "critical" : result.status === "warn" ? "warning" : "accent"}>
      <div className="channel-setup-result-head">
        <StatusChip tone={result.status === "error" ? "critical" : result.status === "warn" ? "warning" : "success"}>{result.status}</StatusChip>
        <FieldHelp>Checked {new Date(result.checkedAt).toLocaleString()}</FieldHelp>
      </div>
      {result.issues.length === 0 ? (
        <FieldHelp>No issues found.</FieldHelp>
      ) : (
        <div className="stack-sm">
          {result.issues.map((issue) => (
            <div key={`${issue.key}-${issue.message}`} className="channel-setup-result-item">
              <strong>{issue.message}</strong>
              {issue.detail ? <FieldHelp>{issue.detail}</FieldHelp> : null}
              {issue.nextSteps && issue.nextSteps.length > 0 ? (
                <ul className="channel-setup-inline-list">
                  {issue.nextSteps.map((step) => <li key={step}>{step}</li>)}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {"recommendedNextAction" in result && result.recommendedNextAction ? (
        <FieldHelp><strong>Next:</strong> {result.recommendedNextAction}</FieldHelp>
      ) : null}
      {"probe" in result && result.probe?.steps?.length ? (
        <div className="stack-sm">
          <FieldHelp><strong>Probe truth</strong></FieldHelp>
          <ul className="channel-setup-inline-list">
            {result.probe.steps.map((step) => (
              <li key={`${step.key}-${step.message}`}>
                <strong>{step.label}</strong> [{step.status}] {step.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Panel>
  );
}

function renderRichBlocks(blocks?: ChannelSetupRichBlock[]) {
  if (!blocks || blocks.length === 0) {
    return null;
  }
  return (
    <div className="stack-sm">
      {blocks.map((block, index) => {
        const key = `${block.kind}-${index}`;
        if (block.kind === "paragraph") {
          return <p key={key}>{block.text}</p>;
        }
        if (block.kind === "list") {
          return block.ordered ? (
            <ol key={key} className="channel-setup-inline-list">
              {block.items.map((item) => <li key={item}>{item}</li>)}
            </ol>
          ) : (
            <ul key={key} className="channel-setup-inline-list">
              {block.items.map((item) => <li key={item}>{item}</li>)}
            </ul>
          );
        }
        if (block.kind === "note") {
          return <div key={key} className={`channel-setup-note tone-${block.tone}`}>{block.title ? <strong>{block.title} </strong> : null}{block.text}</div>;
        }
        if (block.kind === "link") {
          return <a key={key} href={block.href} target={block.external ? "_blank" : undefined} rel={block.external ? "noreferrer" : undefined}>{block.label}</a>;
        }
        return <pre key={key}><code>{block.code}</code></pre>;
      })}
    </div>
  );
}

function isStepVisible(step: ChannelSetupStepDefinition, draft: Record<string, unknown> | undefined): boolean {
  if (!step.visibleWhenFieldEquals) {
    return true;
  }
  return draft?.[step.visibleWhenFieldEquals.fieldKey] === step.visibleWhenFieldEquals.value;
}

function findResumeStepId(definition: ChannelSetupDefinition, draft: ChannelSetupDraft) {
  const visibleSteps = definition.wizard.steps.filter((step) => isStepVisible(step, draft.draft));
  const nextIncomplete = visibleSteps.find((step) => getStepCompletionState(step, draft, null, null) !== "complete");
  return nextIncomplete?.id ?? visibleSteps.at(-1)?.id ?? "";
}

function getStepCompletionState(
  step: ChannelSetupStepDefinition,
  draft: ChannelSetupDraft | null,
  validation: ChannelSetupValidationResult | null,
  testResult: ChannelSetupTestResult | null,
): "pending" | "complete" {
  if (!draft) {
    return "pending";
  }
  if (step.fields && step.fields.length > 0) {
    return step.fields.every((field) => isFieldSatisfied(field, draft.draft, draft.hydration?.fieldState[field.key]))
      ? "complete"
      : "pending";
  }
  if (step.kind === "test") {
    return testResult?.status === "ok" ? "complete" : "pending";
  }
  if (step.kind === "confirm") {
    return testResult?.status === "ok" && validation?.status === "ok" ? "complete" : "pending";
  }
  return "pending";
}

function describeStepStatus(
  step: ChannelSetupStepDefinition,
  draft: ChannelSetupDraft | null,
  validation: ChannelSetupValidationResult | null,
  testResult: ChannelSetupTestResult | null,
) {
  const state = getStepCompletionState(step, draft, validation, testResult);
  if (state === "complete") {
    return "Complete";
  }
  switch (step.kind) {
    case "field-collection":
      return "Values and context";
    case "test":
      return testResult ? "Re-run after changes" : "Run validation and live checks";
    case "confirm":
      return "Finalize when validation and tests pass";
    default:
      return "Review and continue";
  }
}

function isFieldSatisfied(
  field: ChannelSetupFieldDefinition,
  draftValues: Record<string, unknown>,
  hydrationState?: "configured" | "missing" | "needs_replacement" | "unknown",
) {
  const value = draftValues[field.key];
  if (field.type === "boolean") {
    return typeof value === "boolean" || hydrationState === "configured";
  }
  if (!field.required) {
    return true;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return hydrationState === "configured";
}

function findStartStepId(definition: ChannelSetupDefinition, lifecycleMode: ChannelSetupDraft["lifecycleMode"]) {
  if (lifecycleMode === "repair" || lifecycleMode === "rotate_secret" || lifecycleMode === "retest") {
    return definition.wizard.steps.find((step) => step.kind === "field-collection" || step.kind === "test")?.id
      ?? definition.wizard.steps[0]?.id
      ?? "";
  }
  return definition.wizard.steps[0]?.id ?? "";
}

function titleCaseLifecycle(mode: ChannelSetupDraft["lifecycleMode"]) {
  switch (mode) {
    case "rotate_secret":
      return "Rotate Secret";
    case "retest":
      return "Re-test";
    default:
      return mode.charAt(0).toUpperCase() + mode.slice(1);
  }
}

function lifecycleDescription(mode: ChannelSetupDraft["lifecycleMode"]) {
  switch (mode) {
    case "create":
      return "Guided first-time setup";
    case "edit":
      return "Selective edit of an existing connection";
    case "repair":
      return "Diagnostics-forward recovery path";
    case "rotate_secret":
      return "Focused credential replacement";
    case "retest":
      return "Verification-only run";
  }
}
