/* eslint-disable max-lines, react-hooks/exhaustive-deps */
import { useEffect, useMemo, useState } from "react";
import type {
  ChannelSetupDefinition,
  ChannelSetupDraft,
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
  discoverTelegramTargets,
  fetchChannelSetupDefinition,
  fetchChannelSetupDefinitions,
  fetchChannelSetupDrafts,
  fetchSlackOAuthStatus,
  fetchIntegrationCatalog,
  fetchIntegrationConnections,
  finalizeChannelSetupDraft,
  retestChannelConnection,
  startSlackOAuth,
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
import {
  describeStepStatus,
  findResumeStepId,
  findStartStepId,
  getStepCompletionState,
  isStepVisible,
  lifecycleDescription,
  titleCaseLifecycle,
} from "./channel-setup/channel-setup-page-helpers";
import { FieldCard, renderRichBlocks, ResultPanel } from "./channel-setup/channel-setup-wizard-components";

type BusyAction = "start" | "save" | "validate" | "test" | "finalize" | "repair" | "rotate" | "retest" | null;

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

  const guidedChannelLabels = useMemo(
    () =>
      guidedDefinitions
        .map((item) => item.catalog.label)
        .sort((left, right) => left.localeCompare(right))
        .join(", "),
    [guidedDefinitions],
  );

  const guidedCatalog = useMemo(
    () => catalog.filter((item) => guidedCatalogIds.has(item.catalogId)),
    [catalog, guidedCatalogIds],
  );

  const guidedConnections = useMemo(
    () => connections.filter((item) => guidedCatalogIds.has(item.catalogId)),
    [connections, guidedCatalogIds],
  );

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

  useEffect(() => {
    if (guidedCatalog.length === 0) {
      if (selectedCatalogId) {
        setSelectedCatalogId("");
        setDraft(null);
        setValidation(null);
        setTestResult(null);
      }
      return;
    }
    if (guidedCatalogIds.has(selectedCatalogId)) {
      return;
    }
    const preferred =
      guidedCatalog.find((item) => item.catalogId === "channel.slack") ??
      guidedCatalog.find((item) => item.catalogId === "channel.telegram") ??
      guidedCatalog[0] ??
      null;
    if (!preferred) {
      return;
    }
    setSelectedCatalogId(preferred.catalogId);
    setDraft(null);
    setValidation(null);
    setTestResult(null);
  }, [guidedCatalog, guidedCatalogIds, selectedCatalogId]);

  const visibleSteps = useMemo(() => {
    if (!definition) {
      return [];
    }
    return definition.wizard.steps.filter((step) => isStepVisible(step, draft?.draft));
  }, [definition, draft?.draft]);

  const selectedCatalog = guidedCatalog.find((item) => item.catalogId === selectedCatalogId) ?? null;
  const currentStep = visibleSteps.find((step) => step.id === currentStepId) ?? null;

  useEffect(() => {
    if (visibleSteps.length === 0) {
      setCurrentStepId("");
      return;
    }
    if (!visibleSteps.some((step) => step.id === currentStepId)) {
      setCurrentStepId(definition && draft ? findResumeStepId(definition, draft) : (visibleSteps[0]?.id ?? ""));
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
        const preferred =
          catalogResponse.items.find((item) => item.catalogId === "channel.slack" && guidedIds.has(item.catalogId)) ??
          catalogResponse.items.find(
            (item) => item.catalogId === "channel.telegram" && guidedIds.has(item.catalogId),
          ) ??
          catalogResponse.items.find((item) => guidedIds.has(item.catalogId)) ??
          catalogResponse.items[0];
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
    setBusyAction(
      mode === "create" ? "start" : mode === "repair" ? "repair" : mode === "rotate_secret" ? "rotate" : "start",
    );
    setPageNotice(null);
    setPageError(null);
    try {
      const activeDefinition =
        definition?.catalog.catalogId === catalogId ? definition : await loadDefinition(catalogId);
      if (!activeDefinition) {
        throw new Error("Guided setup is not available for this channel yet.");
      }
      const created =
        mode === "repair" && connection
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
      setPageNotice(
        connection
          ? `${titleCaseLifecycle(created.lifecycleMode)} draft ready for ${connection.label}.`
          : `Guided setup started for ${activeDefinition.catalog.label}.`,
      );
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
      if (definition) {
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
      if (definition) {
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
      if (definition) {
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
      if (definition) {
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
      setPageNotice(
        result.status === "ok"
          ? `Re-test passed for ${connection.label}.`
          : `Re-test completed for ${connection.label}.`,
      );
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
    setDraft((current) => (current ? mutator(current) : current));
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
    setCurrentStepId(activeDefinition ? findResumeStepId(activeDefinition, nextDraft) : "");
    trackWizardEvent("channel_draft_resumed", {
      draftId: nextDraft.draftId,
      catalogId: nextDraft.catalogId,
      lifecycleMode: nextDraft.lifecycleMode,
      manualModeUsed: false,
    });
  }

  function upsertRecentDraft(nextDraft: ChannelSetupDraft) {
    setRecentDrafts((current) =>
      [nextDraft, ...current.filter((item) => item.draftId !== nextDraft.draftId)]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 12),
    );
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
    const target =
      definition.wizard.steps.find((step) => step.kind === "field-collection")?.id ??
      definition.wizard.steps[0]?.id ??
      "";
    if (!draft) {
      void startDraft("create", undefined, target);
      return;
    }
    setCurrentStepId(target);
  }

  async function handleStartSlackOAuth() {
    setBusyAction("start");
    setPageNotice(null);
    setPageError(null);
    try {
      const before = await fetchSlackOAuthStatus().catch(() => null);
      const previousConnections = new Map(
        before?.connections.map((item) => [
          item.connection.connectionId,
          readConnectionString(item.connection.config, "oauthConnectedAt") ?? "",
        ]) ?? [],
      );
      const result = await startSlackOAuth();
      window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
      setPageNotice("Slack authorization opened. Approve the workspace, then GoatCitadel will open target setup here.");
      void waitForSlackOAuthInstall(previousConnections);
    } catch (error) {
      setPageError((error as Error).message);
    } finally {
      setBusyAction(null);
    }
  }

  async function waitForSlackOAuthInstall(previousConnections: Map<string, string>) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await delay(2000);
      try {
        const status = await fetchSlackOAuthStatus();
        const installed = status.connections.find((item) => {
          const previousConnectedAt = previousConnections.get(item.connection.connectionId);
          const nextConnectedAt = readConnectionString(item.connection.config, "oauthConnectedAt") ?? "";
          return previousConnectedAt === undefined || previousConnectedAt !== nextConnectedAt;
        });
        if (!installed) {
          continue;
        }
        setConnections((current) => {
          const others = current.filter((item) => item.connectionId !== installed.connection.connectionId);
          return [installed.connection, ...others];
        });
        setSelectedCatalogId("channel.slack");
        setPageNotice("Slack workspace connected. Add one or more channel targets, then run a test.");
        await startDraft("edit", installed.connection, "collect-values");
        return;
      } catch {
        // Keep polling; transient gateway restarts or callback timing should not strand the setup flow.
      }
    }
    setPageNotice(
      "Slack authorization opened. If approval finished, refresh connections or start an edit draft for Slack.",
    );
  }

  async function handleDiscoverTelegramTargets() {
    if (!draft) {
      return;
    }
    setBusyAction("test");
    setPageNotice(null);
    setPageError(null);
    try {
      const result = await discoverTelegramTargets({
        botToken: typeof draft.draft.botToken === "string" ? draft.draft.botToken : undefined,
        botTokenEnv:
          typeof draft.draft.botTokenEnv === "string"
            ? draft.draft.botTokenEnv
            : typeof draft.draft.tokenEnv === "string"
              ? draft.draft.tokenEnv
              : undefined,
        setupCode: typeof draft.draft.setupCode === "string" ? draft.draft.setupCode : undefined,
      });
      const targets = result.items.map((item, index) => ({
        id: item.id,
        label: item.label,
        chatId: item.chatId,
        kind: item.kind,
        default: index === 0,
      }));
      updateDraft((current) => ({
        ...current,
        draft: {
          ...current.draft,
          targets,
          defaultChatId: targets[0]?.chatId ?? current.draft.defaultChatId,
        },
      }));
      setPageNotice(
        result.items.length > 0
          ? `Found ${result.items.length} Telegram target${result.items.length === 1 ? "" : "s"}.`
          : "No Telegram chats were found yet. Send /start or your setup code in Telegram, then try again.",
      );
    } catch (error) {
      setPageError((error as Error).message);
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="stack-lg">
      {pageError ? <div className="channel-setup-banner channel-setup-banner-error">{pageError}</div> : null}
      {pageNotice ? <div className="channel-setup-banner channel-setup-banner-success">{pageNotice}</div> : null}
      {isInitialLoading ? (
        <LoadingState />
      ) : (
        <ChannelSetupContent
          catalog={guidedCatalog}
          connections={guidedConnections}
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
          onStartSlackOAuth={handleStartSlackOAuth}
          onDiscoverTelegramTargets={handleDiscoverTelegramTargets}
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
  onStartDraft: (
    mode: "create" | "edit" | "repair" | "rotate_secret",
    connection?: IntegrationConnection,
  ) => Promise<void>;
  onSaveDraft: () => Promise<void>;
  onResumeDraft: (draft: ChannelSetupDraft) => void;
  onValidate: () => Promise<void>;
  onTest: () => Promise<void>;
  onFinalize: () => Promise<void>;
  onRetest: (connection: IntegrationConnection) => Promise<void>;
  onFieldChange: (fieldKey: string, value: unknown) => void;
  onApplyManualJson: () => void;
  onJumpToFieldCollection: () => void;
  onStartSlackOAuth: () => Promise<void>;
  onDiscoverTelegramTargets: () => Promise<void>;
}) {
  return (
    <div className="split-grid channel-setup-shell">
      <div className="stack-md">
        <Panel
          title="Available guided channels"
          subtitle={
            props.catalog.length > 0
              ? `Guided flows are available for ${props.guidedChannelLabels || "the current rollout set"}.`
              : "This page only shows channels with shipped guided setup coverage."
          }
        >
          {props.catalog.length === 0 ? (
            <GCEmptyState
              title="No guided channel setup available"
              subtitle="Use Integrations to manage channel connections until a guided setup appears here."
            />
          ) : (
            <>
              <div className="channel-setup-catalog">
                {props.catalog.map((item) => {
                  const selected = item.catalogId === props.selectedCatalogId;
                  return (
                    <button
                      key={item.catalogId}
                      type="button"
                      className={["gc-button", `channel-setup-catalog-item${selected ? " selected" : ""}`]
                        .filter(Boolean)
                        .join(" ")}
                      onClick={() => props.onSelectCatalog(item.catalogId)}
                    >
                      <div className="channel-setup-catalog-top">
                        <strong>{item.label}</strong>
                        <StatusChip tone="success">Guided</StatusChip>
                      </div>
                      <FieldHelp>{item.description}</FieldHelp>
                    </button>
                  );
                })}
              </div>
              {props.selectedCatalog ? (
                <div className="channel-setup-start-bar">
                  {props.selectedCatalogId === "channel.slack" ? (
                    <ActionButton
                      label="Connect Slack"
                      disabled={props.busyAction !== null}
                      pending={props.busyAction === "start"}
                      onClick={() => void props.onStartSlackOAuth()}
                      variant="primary"
                    />
                  ) : null}
                  <ActionButton
                    label={`Set up ${props.selectedCatalog.label}`}
                    disabled={!props.definition || props.busyAction !== null}
                    pending={props.busyAction === "start"}
                    onClick={() => void props.onStartDraft("create")}
                    variant="primary"
                  />
                </div>
              ) : null}
            </>
          )}
        </Panel>

        {props.recentDrafts.length > 0 ? (
          <Panel title="Recent drafts" subtitle="Resume an in-progress setup instead of starting over.">
            <div className="channel-setup-connection-list">
              {props.recentDrafts.map((item) => (
                <article key={item.draftId} className="channel-setup-connection-card">
                  <div className="channel-setup-connection-head">
                    <div className="stack-sm">
                      <strong>{item.label ?? props.selectedCatalog?.label ?? item.catalogId}</strong>
                      <FieldHelp>
                        {titleCaseLifecycle(item.lifecycleMode)} · Updated {new Date(item.updatedAt).toLocaleString()}
                      </FieldHelp>
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

        <Panel
          title="Existing channel connections"
          subtitle="Use edit, repair, rotate-secret, and re-test without abandoning the guided flow."
        >
          {props.connections.length === 0 ? (
            <GCEmptyState
              title="No guided channel connections yet"
              subtitle="Guided-channel connections appear here after setup."
            />
          ) : (
            <div className="channel-setup-connection-list">
              {props.connections.map((connection) => (
                <article key={connection.connectionId} className="channel-setup-connection-card">
                  <div className="channel-setup-connection-head">
                    <div className="stack-sm">
                      <strong>{connection.label}</strong>
                      <FieldHelp>{formatConnectionTargetSummary(connection)}</FieldHelp>
                    </div>
                    <StatusChip
                      tone={
                        connection.status === "connected"
                          ? "success"
                          : connection.status === "error"
                            ? "critical"
                            : "warning"
                      }
                    >
                      {connection.status}
                    </StatusChip>
                  </div>
                  <div className="channel-setup-connection-actions">
                    <ActionButton
                      label="Edit"
                      disabled={props.busyAction !== null}
                      onClick={() => void props.onStartDraft("edit", connection)}
                    />
                    <ActionButton
                      label="Repair"
                      disabled={props.busyAction !== null}
                      pending={props.busyAction === "repair"}
                      onClick={() => void props.onStartDraft("repair", connection)}
                    />
                    <ActionButton
                      label="Rotate Secret"
                      disabled={props.busyAction !== null}
                      pending={props.busyAction === "rotate"}
                      onClick={() => void props.onStartDraft("rotate_secret", connection)}
                    />
                    <ActionButton
                      label="Re-test"
                      disabled={props.busyAction !== null}
                      pending={props.busyAction === "retest"}
                      onClick={() => void props.onRetest(connection)}
                    />
                  </div>
                </article>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <div className="stack-md">
        {!props.selectedCatalog ? (
          <Panel title="Guided channel setup">
            <GCEmptyState
              title="No guided channel setup available"
              subtitle="Use Integrations to manage channel connections until a guided setup appears here."
            />
          </Panel>
        ) : props.definitionLoading ? (
          <CardSkeleton lines={8} />
        ) : !props.definition ? (
          <Panel title={props.selectedCatalog.label} subtitle="Guided definition unavailable.">
            <GCEmptyState
              title="Couldn't load this guided channel"
              subtitle={props.definitionError ?? "Refresh the page or use Integrations to manage this connection."}
            />
          </Panel>
        ) : (
          <Panel
            title={`${props.definition.catalog.label} setup wizard`}
            subtitle={props.definition.wizard.introSummary}
            actions={
              props.draft ? (
                <div className="channel-setup-header-actions">
                  <ActionButton
                    label="Connect Slack"
                    disabled={props.selectedCatalogId !== "channel.slack" || props.busyAction !== null}
                    pending={props.selectedCatalogId === "channel.slack" && props.busyAction === "start"}
                    onClick={() => void props.onStartSlackOAuth()}
                    variant="primary"
                  />
                  <ActionButton
                    label="Detect Telegram Chats"
                    disabled={
                      props.selectedCatalogId !== "channel.telegram" || !props.draft || props.busyAction !== null
                    }
                    pending={props.selectedCatalogId === "channel.telegram" && props.busyAction === "test"}
                    onClick={() => void props.onDiscoverTelegramTargets()}
                  />
                  <ActionButton
                    label="I already have the values"
                    disabled={props.busyAction !== null}
                    onClick={() => props.onJumpToFieldCollection()}
                  />
                  <ActionButton
                    label={props.manualJsonOpen ? "Hide Manual JSON" : "Manual JSON"}
                    disabled={!props.draft || props.busyAction !== null}
                    onClick={() => props.setManualJsonOpen((current) => !current)}
                  />
                </div>
              ) : undefined
            }
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
                    className={[
                      "gc-button",
                      `channel-setup-step-button${step.id === props.currentStepId ? " active" : ""}${getStepCompletionState(step, props.draft, props.validation, props.testResult) === "complete" ? " complete" : ""}`,
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => props.setCurrentStepId(step.id)}
                  >
                    <span>
                      {getStepCompletionState(step, props.draft, props.validation, props.testResult) === "complete"
                        ? "✓"
                        : index + 1}
                    </span>
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
                    className={["gc-button", `channel-setup-step-button${index === 0 ? " active" : ""}`]
                      .filter(Boolean)
                      .join(" ")}
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
          <GCEmptyState
            title="Wizard ready"
            subtitle="Start with the guided setup button or choose an existing connection action."
          />
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
              Last reviewed {props.definition.volatility.lastReviewedAt}. Volatility{" "}
              {props.definition.volatility.volatility}; deprecation risk {props.definition.volatility.deprecationRisk}.
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
                      {item.nextSteps.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
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
              {props.draft.hydration.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
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
            {props.definition.wizard.prerequisites.map((item) => (
              <li key={item}>{item}</li>
            ))}
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
          <label htmlFor="channel-manual-json">
            <strong>Manual JSON</strong>
          </label>
          <textarea
            id="channel-manual-json"
            className="full-textarea"
            rows={10}
            value={props.manualJsonText}
            onChange={(event) => props.setManualJsonText(event.target.value)}
          />
          {props.manualJsonError ? (
            <FieldHelp className="channel-setup-error-text">{props.manualJsonError}</FieldHelp>
          ) : null}
          <ActionButton label="Apply JSON" onClick={() => props.onApplyManualJson()} />
        </div>
      ) : null}

      {props.validation ? <ResultPanel title="Validation" result={props.validation} /> : null}
      {props.testResult ? <ResultPanel title="Test Result" result={props.testResult} /> : null}

      <footer className="channel-setup-footer">
        <ActionButton
          label="Back"
          disabled={props.busyAction !== null || !previous}
          onClick={() => (previous ? props.setCurrentStepId(previous.id) : undefined)}
        />
        <div className="channel-setup-footer-actions">
          <ActionButton
            label="Save Draft"
            pending={props.busyAction === "save"}
            disabled={props.busyAction !== null}
            onClick={() => void props.onSaveDraft()}
          />
          <ActionButton
            label="Validate"
            pending={props.busyAction === "validate"}
            disabled={props.busyAction !== null}
            onClick={() => void props.onValidate()}
          />
          <ActionButton
            label="Test"
            pending={props.busyAction === "test"}
            disabled={props.busyAction !== null}
            onClick={() => void props.onTest()}
          />
          <ActionButton
            label="Finalize"
            pending={props.busyAction === "finalize"}
            disabled={props.busyAction !== null}
            onClick={() => void props.onFinalize()}
            variant="primary"
          />
          <ActionButton
            label="Next"
            disabled={props.busyAction !== null || !next}
            onClick={() => (next ? props.setCurrentStepId(next.id) : undefined)}
          />
        </div>
      </footer>
    </div>
  );
}

export function formatConnectionTargetSummary(connection: IntegrationConnection): string {
  const config = connection.config ?? {};
  const targets = Array.isArray(config.targets) ? config.targets : [];
  const targetRecords = targets.filter((target): target is Record<string, unknown> => {
    return typeof target === "object" && target !== null && !Array.isArray(target);
  });
  const defaultTarget = targetRecords.find((target) => target.default === true) ?? targetRecords[0];
  const defaultLabel =
    readConnectionString(defaultTarget, "label") ??
    readConnectionString(defaultTarget, "channel") ??
    readConnectionString(defaultTarget, "chatId") ??
    readConnectionString(config, "defaultChannel") ??
    readConnectionString(config, "defaultChatId");
  if (targetRecords.length > 0) {
    return `${connection.catalogId} · ${targetRecords.length} target${targetRecords.length === 1 ? "" : "s"}${defaultLabel ? ` · default ${defaultLabel}` : ""}`;
  }
  return `${connection.catalogId}${defaultLabel ? ` · default ${defaultLabel}` : ""}`;
}

export function readConnectionString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
