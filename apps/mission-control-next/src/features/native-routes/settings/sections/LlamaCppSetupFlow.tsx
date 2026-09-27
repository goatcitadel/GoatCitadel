import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangePlanRecord, LlamaCppSetupChatTestResult, LlamaCppSetupProjection } from "@goatcitadel/contracts";
import {
  confirmChangePlan,
  createChangePlan,
  fetchChangePlan,
  fetchLlamaCppSetup,
  previewLlmModels,
  resolveApproval,
  stageLlamaCppManagedSelection,
  testLlamaCppChat,
} from "@goatcitadel/mission-control-shared/api/client";
import type { AppRoute } from "@next/app/route-model";
import { NativeCard } from "../../NativeRoutePageLayout";
import { NativeButton } from "../../primitives";
import {
  getErrorMessage,
  SettingsButtonRow,
  SettingsField,
  SettingsFieldGrid,
  type SettingsSectionProps,
} from "../SettingsShared";

type Mode = "external" | "managed";
const SETTLED = new Set(["completed", "manual_required", "failed", "cancelled", "rolled_back", "rollback_failed"]);

function newerPlan(current: ChangePlanRecord | null, loaded: ChangePlanRecord): ChangePlanRecord {
  if (!current || current.origin.workspaceId !== loaded.origin.workspaceId) return loaded;
  if (current.planId === loaded.planId) return current.revision > loaded.revision ? current : loaded;
  return Date.parse(current.createdAt) >= Date.parse(loaded.createdAt) ? current : loaded;
}

