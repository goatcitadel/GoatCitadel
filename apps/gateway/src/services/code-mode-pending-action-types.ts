/**
 * Pending-action types the Code Mode executor owns. Kept dependency-free so approval routing can recognise them
 * without importing the promotion implementation.
 */

export const CODE_MODE_RUN_ACTION_TYPE = "code_mode.run" as const;
export const CODE_MODE_AIDER_PROMOTE_ACTION_TYPE = "code_mode.aider_promote" as const;

/** True for the pending actions the Code Mode executor owns: an approved run and an approved Aider promotion. */
export function isCodeModePendingActionType(actionType: unknown): boolean {
  return actionType === CODE_MODE_RUN_ACTION_TYPE || actionType === CODE_MODE_AIDER_PROMOTE_ACTION_TYPE;
}
