import { useQuery } from "@tanstack/react-query";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/client";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/types";
import { useCockpitNavigation } from "../../app/cockpit-navigation-context";
import { isModifiedClick } from "../../lib/modified-click";

const CHAT_HREF = "/chat";

/**
 * Mirrors the Gateway's background-job rule (#493): jobs are skipped while the Chat provider runs as the
 * Claude Code CLI, unless the utility-model override applies (its flag is on and the utility provider has
 * an API key). Unknown settings show nothing rather than a claim the page cannot back.
 */
export function backgroundJobsSkippedOnClaudeCli(settings: RuntimeSettingsResponse | undefined): boolean {
  if (!settings) return false;
  const providers = settings.llm.providers;
  const active = providers.find((provider) => provider.providerId === settings.llm.activeProviderId);
  if ((active?.resolvedApiStyle ?? active?.apiStyle) !== "claude-code-cli") return false;
  const utilityProviderId = settings.llm.utilityProviderId;
  const utility = utilityProviderId
    ? providers.find((provider) => provider.providerId === utilityProviderId)
    : undefined;
  const overrideApplies = settings.features?.utilityModelRoutingV1Enabled === true && Boolean(utility?.hasApiKey);
  return !overrideApplies;
}

/** Read-only, because the Gateway decides which provider background jobs use. */
export function ClaudeCliBackgroundJobsNotice() {
  const { navigate } = useCockpitNavigation();
  const query = useQuery({
    queryKey: ["system", "settings-claude-cli-background-jobs"],
    queryFn: () => fetchSettings(),
    refetchInterval: 60_000,
  });
  if (!backgroundJobsSkippedOnClaudeCli(query.data)) return null;
  return (
    <section aria-labelledby="claude-cli-background-jobs-title" className="mt-4 border-t border-line-subtle pt-4">
      <h3 id="claude-cli-background-jobs-title" className="text-md font-semibold text-fg">
        Claude Code CLI: background jobs are off
      </h3>
      <p className="mt-1 text-sm text-fg-secondary">
        While the Claude Code CLI is your Chat provider, GoatCitadel skips follow-up suggestions, learned facts about
        you, and procedure reviews. Each of these would start its own Claude Code process and count against your Claude
        subscription. To turn them on, set a utility model on a provider with an API key. Chat can propose that change
        for you:{" "}
        <a
          href={CHAT_HREF}
          onClick={(event) => {
            if (isModifiedClick(event)) return;
            event.preventDefault();
            navigate(CHAT_HREF);
          }}
          className="font-medium text-accent hover:underline"
        >
          Open Chat
        </a>
        .
      </p>
    </section>
  );
}
