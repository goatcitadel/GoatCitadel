import { useQuery } from "@tanstack/react-query";
import type { OnboardingFirstRunProofRef } from "@goatcitadel/contracts";
import {
  fetchOnboardingState,
  fetchAgenticRuns,
  fetchEvidenceEnvelopes,
} from "@goatcitadel/mission-control-shared/api/client";
import {
  deriveEcosystemProofLaneItems,
  deriveOnboardingProviderSmokeEvidenceItems,
} from "../../../features/native-routes/settings/helpers/onboarding-readiness";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { useDraftLeave } from "../../../features/native-routes/library/DraftLeaveDialog";
import { McpDraftLeave } from "./McpDraftLeave";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { useModelLabel } from "../../data/use-model-label";
import {
  AGENTIC_RUN_STATUS_LABELS,
  AUTH_MODE_LABELS,
  CHECKLIST_STATUS_LABELS,
  DEPLOYMENT_POSTURE_LABELS,
  EVIDENCE_EVENT_KIND_LABELS,
  presentReadinessValue,
  presentSetupCenterItems,
  presentSetupLabel,
  READINESS_STATUS_LABELS,
  SETUP_STEP_STATE_LABELS,
} from "./setup-vocabulary";

async function optional<T>(read: Promise<T>): Promise<{ value: T; error?: never } | { value?: never; error: true }> {
  try {
    return { value: await read };
  } catch {
    return { error: true };
  }
}
const destinations: Record<string, string> = {
  voice: "/settings/advanced#voice-runtime",
  "browser-control": "/settings/connections#mcp-servers",
  "extension-sdk": "/settings/connections",
  "packaging-remote": "/system/health",
  "mobile-companion": "/settings/safety#device-access",
  "canvas-a2ui": "/library/capabilities",
};
export function FirstRunVerification() {
  const { navigate } = useCockpitRoute();
  const leave = useDraftLeave();
  const query = useQuery({
    queryKey: ["system", "first-run-verification"],
    queryFn: async ({ signal }) => {
      const [state, runs, envelopes] = await Promise.all([
        fetchOnboardingState({ signal }),
        optional(fetchAgenticRuns({ limit: 10 })),
        optional(fetchEvidenceEnvelopes({ limit: 10 })),
      ]);
      return { state, runs, envelopes };
    },
  });
  const data = query.isError ? undefined : query.data,
    state = data?.state;
  const verifiedTask = state?.firstTask?.status === "verified" ? state.firstTask : undefined;
  const firstTaskVerified = Boolean(verifiedTask);
  const firstTaskModel = useModelLabel(verifiedTask?.providerId, verifiedTask?.model, firstTaskVerified);
  return (
    <section
      aria-label="First-run checks"
      className="grid gap-4 border-t border-line-subtle pt-4 first:border-t-0 first:pt-0"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-fg">Setup checks</h2>
        <Button disabled={query.isFetching} onClick={() => void query.refetch()}>
          Refresh checks
        </Button>
      </div>
      {query.isLoading ? <p role="status">Running setup checks…</p> : null}
      {query.isError ? <p role="alert">Setup checks could not load. Nothing is assumed ready.</p> : null}
      {state ? (
        <>
          <p className="text-sm text-fg-secondary">
            Setup marker: {state.completed ? "recorded" : "not recorded"}. First Chat response:{" "}
            {state.firstTask?.status === "verified" ? `verified by GoatCitadel with ${firstTaskModel}` : "not observed"}
            . Neither sample records nor configured credentials certify execution.
          </p>
          <EvidenceList title="Setup Center" items={presentSetupCenterItems(state)} />
          <details className="border-t border-line-subtle py-3">
            <summary className="cursor-pointer font-medium text-fg">Provider test results</summary>
            <EvidenceList title="Provider checks" items={deriveOnboardingProviderSmokeEvidenceItems(state)} />
            <p className="mt-3 text-sm text-fg-secondary">
              Live provider release proof requires the named install lane with real credentials; this page does not run
              it.
            </p>
          </details>
          <details className="border-t border-line-subtle py-3">
            <summary className="cursor-pointer font-medium text-fg">Sign-in and remote readiness</summary>
            {state.setupReadiness ? (
              <div className="mt-3 grid gap-3 text-sm text-fg-secondary">
                <p>
                  Server address: <span className="break-all font-mono">{state.setupReadiness.profile.gatewayUrl}</span>
                </p>
                <p>
                  Auth: {presentSetupLabel(AUTH_MODE_LABELS, state.setupReadiness.profile.authMode)} · Deployment:{" "}
                  {presentSetupLabel(DEPLOYMENT_POSTURE_LABELS, state.setupReadiness.profile.deploymentPosture)}
                </p>
                <ul className="grid gap-3">
                  {state.setupReadiness.items.map((item) => {
                    const value = presentReadinessValue(item);
                    return (
                      <li key={item.id}>
                        <p className="font-medium text-fg">
                          {item.label} — {presentSetupLabel(READINESS_STATUS_LABELS, item.status)}
                        </p>
                        <p className="break-words">{value ? `${value}. ${item.detail}` : item.detail}</p>
                        <TechnicalDetails label={`${item.label} technical details`}>
                          <ProofRefList value={item.value} refs={item.proofRefs ?? []} />
                        </TechnicalDetails>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : (
              <p className="mt-3 text-sm text-fg-muted">Remote readiness could not load.</p>
            )}
          </details>
          <details className="border-t border-line-subtle py-3">
            <summary className="cursor-pointer font-medium text-fg">First-run checklist and proof references</summary>
            <ul className="mt-3 grid gap-3 text-sm text-fg-secondary">
              {state.firstRunChecklist?.map((item) => (
                <li key={item.id}>
                  <p className="font-medium text-fg">
                    {item.label} — {presentSetupLabel(CHECKLIST_STATUS_LABELS, item.status)}
                  </p>
                  <p>{item.detail}</p>
                  {item.proofRefs.length ? (
                    <p className="mt-1">Checked through: {item.proofRefs.map((ref) => ref.label).join(", ")}</p>
                  ) : null}
                  <TechnicalDetails label={`${item.label} proof references`}>
                    <ProofRefList refs={item.proofRefs} />
                  </TechnicalDetails>
                </li>
              ))}
            </ul>
            {!state.firstRunChecklist?.length ? (
              <p className="mt-3 text-sm text-fg-muted">No first-run checklist references were returned.</p>
            ) : null}
          </details>
          <details className="border-t border-line-subtle py-3">
            <summary className="cursor-pointer font-medium text-fg">Recent installation records</summary>
            <p className="mt-3 text-sm text-fg-secondary">
              Up to ten recent installation records from each source. These are not bound to this workspace or to your
              first-run journey.
            </p>
            {data?.runs.error ? (
              <p role="status">Recent runs could not load.</p>
            ) : (
              <ul className="mt-3 grid gap-2 text-sm text-fg-secondary">
                {data?.runs.value?.items.map((run) => (
                  <li key={run.runId}>
                    <span className="break-words">{run.title || "Untitled run"}</span> —{" "}
                    {presentSetupLabel(AGENTIC_RUN_STATUS_LABELS, run.status)}
                    <TechnicalDetails label="Run details">
                      <span className="break-all font-mono text-xs">{run.runId}</span>
                    </TechnicalDetails>
                  </li>
                ))}
              </ul>
            )}
            {data?.envelopes.error ? (
              <p role="status">Installation records could not load.</p>
            ) : (
              <ul className="mt-3 grid gap-2 text-sm text-fg-secondary">
                {data?.envelopes.value?.items.map((item) => (
                  <li key={item.envelopeId}>
                    {presentSetupLabel(EVIDENCE_EVENT_KIND_LABELS, item.eventKind)}
                    <TechnicalDetails label="Envelope details">
                      <span className="break-all font-mono text-xs">{item.envelopeId}</span>
                    </TechnicalDetails>
                  </li>
                ))}
              </ul>
            )}
          </details>
          <details className="border-t border-line-subtle py-3">
            <summary className="cursor-pointer font-medium text-fg">Ecosystem proof lanes</summary>
            <ul className="mt-3 grid gap-3 text-sm text-fg-secondary">
              {deriveEcosystemProofLaneItems().map((item) => (
                <li key={item.id}>
                  <p className="font-medium text-fg">{item.label}</p>
                  <p>{item.description}</p>
                  <a
                    className="text-accent underline"
                    href={destinations[item.id]}
                    onClick={(event) => {
                      event.preventDefault();
                      leave.request(() => navigate(destinations[item.id] ?? "/system/health"));
                    }}
                  >
                    {item.actionLabel}
                  </a>
                </li>
              ))}
            </ul>
          </details>
        </>
      ) : null}
      <McpDraftLeave {...leave.dialogProps} />
    </section>
  );
}
/** Raw readiness values and proof references (routes, lanes, trace kinds) for the technical-details slot. */
function ProofRefList({ value, refs }: { value?: string; refs: OnboardingFirstRunProofRef[] }) {
  return (
    <ul className="grid gap-1 font-mono text-xs">
      {value ? <li className="break-all">value: {value}</li> : null}
      {refs.map((ref, index) => (
        <li key={`${ref.kind}:${ref.ref}:${index}`} className="break-all">
          {ref.kind}: {ref.ref}
        </li>
      ))}
    </ul>
  );
}
function EvidenceList({
  title,
  items,
}: {
  title: string;
  items: Array<{ label: string; description: string; state: string }>;
}) {
  return (
    <div className="mt-3 grid gap-2">
      <h3 className="font-medium text-fg">{title}</h3>
      <ul className="grid gap-3 text-sm text-fg-secondary">
        {items.map((item) => (
          <li key={item.label}>
            <p className="font-medium text-fg">
              {item.label} — {presentSetupLabel(SETUP_STEP_STATE_LABELS, item.state)}
            </p>
            <p>{item.description}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
