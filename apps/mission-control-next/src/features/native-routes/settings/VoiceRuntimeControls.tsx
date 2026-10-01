import type { ButtonHTMLAttributes, ComponentType } from "react";
import type { VoiceRuntimeStatus } from "@goatcitadel/contracts";
import { NativeButton } from "../primitives";
import { useVoiceRuntimeSettings } from "./use-voice-runtime-settings";
import { VoiceRuntimeReview } from "./VoiceRuntimeReview";

export function VoiceRuntimeControls({
  status,
  available,
  active = true,
  reload,
  cockpit = false,
  buttonComponent: Action = NativeButton,
}: {
  status?: VoiceRuntimeStatus | null;
  available: boolean;
  active?: boolean;
  reload: () => Promise<unknown>;
  cockpit?: boolean;
  buttonComponent?: ComponentType<ButtonHTMLAttributes<HTMLButtonElement>>;
}) {
  const control = useVoiceRuntimeSettings({ status, available, active, reload });
  const catalog = Array.isArray(status?.catalog) ? status.catalog : [];
  const installedModels = Array.isArray(status?.installedModels) ? status.installedModels : [];
  const starter = catalog.find((model) => model.defaultInstall) ?? catalog[0];
  const installed = installedModels[0];
  return (
    <section
      aria-label="Local voice runtime controls"
      className={cockpit ? "space-y-3 text-sm text-fg-secondary" : "mc-next-settings-stack"}
    >
      <p>
        Runtime readiness: {control.ready ? status?.readiness : "Unavailable"}. Selected model:{" "}
        {status?.selectedModelId || "None reported"}.
      </p>
      <p>
        Local transcription configuration applies to every workspace. Installation can download binaries and model
        files; activation changes the selected model. Neither action starts a microphone session.
      </p>
      {status?.source === "env_override" ? (
        <p role="status">
          Environment overrides control this voice runtime. Change those values through its host owner before managing
          installation or model selection here.
        </p>
      ) : null}
      <div className={cockpit ? "flex flex-wrap gap-2" : "mc-next-settings-button-row"}>
        <Action
          disabled={!starter || !control.canRequest({ kind: "install", modelId: starter.id })}
          onClick={() => starter && control.requestReview({ kind: "install", modelId: starter.id })}
        >
          Install starter model
        </Action>
        {installed ? (
          <Action
            disabled={!control.canRequest({ kind: "select", modelId: installed.modelId })}
            onClick={() => control.requestReview({ kind: "select", modelId: installed.modelId })}
          >
            Activate first installed
          </Action>
        ) : null}
      </div>
      <ul aria-label="Voice model catalog" className={cockpit ? "space-y-2" : "mc-next-settings-stack"}>
        {catalog.slice(0, 100).map((model) => {
          const present = installedModels.some((item) => item.modelId === model.id);
          const selected = status?.selectedModelId === model.id;
          const action = { kind: present ? ("select" as const) : ("install" as const), modelId: model.id };
          return (
            <li
              key={model.id}
              className={
                cockpit
                  ? "flex flex-wrap items-center justify-between gap-2 rounded-md border border-line p-3"
                  : "mc-next-settings-panel"
              }
            >
              <div>
                <strong>{model.label}</strong>
                <p>
                  {model.languageScope} · {model.approxSizeLabel} ·{" "}
                  {selected ? "Selected" : present ? "Installed" : "Not installed"}
                </p>
              </div>
              <Action disabled={selected || !control.canRequest(action)} onClick={() => control.requestReview(action)}>
                {selected ? "Selected" : present ? `Use ${model.label}` : `Install ${model.label}`}
              </Action>
            </li>
          );
        })}
      </ul>
      {!catalog.length ? <p>No voice models were reported by the catalog owner.</p> : null}
      <details>
        <summary>Voice runtime details</summary>
        <dl className="break-all">
          <dt>Source</dt>
          <dd>{status?.source ?? "Unavailable"}</dd>
          <dt>Binary</dt>
          <dd>{status?.binaryPath ?? "Not reported"}</dd>
          <dt>Selected model file</dt>
          <dd>{status?.selectedModelPath ?? "Not reported"}</dd>
          <dt>FFmpeg helper</dt>
          <dd>{status?.ffmpegReady ? "Available" : "Not confirmed"}</dd>
        </dl>
      </details>
      {status?.lastError ? <p role="status">{status.lastError}</p> : null}
      {control.message ? <p role="status">{control.message}</p> : null}
      {control.attempt ? (
        <p role={control.attempt.state === "uncertain" ? "alert" : "status"}>{control.attempt.message}</p>
      ) : null}
      {control.review ? <VoiceRuntimeReview control={control} /> : null}
    </section>
  );
}
