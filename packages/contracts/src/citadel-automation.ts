/**
 * Watchtower automation risk modes — spec §19.2
 *
 * Modes form a risk ladder:
 *   observe → draft → stage → execute_with_approval → autopilot
 *
 * Only the top two tiers can touch external systems; only
 * execute_with_approval requires per-action human sign-off.
 */

export type AutomationRiskMode =
  | "observe" // read only
  | "draft" // create proposals/reports/drafts
  | "stage" // prepare changes, no external side effect
  | "execute_with_approval" // perform an approved external action
  | "autopilot"; // low-risk, reversible, bounded actions only

/**
 * Can this mode cause an external side effect / write at all?
 *
 * observe, draft, and stage have NO external side effects.
 * execute_with_approval and autopilot can write to external systems.
 */
export function automationCanExternalWrite(mode: AutomationRiskMode): boolean {
  switch (mode) {
    case "observe":
      return false;
    case "draft":
      return false;
    case "stage":
      return false;
    case "execute_with_approval":
      return true;
    case "autopilot":
      return true;
  }
}

/**
 * Does this mode require explicit human approval before each external action?
 *
 * Only execute_with_approval demands per-action sign-off.
 * autopilot is pre-authorized for low-risk, reversible, bounded actions.
 */
export function automationRequiresApproval(mode: AutomationRiskMode): boolean {
  switch (mode) {
    case "observe":
      return false;
    case "draft":
      return false;
    case "stage":
      return false;
    case "execute_with_approval":
      return true;
    case "autopilot":
      return false;
  }
}
