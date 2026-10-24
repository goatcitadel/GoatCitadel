import { useCockpitNavigation } from "../../app/cockpit-navigation-context";
import { isModifiedClick } from "../../lib/modified-click";

const CHAT_HREF = "/chat";

/**
 * Background jobs never run on the Claude Code CLI unless a utility model is set (#493): each call would
 * start its own process on the operator's subscription. Read-only, because the Gateway decides this.
 */
export function ClaudeCliBackgroundJobsNotice() {
  const { navigate } = useCockpitNavigation();
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
