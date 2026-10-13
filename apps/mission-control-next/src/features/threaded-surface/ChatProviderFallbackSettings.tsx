import { useEffect, useId, useState } from "react";
import type { MissionThreadedContextDockProps } from "@goatcitadel/threaded-surface-core";
import { ContextDisclosure } from "./ThreadedContextDisclosure";

type Props = Pick<
  MissionThreadedContextDockProps,
  | "prefs"
  | "providerOptions"
  | "selectedProviderId"
  | "routePreflight"
  | "selectedTurn"
  | "onPrefPatch"
  | "sending"
  | "loadModelsForProvider"
  | "providerFallbackAvailable"
>;

export function ChatProviderFallbackSettings(props: Props) {
  const { loadModelsForProvider } = props;
  const saved = props.prefs?.providerFallback;
  const [providerId, setProviderId] = useState(saved?.providerId ?? "");
  const [model, setModel] = useState(saved?.model ?? "");
  const [allowLocalToCloud, setAllowLocalToCloud] = useState(saved?.allowLocalToCloud ?? false);
  const [models, setModels] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const listId = useId();
  useEffect(() => {
    setProviderId(saved?.providerId ?? "");
    setModel(saved?.model ?? "");
    setAllowLocalToCloud(saved?.allowLocalToCloud ?? false);
  }, [saved?.providerId, saved?.model, saved?.allowLocalToCloud]);
  const options = (props.providerOptions ?? []).filter((option) => option.providerId !== props.selectedProviderId);
  const provider = options.find((option) => option.providerId === providerId);
  useEffect(() => {
    let current = true;
    setModels([]);
    if (providerId && loadModelsForProvider) {
      void loadModelsForProvider(providerId)
        .then((next) => {
          if (current) setModels(next);
        })
        .catch(() => {
          // The editable exact model ID remains available; Gateway validates it.
          if (current) setModels([]);
        });
    }
    return () => {
      current = false;
    };
  }, [providerId, loadModelsForProvider]);
  const changed =
    providerId !== (saved?.providerId ?? "") ||
    model.trim() !== (saved?.model ?? "") ||
    allowLocalToCloud !== (saved?.allowLocalToCloud ?? false);
  const target = props.routePreflight?.providerFallback;
  const routing = props.selectedTurn?.trace.routing;
  const actualTarget = routing?.effectiveProviderId ?? routing?.fallbackProviderId;
  const actualModel = routing?.effectiveModel ?? routing?.fallbackModel;
  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await props.onPrefPatch({
        providerFallback: providerId ? { providerId, model: model.trim(), allowLocalToCloud } : null,
      });
    } catch {
      setError("Could not save the fallback preference. Check the session status and try again.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <ContextDisclosure summary="Provider fallback">
      <p role="status">
        {!props.providerFallbackAvailable
          ? "Provider fallback is not enabled for this runtime. You can save a preference for later."
          : props.routePreflight?.fallbackPolicy === "armed" && target
            ? `Available fallback: ${target.providerId} / ${target.model}. Rechecked before use.`
            : saved
              ? "Saved fallback is inactive for the current route or Gateway configuration."
              : "Fallback is off."}
      </p>
      <p>
        Choose one backup provider for an initial response failure. It shares the turn’s deadline and budget, and stops
        after one attempt.
      </p>
      <label className="mc-next-context-field">
        <span>Fallback provider</span>
        <select
          aria-label="Fallback provider"
          value={providerId}
          disabled={saving || props.sending}
          onChange={(event) => {
            const next = options.find((option) => option.providerId === event.target.value);
            setProviderId(event.target.value);
            setModel(next?.defaultModel ?? "");
            setAllowLocalToCloud(false);
            setError(undefined);
          }}
        >
          <option value="">Off</option>
          {providerId && !provider ? (
            <option value={providerId} disabled>
              {providerId} (unavailable for this route)
            </option>
          ) : null}
          {options.map((option) => (
            <option key={option.providerId} value={option.providerId} disabled={option.disabled}>
              {option.label}
              {option.disabled ? " (unavailable)" : ""}
            </option>
          ))}
        </select>
      </label>
      {providerId ? (
        <>
          <label className="mc-next-context-field">
            <span>Fallback model</span>
            <input
              aria-label="Fallback model"
              list={listId}
              value={model}
              maxLength={200}
              disabled={saving || props.sending}
              onChange={(event) => setModel(event.target.value)}
              placeholder="Exact model ID"
            />
            <datalist id={listId}>
              {[...new Set([...(provider?.models ?? []), ...models])].map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </label>
          {!provider?.isLocalRuntime ? (
            <label className="mc-next-context-field">
              <span>
                <input
                  type="checkbox"
                  checked={allowLocalToCloud}
                  disabled={saving || props.sending}
                  onChange={(event) => setAllowLocalToCloud(event.target.checked)}
                />{" "}
                Allow local-to-hosted fallback
              </span>
              <small>
                This permits the conversation and included context to be sent to this hosted provider if the primary
                route is local.
              </small>
            </label>
          ) : null}
        </>
      ) : null}
      <button
        type="button"
        className="mc-next-panel-button"
        disabled={
          saving ||
          props.sending ||
          !changed ||
          Boolean(providerId && (!model.trim() || !provider || provider.disabled))
        }
        onClick={() => void save()}
      >
        {saving ? "Saving fallback…" : "Save fallback"}
      </button>
      {error ? <p role="alert">{error}</p> : null}
      {routing?.fallbackUsed ? (
        <p role="status">
          Selected turn switched from {routing.primaryProviderId ?? "unknown provider"} /{" "}
          {routing.primaryModel ?? "unknown model"}
          {" to "}
          {actualTarget ?? "unknown provider"} / {actualModel ?? "unknown model"}.
        </p>
      ) : null}
    </ContextDisclosure>
  );
}
