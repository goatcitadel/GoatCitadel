/** Presentation drafts share one installation-bound key across the two shells.
 * Runtime write admission and unknown-outcome locks remain in their owners. */
export function taskCreateDraftKey(base: string, workspaceId: string, citadelId?: string | null): string {
  return JSON.stringify([base, "task-create-draft", citadelId || null, workspaceId]);
}

export function taskDetailsDraftKey(base: string, workspaceId: string, taskId: string): string {
  return JSON.stringify([base, "task-details-draft", workspaceId, taskId]);
}

/** Schedules are installation-wide, including their unsent creation input. */
export function scheduleCreateDraftKey(base: string): string {
  return JSON.stringify([base, "schedule-create-draft"]);
}