export function LlamaCppSetupFlow({
  workspaceId,
  route,
  navigate,
}: {
  workspaceId: string;
  route: AppRoute;
  navigate: SettingsSectionProps["navigate"];
}) {
  const [projection, setProjection] = useState<LlamaCppSetupProjection | null>(null);
  const [mode, setMode] = useState<Mode>("external");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [liveModels, setLiveModels] = useState<string[]>([]);
  const [catalogState, setCatalogState] = useState<"unchecked" | "fresh" | "empty" | "stale">("unchecked");
  const [plan, setPlan] = useState<ChangePlanRecord | null>(null);
  const [test, setTest] = useState<LlamaCppSetupChatTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const userEdited = useRef(false);

  const applyProjection = useCallback((next: LlamaCppSetupProjection) => {
    setProjection(next);
    if (userEdited.current) return;
    setMode(next.managementMode);
    setBaseUrl(next.baseUrl);
    if (next.managementMode === "external" && next.catalog.status === "fresh") {
      setLiveModels(next.catalog.modelIds);
      setCatalogState("fresh");
      setModel(
        next.chatRoute.providerId === "llamacpp" && next.catalog.modelIds.includes(next.chatRoute.model)
          ? next.chatRoute.model
          : "",
      );
    } else {
      setLiveModels([]);
      setCatalogState(
        next.catalog.status === "empty" ? "empty" : next.catalog.status === "stale" ? "stale" : "unchecked",
      );
      setModel("");
    }
  }, []);

  const refresh = useCallback(async () => {
    const next = await fetchLlamaCppSetup(workspaceId);
    applyProjection(next);
    const latest = next.pendingPlan ?? next.recentPlan;
    if (latest) {
      const current = await fetchChangePlan(latest.planId, { workspaceId });
      setPlan((previous) => newerPlan(previous, current));
    }
    return next;
  }, [workspaceId, applyProjection]);

  useEffect(() => {
    let cancelled = false;
    void fetchLlamaCppSetup(workspaceId)
      .then(async (next) => {
        if (cancelled) return;
        applyProjection(next);
        const latest = next.pendingPlan ?? next.recentPlan;
        if (latest) {
          const current = await fetchChangePlan(latest.planId, { workspaceId });
          if (!cancelled) setPlan((previous) => newerPlan(previous, current));
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(getErrorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, applyProjection]);

  useEffect(() => {
    if (!plan || SETTLED.has(plan.status)) return;
    const timer = globalThis.setInterval(() => {
      void fetchChangePlan(plan.planId, { workspaceId })
        .then((current) => {
          setPlan(current);
          if (SETTLED.has(current.status)) void refresh();
        })
        .catch((cause) => setError(getErrorMessage(cause)));
    }, 1_500);
    return () => globalThis.clearInterval(timer);
  }, [plan, workspaceId, refresh]);

  const checkServer = async () => {
    setBusy(true);
    setError(null);
    setCatalogState("unchecked");
    setLiveModels([]);
    setModel("");
    try {
      const result = await previewLlmModels({ providerId: "llamacpp", baseUrl: baseUrl.trim() });
      if (result.source === "live" && result.catalogStatus !== "stale" && result.items.length === 0) {
        setCatalogState("empty");
        setError("The server answered but reported no models. Load a model in llama-server, then check again.");
        return;
      }
      if (result.source !== "live" || result.catalogStatus === "stale") {
        setCatalogState("stale");
        setError(
          result.warning ??
            "The server did not provide a fresh model list. Check that llama-server is running at this URL.",
        );
        return;
      }
      const ids = result.items.map((item) => item.id);
      setLiveModels(ids);
      setModel(ids[0] ?? "");
      setCatalogState("fresh");
    } catch (cause) {
      setCatalogState("stale");
      setError(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    if (!model || busy) return;
    setBusy(true);
    setError(null);
    setTest(null);
    try {
      const selection =
        mode === "managed" ? await stageLlamaCppManagedSelection({ workspaceId, modelId: model }) : undefined;
      const created = await createChangePlan({
        workspaceId,
        surface: "settings",
        request: {
          kind: "runtime_configuration",
          change: {
            operation: "llama_cpp_setup",
            managementMode: mode,
            baseUrl: baseUrl.trim(),
            model: selection?.alias ?? model,
            ...(selection ? { selectionId: selection.selectionId, autoStart: true } : {}),
          },
        },
      });
      const action = created.requiredAction;
      if (action?.kind !== "confirmation") throw new Error("Setup review changed. Reload and try again.");
      const waiting = await confirmChangePlan(
        created.planId,
        { workspaceId },
        {
          expectedRevision: created.revision,
          actionNonce: action.actionNonce,
        },
      );
      setPlan(waiting);
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (decision: "approve" | "reject") => {
    if (plan?.requiredAction?.kind !== "approval" || !plan.requiredAction.approvalId) return;
    setBusy(true);
    setError(null);
    try {
      await resolveApproval(plan.requiredAction.approvalId, decision);
      setPlan(await fetchChangePlan(plan.planId, { workspaceId }));
      await refresh();
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setBusy(true);
    setError(null);
    try {
      setTest(await testLlamaCppChat(workspaceId));
      await refresh();
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const managedModels = projection?.models.filter((item) => item.source === "filesystem") ?? [];
  const choices = mode === "external" ? liveModels : managedModels.map((item) => item.modelId);
  const selectedChat = projection?.chatRoute.providerId === "llamacpp";
  const testStale = test && projection && test.settingsRevision !== projection.settingsRevision;
  const status = plan
    ? plan.status === "awaiting_approval"
      ? "Awaiting approval"
      : ["applying", "verifying", "staging"].includes(plan.status)
        ? "Applying"
        : plan.status === "completed"
          ? "Completed"
          : SETTLED.has(plan.status)
            ? "Needs attention"
            : "Reviewing"
    : selectedChat
      ? "Configured · Chat not tested"
      : "Choose a server";

  return (
    <NativeCard
      id="llamacpp-setup"
      density="compact"
      className="mc-next-settings-panel"
      title="Set up llama.cpp"
      subtitle="Choose who runs the server, select its model, and test a real Chat response."
      stats={[
        { label: "Setup", value: status },
        { label: "Ownership", value: projection?.ownership ?? "Unknown" },
        { label: "Chat model", value: selectedChat ? (projection?.chatRoute.model ?? "Unknown") : "Not selected" },
      ]}
    >
      <fieldset className="mc-next-settings-fieldset">
        <legend>How will the server run?</legend>
        <label>
          <input
            type="radio"
            name="llamacpp-management"
            checked={mode === "external"}
            onChange={() => {
              userEdited.current = true;
              setMode("external");
              setModel("");
            }}
          />{" "}
          Use a running server
        </label>
        <label>
          <input
            type="radio"
            name="llamacpp-management"
            checked={mode === "managed"}
            onChange={() => {
              userEdited.current = true;
              setMode("managed");
              setModel("");
            }}
          />{" "}
          Let GoatCitadel start one
        </label>
      </fieldset>
      <p className="mc-next-settings-field-note">
        {mode === "external"
          ? "GoatCitadel connects to your server and never starts or stops it."
          : "GoatCitadel starts the installed llama-server now and with the Gateway. Files must already be installed."}
      </p>
      <SettingsFieldGrid>
        <SettingsField label="Server URL">
          <input
            className="mc-next-settings-input"
            type="url"
            value={baseUrl}
            onChange={(event) => {
              userEdited.current = true;
              setBaseUrl(event.target.value);
              setCatalogState("unchecked");
              setLiveModels([]);
              setModel("");
            }}
          />
        </SettingsField>
        <SettingsField label="Model for Chat">
          <select
            className="mc-next-settings-input"
            value={model}
            disabled={busy || !choices.length}
            onChange={(event) => setModel(event.target.value)}
          >
            <option value="">Choose a verified model</option>
            {choices.map((id) => (
              <option key={id} value={id}>
                {mode === "managed" ? (managedModels.find((item) => item.modelId === id)?.label ?? id) : id}
              </option>
            ))}
          </select>
        </SettingsField>
      </SettingsFieldGrid>
      {mode === "managed" ? (
        <p className="mc-next-settings-field-note">
          {projection?.binary.found
            ? `Installed ${projection.binary.label ?? "llama-server"} detected · ${managedModels.length} GGUF file(s) discovered.`
            : "llama-server was not found. Install it and place a GGUF in the configured models root, then refresh."}
        </p>
      ) : (
        <p className="mc-next-settings-field-note">
          {catalogState === "fresh"
            ? `${choices.length} model(s) freshly reported by the server.`
            : catalogState === "empty"
              ? "The server is reachable but its model list is empty."
              : catalogState === "stale"
                ? "Live catalog unavailable; template aliases are not selectable."
                : "Check the server to load its live models."}
        </p>
      )}
      <SettingsButtonRow>
        {mode === "external" ? (
          <NativeButton variant="secondary" disabled={busy || !baseUrl.trim()} onClick={() => void checkServer()}>
            Check server
          </NativeButton>
        ) : (
          <NativeButton variant="secondary" disabled={busy} onClick={() => void refresh()}>
            Refresh installed files
          </NativeButton>
        )}
        <NativeButton
          variant="default"
          disabled={
            busy ||
            !model ||
            (mode === "external" && catalogState !== "fresh") ||
            (mode === "managed" && !projection?.binary.found) ||
            Boolean(plan && !SETTLED.has(plan.status))
          }
          onClick={() => void finish()}
        >
          Finish setup
        </NativeButton>
      </SettingsButtonRow>
      {plan?.status === "awaiting_approval" && plan.requiredAction?.kind === "approval" ? (
        <section aria-label="Review llama.cpp approval">
          <h3>Review one change</h3>
          <p>{plan.summary}</p>
          <p>{plan.impact}</p>
          <SettingsButtonRow>
            <NativeButton disabled={busy} onClick={() => void decide("approve")}>
              Approve and apply
            </NativeButton>
            <NativeButton variant="outline" disabled={busy} onClick={() => void decide("reject")}>
              Reject
            </NativeButton>
            <NativeButton
              variant="ghost"
              onClick={() =>
                navigate({
                  area: "ops",
                  section: "approvals",
                  approvalId: plan.requiredAction?.kind === "approval" ? plan.requiredAction.approvalId : undefined,
                  theme: route.theme,
                })
              }
            >
              Open approval details
            </NativeButton>
          </SettingsButtonRow>
        </section>
      ) : null}
      {plan && SETTLED.has(plan.status) ? <p role="status">{plan.result?.summary ?? status}</p> : null}
      {plan?.status === "completed" || selectedChat ? (
        <SettingsButtonRow>
          <NativeButton variant="secondary" disabled={busy} onClick={() => void sendTest()}>
            Send test message
          </NativeButton>
        </SettingsButtonRow>
      ) : null}
      {test ? (
        <section aria-live="polite">
          <strong>{testStale ? "Test stale" : test.success ? "Chat tested" : "Chat test failed"}</strong>
          <p>
            {test.providerId} · {test.model} · {test.elapsedMs} ms
          </p>
          {test.responseExcerpt ? <blockquote>{test.responseExcerpt}</blockquote> : null}
          {test.error ? <p>{test.error}</p> : null}
          {test.traceRef ? <p className="mc-next-settings-field-note">Trace: {test.traceRef}</p> : null}
        </section>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </NativeCard>
  );
}
