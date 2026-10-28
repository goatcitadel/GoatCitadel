import { useCockpitNavigation } from "../../app/cockpit-navigation-context";
import { isModifiedClick } from "../../lib/modified-click";

/** The Permissions tab on Settings › Safety owns the explanation; every other rule page links here. */
export const RULES_PRECEDENCE_HREF = "/settings/safety#permission-profile";

/**
 * How the five places that hold rules combine, in the order the Gateway policy engine checks them
 * (`packages/policy-engine/src/engine.ts` › evaluateAccessInternal). Keep this copy in step with that order.
 */
export const RULES_PRECEDENCE_STEPS = [
  {
    title: "Deny lists",
    detail: "A deny in settings or in the permission profile blocks the tool. Nothing else can allow it.",
  },
  {
    title: "Tool groups",
    detail:
      "A group switched off in Capabilities › Tools blocks its tools for the AI. Allow rules and grants can't lift it.",
  },
  {
    title: "Permissions · profile limit",
    detail:
      "A tool outside the active permission profile is blocked. Tool grants and temporary overrides cannot add it.",
  },
  {
    title: "Rules · Wards",
    detail: "A Citadel rule that denies blocks the tool. A rule can also require your approval first.",
  },
  {
    title: "Tools · grants",
    detail:
      "A deny grant blocks the tool. An allow grant lets a tool inside the profile run, and can skip the routine prompt.",
  },
  {
    title: "Trust & policy",
    detail: "Read-only. Content from an untrusted source cannot start a privileged tool.",
  },
] as const;

export function RulesPrecedenceExplainer() {
  return (
    <section
      id="how-rules-combine"
      aria-labelledby="how-rules-combine-title"
      className="space-y-2 border-t border-line-subtle pt-4"
    >
      <h4 id="how-rules-combine-title" className="text-sm font-semibold text-fg">
        How allow and deny rules combine
      </h4>
      <p className="text-sm text-fg-secondary">
        Five places hold rules: Permissions, Tools, Trust & policy, Rules · Wards and the tool groups in Capabilities.
        Deny always wins: one matching deny blocks the action, whatever else allows it. They are checked in this order:
      </p>
      <ol className="list-inside list-decimal space-y-1 text-sm text-fg-secondary">
        {RULES_PRECEDENCE_STEPS.map((step) => (
          <li key={step.title}>
            <span className="font-medium text-fg">{step.title}.</span> {step.detail}
          </li>
        ))}
      </ol>
      <p className="text-sm text-fg-secondary">
        If the tool is still allowed, approval settings decide whether you are asked first. A temporary override skips
        routine prompts, but never lifts a deny, the profile limit or a rule that requires approval, and nuclear-risk
        actions always ask. Sign-in, path and network limits apply on top of all of this.
      </p>
    </section>
  );
}

/** One line on the other rule pages that points at the explanation on Permissions. */
export function RulesPrecedenceLink() {
  const { navigate } = useCockpitNavigation();
  return (
    <p className="text-sm text-fg-secondary">
      Deny always wins across Permissions, Tools, Trust & policy, Rules · Wards and the tool groups in Capabilities.{" "}
      <a
        href={RULES_PRECEDENCE_HREF}
        onClick={(event) => {
          if (isModifiedClick(event)) return;
          event.preventDefault();
          navigate(RULES_PRECEDENCE_HREF);
        }}
        className="font-medium text-accent hover:underline"
      >
        See how rules combine in Permissions
      </a>
    </p>
  );
}
