import {
  canonicalJsonString,
  HOOK_EVENT_REGISTRY,
  HOOK_TRIGGER_VALUES,
  SECRET_REDACTION_MARKER,
  type HookCreateInput,
  type HookMode,
  type HookRecord,
  type HookRunRecord,
  type HookTrigger,
} from "@goatcitadel/contracts";

export { HOOK_TRIGGER_VALUES };
export const HOOK_OWNER_LIMIT = 500;
export const HOOK_OWNER_BOUNDARY =
  "The Gateway enforces policy and egress rules. These APIs have no atomic revision precondition; current public records are checked before each action. Endpoint and signing-secret values remain hidden by the owner.";
export const HOOK_MODES: HookMode[] = ["observe", "mutate", "intercept"];
export type HookPublicForm = { label: string; trigger: HookTrigger; mode: HookMode };
export type HookPrivateForm = { url: string; secret: string };
export type HookForm = HookPublicForm & HookPrivateForm;
export const EMPTY_HOOK_FORM: HookPublicForm = { label: "", trigger: "tool.call.after", mode: "observe" };
export const hooksEqual = (a: unknown, b: unknown) => canonicalJsonString(a) === canonicalJsonString(b);
export type HookReview = { current: () => boolean; title: string; description: string } & (
  | { kind: "create"; form: HookForm; input: Omit<HookCreateInput, "workspaceId"> }
  | { kind: "test" | "delete"; hook: HookRecord }
  | { kind: "redrive"; hook: HookRecord; run: HookRunRecord }
);
export function hookCreateInput(form: HookForm): Omit<HookCreateInput, "workspaceId"> {
  if (!form.label.trim() || !form.url.trim() || !form.secret.trim())
    throw new Error("Label, HTTPS URL, and signing secret are required.");
  const url = new URL(form.url.trim());
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Use an HTTPS endpoint without embedded account credentials.");
  if (!HOOK_EVENT_REGISTRY[form.trigger]?.allowedModes.includes(form.mode))
    throw new Error("This lifecycle event does not support the selected hook mode.");
  return {
    label: form.label.trim(),
    trigger: form.trigger,
    mode: form.mode,
    enabled: true,
    priority: 100,
    timeoutMs: 5_000,
    failPolicy: "open",
    dataScope: "metadata",
    action: { type: "webhook", webhook: { url: form.url.trim(), secret: form.secret } },
  };
}
export function scopedHookRecords<T extends HookRecord | HookRunRecord>(items: T[], workspaceId: string): T[] {
  if (!Array.isArray(items) || items.some((item) => item.workspaceId !== workspaceId))
    throw new Error("Hook evidence is unavailable or belongs to another workspace.");
  return items;
}
export function exactHookRecord<T extends HookRecord | HookRunRecord>(
  items: T[],
  id: string,
  field: "hookId" | "runId",
): T {
  const matches = items.filter((item) => field in item && item[field as keyof T] === id);
  if (matches.length !== 1) throw new Error("The exact hook owner record could not be read back.");
  return matches[0]!;
}
export function hookCanRedrive(hook: HookRecord | undefined, run: HookRunRecord | undefined) {
  return Boolean(
    hook &&
    run &&
    hook.hookId === run.hookId &&
    hook.workspaceId === run.workspaceId &&
    hook.phase === "after" &&
    hook.mode === "observe" &&
    run.mode === "observe" &&
    run.status === "completed",
  );
}
export function assertHookCreated(
  saved: HookRecord,
  input: Omit<HookCreateInput, "workspaceId">,
  workspaceId: string,
  prior: HookRecord[],
) {
  if (
    !saved.hookId ||
    prior.some((item) => item.hookId === saved.hookId) ||
    saved.workspaceId !== workspaceId ||
    saved.label !== input.label ||
    saved.trigger !== input.trigger ||
    saved.mode !== input.mode ||
    saved.phase !== HOOK_EVENT_REGISTRY[input.trigger].phase ||
    saved.enabled !== true ||
    saved.priority !== input.priority ||
    saved.timeoutMs !== input.timeoutMs ||
    saved.failPolicy !== input.failPolicy ||
    saved.dataScope !== "metadata" ||
    !Number.isFinite(Date.parse(saved.createdAt)) ||
    !Number.isFinite(Date.parse(saved.updatedAt)) ||
    saved.action.type !== "webhook" ||
    !saved.action.webhook.secretRef ||
    saved.action.webhook.secret !== undefined ||
    saved.action.webhook.url !== SECRET_REDACTION_MARKER
  )
    throw new Error("The Gateway did not confirm the reviewed public hook configuration and secret custody reference.");
}
export function assertHookRun(
  saved: HookRunRecord,
  hook: HookRecord,
  prior: HookRunRecord[],
  original?: HookRunRecord,
) {
  if (
    !saved.runId ||
    prior.some((item) => item.runId === saved.runId) ||
    saved.workspaceId !== hook.workspaceId ||
    saved.hookId !== hook.hookId ||
    saved.trigger !== hook.trigger ||
    saved.mode !== hook.mode ||
    !saved.idempotencyKey ||
    !Number.isFinite(Date.parse(saved.createdAt)) ||
    !Number.isFinite(Date.parse(saved.updatedAt)) ||
    !Number.isInteger(saved.attemptCount) ||
    saved.attemptCount < 0 ||
    !["queued", "running", "completed", "blocked", "failed", "timed_out", "dead_lettered", "skipped"].includes(
      saved.status,
    ) ||
    (original
      ? saved.entityType !== original.entityType || saved.entityId !== original.entityId
      : saved.entityType !== "hook_test" || saved.entityId !== hook.hookId)
  )
    throw new Error("The Gateway did not confirm a new delivery for the reviewed hook and event.");
}
