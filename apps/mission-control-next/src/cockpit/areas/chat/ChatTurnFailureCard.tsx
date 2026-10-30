import type { ChatTurnFailureClass } from "@goatcitadel/contracts";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { Button } from "../../ui/Button";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { presentFailureClass } from "./chat-vocabulary";

const MODEL_SETTINGS_HREF = "/settings/models#providers";

/** A headline per failure kind, so the card says what went wrong before it says what to do. */
const FAILURE_TITLES: Partial<Record<ChatTurnFailureClass, string>> = {
  provider_rate_limited: "The model provider is limiting requests",
  context_too_long: "This conversation is too long for the model",
  provider_billing: "The model provider turned this request down",
  auth_required: "The model provider needs you to sign in again",
  provider_timeout: "The model took too long to answer",
  network_interrupted: "The connection dropped",
  interrupted_by_restart: "GoatCitadel restarted during this answer",
  tool_blocked: "A tool was blocked",
  tool_failed: "A tool couldn’t finish",
  tool_loop_guard: "This answer hit a limit",
  global_circuit_breaker: "This answer hit a limit",
  tool_run_budget_exceeded: "This answer hit a limit",
  turn_budget_exceeded: "This answer hit a limit",
  budget_exceeded: "This answer hit a limit",
  skill_security_blocked: "A security check stopped this answer",
  guidance_security_blocked: "A security check stopped this answer",
  approval_required: "This answer is waiting for approval",
};

/** Failure kinds whose fix lives with the provider account, so the card links to where providers are set up. */
const PROVIDER_ACCOUNT_FAILURES = new Set<ChatTurnFailureClass>(["auth_required", "provider_billing"]);

/**
 * The card under a failed or partial answer: what went wrong, what to do next, and the one action that fixes it when
 * the fix is not a retry (Retry stays with the turn's own actions below). A partial answer keeps the softer heading.
 */
export function ChatTurnFailureCard({
  failed,
  answered,
  failureClass,
  hint,
  onNewConversation,
}: {
  failed: boolean;
  /** The turn recorded an answer; a failed one then explains itself, so an unnamed failure needs no heading. */
  answered: boolean;
  failureClass?: ChatTurnFailureClass;
  /** What to do next, already fitted to whether this turn can be resent. */
  hint: string;
  onNewConversation?: () => void;
}) {
  const known = failureClass && failureClass !== "unknown" ? failureClass : undefined;
  const title = !failed
    ? "This answer may be incomplete"
    : ((known && FAILURE_TITLES[known]) ?? (answered ? null : "This response failed"));
  // A partial answer's heading does not name the cause, so the cause goes in the sentence instead.
  const cause = !failed && known ? `Cause: ${presentFailureClass(known)}. ` : "";
  const Icon = failed ? CircleAlert : TriangleAlert;
  return (
    <div
      role="note"
      aria-label="Response recovery"
      data-failure-class={known}
      className={`flex gap-2 rounded-md border p-3 text-sm text-fg-secondary ${failed ? "border-status-failed" : "border-status-waiting"}`}
    >
      <Icon
        aria-hidden="true"
        className={`mt-0.5 size-4 shrink-0 ${failed ? "text-status-failed" : "text-status-waiting"}`}
      />
      <div className="min-w-0 space-y-2">
        {title ? <p className="font-medium text-fg">{title}</p> : null}
        <p>
          {cause}
          {hint}
        </p>
        {known && PROVIDER_ACCOUNT_FAILURES.has(known) ? (
          <NativeOwnerLink href={MODEL_SETTINGS_HREF} scope="chat-turn-failure" className="text-sm">
            Open model providers
          </NativeOwnerLink>
        ) : null}
        {known === "context_too_long" && onNewConversation ? (
          <Button size="sm" onClick={onNewConversation}>
            Start a new conversation
          </Button>
        ) : null}
      </div>
    </div>
  );
}
