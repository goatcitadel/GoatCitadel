import type { ChangePlanRecord } from "@goatcitadel/contracts";
import type { useProviderOAuthFlow } from "../../../features/native-routes/settings/sections/use-provider-oauth-flow";
import type { useProviderCodexSetup } from "../../../features/native-routes/settings/sections/use-provider-codex-setup";
import { Button } from "../../ui/Button";
import { ProviderChangeStatus } from "./ProviderChangeStatus";

export function ProviderOAuthSettings({
  oauth,
  setup,
  configured,
  onReview,
}: {
  oauth: ReturnType<typeof useProviderOAuthFlow>;
  setup: ReturnType<typeof useProviderCodexSetup>;
  configured: boolean;
  onReview: (plan: ChangePlanRecord) => void;
}) {
  const status = oauth.codexOAuthStatus,
    flow = oauth.codexOAuthFlow,
    plan = oauth.codexOAuthPlan;
  const locked = oauth.codexOAuthBusy || Boolean(oauth.mutation.uncertain);
  const stopped =
    plan && ["completed", "applied", "cancelled", "failed", "rolled_back", "rollback_failed"].includes(plan.status);
  return (
    <section aria-label="ChatGPT OAuth" className="mt-4 space-y-3 border-t border-line-subtle pt-4">
      <h4 className="font-display text-md font-semibold text-fg">ChatGPT OAuth</h4>
      <p className="text-sm text-fg-secondary">
        Provider profile: {configured ? "Configured" : "Not configured"}. Login:{" "}
        {status
          ? status.connected
            ? "Connected"
            : status.requiresReauth
              ? "Reauthorization required"
              : "Not connected"
          : "Unavailable"}
        .
      </p>
      {status?.accountLabel ? <p className="text-sm text-fg-secondary">Account: {status.accountLabel}</p> : null}
      {oauth.codexOAuthStatusError ? (
        <p role="alert" className="text-sm text-status-failed">
          OAuth status unavailable: {oauth.codexOAuthStatusError}
        </p>
      ) : null}
      <p className="text-xs text-fg-muted">
        The Gateway owns login, secure storage, and exact credential promotion. Login approval does not change
        installation routing; review default routing separately.
      </p>
      <div className="flex flex-wrap gap-2">
        {!configured ? (
          <Button disabled={locked || setup.hasPending} onClick={() => void setup.add()}>
            Add ChatGPT provider
          </Button>
        ) : (
          <Button disabled={locked || !status?.available} onClick={() => void oauth.handleStartCodexOAuth(true)}>
            {status?.connected ? "Reconnect ChatGPT" : "Start ChatGPT login"}
          </Button>
        )}
        <Button disabled={locked} onClick={() => void oauth.refreshCodexOAuthStatus().catch(() => undefined)}>
          Refresh OAuth status
        </Button>
        {status?.connected || status?.requiresReauth ? (
          <Button variant="danger" disabled={locked} onClick={() => void oauth.handleDisconnectCodexOAuth()}>
            Review OAuth disconnect
          </Button>
        ) : null}
      </div>
      {flow ? (
        <div className="space-y-2 rounded-md border border-line p-3 text-sm text-fg-secondary">
          <p>Current login expires {flow.expiresAt}.</p>
          {flow.userCode ? (
            <p>
              OpenAI code: <strong className="font-mono text-fg">{flow.userCode}</strong>
            </p>
          ) : (
            <p>Awaiting browser approval.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button disabled={locked} onClick={oauth.handleOpenCodexOAuthVerification}>
              Open OpenAI page
            </Button>
            <Button disabled={locked} onClick={() => void oauth.handlePollCodexOAuth()}>
              I approved, check now
            </Button>
            <Button disabled={locked} onClick={() => void oauth.handleRestartCodexOAuth()}>
              Reopen login
            </Button>
          </div>
        </div>
      ) : null}
      {plan ? (
        <div className="space-y-2 rounded-md border border-line p-3 text-sm text-fg-secondary">
          <p role="status">
            <strong>{plan.status.replaceAll("_", " ")}</strong> · {plan.result?.summary ?? plan.summary}
          </p>
          <div className="flex flex-wrap gap-2">
            {plan.requiredAction ? (
              <Button disabled={locked} onClick={() => onReview(plan)}>
                Review OAuth step
              </Button>
            ) : null}
            {!stopped && plan.requiredAction ? (
              <Button disabled={locked} onClick={() => void oauth.handleCancelCodexOAuth(plan)}>
                Cancel OAuth plan
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      <ProviderChangeStatus change={setup.change} onRefresh={setup.refresh} onReview={onReview} />
    </section>
  );
}
