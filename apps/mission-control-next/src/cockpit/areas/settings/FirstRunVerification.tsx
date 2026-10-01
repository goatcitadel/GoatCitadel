import { useQuery } from "@tanstack/react-query";
import {
  fetchOnboardingState,
  fetchAgenticRuns,
  fetchEvidenceEnvelopes,
} from "@goatcitadel/mission-control-shared/api/client";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import {
  deriveEcosystemProofLaneItems,
  deriveOnboardingProviderSmokeEvidenceItems,
  deriveSetupCenterItems,
} from "../../../features/native-routes/settings/helpers/onboarding-readiness";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { useDraftLeave } from "../../../features/native-routes/library/DraftLeaveDialog";
import { McpDraftLeave } from "./McpDraftLeave";

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
  return (
    <section
      aria-label="First-run verification evidence"
      className="grid gap-4 rounded-lg border border-line bg-raised p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-semibold text-fg">Verification evidence</h2>
        <Button disabled={query.isFetching} onClick={() => void query.refetch()}>
          Refresh evidence
        </Button>
      </div>
      {query.isLoading ? <p role="status">Reading Gateway evidence…</p> : null}
      {query.isError ? <p role="alert">Verification evidence is unavailable. No readiness is inferred.</p> : null}
      {state ? (
        <>
          <p className="text-sm text-fg-secondary">
            Setup marker: {state.completed ? "recorded" : "not recorded"}. First Chat response:{" "}
            {state.firstTask?.status === "verified"
              ? `verified by the Gateway with ${state.firstTask.providerId} / ${state.firstTask.model}`
              : "not observed"}
            . Neither sample records nor configured credentials certify execution.
          </p>
          <EvidenceList title="Setup Center" items={deriveSetupCenterItems(state)} />
          <details className="rounded-md border border-line p-3">
            <summary className="cursor-pointer font-medium text-fg">Provider smoke evidence</summary>
            <EvidenceList title="Provider checks" items={deriveOnboardingProviderSmokeEvidenceItems(state)} />
            <p className="mt-3 text-sm text-fg-secondary">
              Live provider release proof requires the named install lane with real credentials; this page does not run
              it.
            </p>
          </details>
          <details className="rounded-md border border-line p-3">
            <summary className="cursor-pointer font-medium text-fg">Gateway access and remote readiness</summary>
            {state.setupReadiness ? (
              <div className="mt-3 grid gap-3 text-sm text-fg-secondary">
                <p>
                  Gateway: <span className="break-all font-mono">{state.setupReadiness.profile.gatewayUrl}</span>
                </p>
                <p>
                  Auth: {humanizeToken(state.setupReadiness.profile.authMode)} · Posture:{" "}
                  {humanizeToken(state.setupReadiness.profile.deploymentPosture)}
                </p>
                <ul className="grid gap-3">
                  {state.setupReadiness.items.map((item) => (
                    <li key={item.id}>
                      <p className="font-medium text-fg">
                        {item.label} — {humanizeToken(item.status)}
                      </p>
                      <p className="break-words">
                        {item.value}: {item.detail}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="mt-3 text-sm text-fg-muted">Remote readiness evidence is unavailable.</p>
            )}
          </details>
          <details className="rounded-md border border-line p-3">
            <summary className="cursor-pointer font-medium text-fg">First-run checklist and proof references</summary>
            <ul className="mt-3 grid gap-3 text-sm text-fg-secondary">
              {state.firstRunChecklist?.map((item) => (
                <li key={item.id}>
                  <p className="font-medium text-fg">
                    {item.label} — {humanizeToken(item.status)}
                  </p>
                  <p>{item.detail}</p>
                  <ul className="mt-1 grid gap-1">
                    {item.proofRefs.map((ref, index) => (
                      <li key={index}>
                        {ref.label} <span className="break-all font-mono text-xs">{ref.ref}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            {!state.firstRunChecklist?.length ? (
              <p className="mt-3 text-sm text-fg-muted">No first-run checklist references were returned.</p>
            ) : null}
          </details>
          <details className="rounded-md border border-line p-3">
            <summary className="cursor-pointer font-medium text-fg">Recent installation evidence</summary>
            <p className="mt-3 text-sm text-fg-secondary">
              Up to ten recent installation records from each owner. These are not bound to this workspace or to your
              first-run journey.
            </p>
            {data?.runs.error ? (
              <p role="status">Recent run evidence is unavailable.</p>
            ) : (
              <ul className="mt-3 grid gap-2 text-sm text-fg-secondary">
                {data?.runs.value?.items.map((run) => (
                  <li key={run.runId}>
                    <span className="break-all font-mono">{run.runId}</span> — {humanizeToken(run.status ?? "unknown")}
                  </li>
                ))}
              </ul>
            )}
            {data?.envelopes.error ? (
              <p role="status">Evidence envelopes are unavailable.</p>
            ) : (
              <ul className="mt-3 grid gap-2 text-sm text-fg-secondary">
                {data?.envelopes.value?.items.map((item) => (
                  <li key={item.envelopeId}>
                    <span className="break-all font-mono">{item.envelopeId}</span> — {humanizeToken(item.eventKind)}
                  </li>
                ))}
              </ul>
            )}
          </details>
          <details className="rounded-md border border-line p-3">
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
              {item.label} — {humanizeToken(item.state)}
            </p>
            <p>{item.description}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
