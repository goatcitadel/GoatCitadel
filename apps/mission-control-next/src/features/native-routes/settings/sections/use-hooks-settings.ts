import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import type { HookRecord, HookRunRecord } from "@goatcitadel/contracts";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useSessionDraft } from "../../library/session-drafts";
import { useDraftLeave } from "../../library/DraftLeaveDialog";
import { useFormDirty } from "../../library/use-form-dirty";
import { getErrorMessage, nativeLoad, nativeLoadIssues, useAsyncLoad, type Notice } from "../SettingsShared";
import { beginIntegrationMutation, useIntegrationConnectionMutation } from "../integration-connection-mutation";
import {
  createWorkspaceHook,
  deleteWorkspaceHook,
  fetchWorkspaceHookRuns,
  fetchWorkspaceHooks,
  redriveWorkspaceHookRun,
  testWorkspaceHook,
} from "./hooks-api";
import {
  assertHookCreated,
  assertHookRun,
  EMPTY_HOOK_FORM,
  exactHookRecord,
  hookCanRedrive,
  hookCreateInput,
  HOOK_OWNER_BOUNDARY,
  HOOK_OWNER_LIMIT,
  hooksEqual,
  scopedHookRecords,
  type HookForm,
  type HookPrivateForm,
  type HookReview,
} from "./hooks-owner-binding";

type View = "new" | "hook" | "history" | null;
export function useHooksSettings(workspaceId: string) {
  const base = getGatewayApiBaseUrl(),
    scope = JSON.stringify([base, workspaceId]),
    key = `hooks:${scope}`;
  const mutation = useIntegrationConnectionMutation(key);
  const [view, setView] = useState<View>(null),
    [selectedHookId, setSelectedHookId] = useState("");
  const [selectedRunId, setSelectedRunId] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const editor = useSessionDraft(`${key}:new`, EMPTY_HOOK_FORM, undefined, {
    label: "New hook",
    active: view === "new",
  });
  // URL paths can themselves carry credentials. Neither field enters retained drafts or browser storage.
  const [privateFields, setPrivateFields] = useState<HookPrivateForm & { scope: string }>({
    scope,
    url: "",
    secret: "",
  });
  const privateValue = privateFields.scope === scope ? privateFields : { url: "", secret: "" };
  const form: HookForm = { ...editor.value, url: privateValue.url, secret: privateValue.secret };
  const [review, setReview] = useState<HookReview | null>(null),
    reviewRef = useRef<HookReview | null>(null);
  useEffect(() => {
    setPrivateFields((value) => (value.scope === scope ? value : { scope, url: "", secret: "" }));
    reviewRef.current = null;
    setReview(null);
    setNotice(null);
  }, [scope]);
  const generation = useRef({ identity: "", mounted: true });
  const identity = JSON.stringify([scope, view, selectedHookId, selectedRunId, form]);
  if (generation.current.identity !== identity) generation.current = { identity, mounted: true };
  const captured = generation.current;
  useEffect(() => {
    generation.current.mounted = true;
    return () => {
      generation.current.mounted = false;
    };
  }, []);
  const current = () => generation.current === captured && captured.mounted && getGatewayApiBaseUrl() === base;
  const invalidate = () => {
    generation.current = { identity: "changed", mounted: true };
    reviewRef.current = null;
    setReview(null);
  };
  const setForm = (next: SetStateAction<HookForm>) => {
    const value = typeof next === "function" ? next(form) : next;
    invalidate();
    editor.setValue({ label: value.label, trigger: value.trigger, mode: value.mode });
    setPrivateFields({ scope, url: value.url, secret: value.secret });
  };
  const ephemeralKey = `${key}:private`;
  useFormDirty(ephemeralKey, view === "new" && Boolean(privateValue.url || privateValue.secret), {
    label: "Hook endpoint and signing secret",
    keepDraft: false,
    onDiscard: () => {
      invalidate();
      setPrivateFields({ scope, url: "", secret: "" });
    },
  });
  const leave = useDraftLeave();
  const changeView = (next: View, hookId = selectedHookId, runId = "") =>
    leave.request(() => {
      invalidate();
      setView(next);
      setSelectedHookId(hookId);
      setSelectedRunId(runId);
      setNotice(null);
    }, [editor.key, ephemeralKey]);
  const load = useCallback(async () => {
    if (!workspaceId.trim()) throw new Error("Select a workspace to inspect hooks.");
    const [hooks, runs] = await Promise.all([
      nativeLoad(
        "Hooks",
        fetchWorkspaceHooks(workspaceId, HOOK_OWNER_LIMIT).then((value) => scopedHookRecords(value.items, workspaceId)),
        [],
      ),
      nativeLoad(
        "Hook deliveries",
        fetchWorkspaceHookRuns(workspaceId, HOOK_OWNER_LIMIT).then((value) =>
          scopedHookRecords(value.items, workspaceId),
        ),
        [],
      ),
    ]);
    return {
      scope: JSON.stringify([base, workspaceId]),
      hooks: hooks.data,
      runs: runs.data,
      issues: nativeLoadIssues([hooks, runs]),
    };
  }, [base, workspaceId]);
  const loaded = useAsyncLoad(load, [load]);
  const data = loaded.data?.scope === scope ? loaded.data : null;
  const hooks = data?.hooks ?? [],
    runs = data?.runs ?? [];
  const selectedHook = hooks.find((item) => item.hookId === selectedHookId);
  const selectedRuns = runs.filter((item) => view === "history" || item.hookId === selectedHook?.hookId);
  const selectedRun = selectedRuns.find((item) => item.runId === selectedRunId);
  const cancelReview = () => {
    reviewRef.current = null;
    setReview(null);
  };
  function showReview(
    value:
      | Omit<Extract<HookReview, { kind: "create" }>, "current">
      | Omit<Extract<HookReview, { kind: "test" | "delete" }>, "current">
      | Omit<Extract<HookReview, { kind: "redrive" }>, "current">,
  ) {
    if (!current() || mutation.locked) return;
    const next: HookReview = { ...value, current: () => current() && reviewRef.current === next };
    reviewRef.current = next;
    setReview(next);
    setNotice(null);
  }
  function reviewCreate() {
    try {
      const input = hookCreateInput(form);
      showReview({
        kind: "create",
        form: { ...form },
        input,
        title: "Register this hook?",
        description: `Register enabled ${form.mode} hook ${input.label} for ${input.trigger} in workspace ${workspaceId}. Endpoint: ${form.url.trim()}. A new signing secret will be stored by the Gateway. Future matching events may send metadata to this endpoint. ${HOOK_OWNER_BOUNDARY}`,
      });
    } catch (error) {
      if (current()) setNotice({ tone: "warning", message: getErrorMessage(error) });
    }
  }
  function reviewHook(kind: "test" | "delete", hook: HookRecord) {
    if (
      hook.workspaceId !== workspaceId ||
      !hooksEqual(
        hooks.find((item) => item.hookId === hook.hookId),
        hook,
      )
    )
      return;
    if (kind === "test" && !hook.enabled) return;
    showReview({
      kind,
      hook: structuredClone(hook),
      title: kind === "test" ? "Send a real hook test?" : "Delete hook?",
      description: `${hook.label} · ${hook.hookId} · workspace ${workspaceId}. ${kind === "test" ? "This sends a synthetic metadata-only event through the real configured delivery path and can affect the destination." : "Delete the registration. Retained delivery evidence remains; best-effort secret cleanup is not proof of credential destruction."} ${HOOK_OWNER_BOUNDARY}`,
    });
  }
  function reviewRedrive(run: HookRunRecord) {
    const hook = hooks.find((item) => item.hookId === run.hookId);
    if (
      !hook ||
      !hookCanRedrive(hook, run) ||
      !hooksEqual(
        runs.find((item) => item.runId === run.runId),
        run,
      )
    )
      return;
    showReview({
      kind: "redrive",
      hook: structuredClone(hook),
      run: structuredClone(run),
      title: "Redrive this hook delivery?",
      description: `Queue another real delivery for ${hook.label} · event ${run.entityType}/${run.entityId} · original ${run.runId} in workspace ${workspaceId}. Only completed post-event observers can be replayed. ${HOOK_OWNER_BOUNDARY}`,
    });
  }
  async function confirmReview() {
    const reviewed = reviewRef.current;
    if (!reviewed?.current()) return false;
    const operation = beginIntegrationMutation(key);
    if (!operation) return false;
    const requireInstallation = () => {
      if (getGatewayApiBaseUrl() !== base) throw new Error("Gateway installation changed before hook readback.");
    };
    const readHooks = async () => {
      requireInstallation();
      const value = await fetchWorkspaceHooks(workspaceId, HOOK_OWNER_LIMIT);
      requireInstallation();
      return scopedHookRecords(value.items, workspaceId);
    };
    const readRuns = async () => {
      requireInstallation();
      const value = await fetchWorkspaceHookRuns(workspaceId, HOOK_OWNER_LIMIT);
      requireInstallation();
      return scopedHookRecords(value.items, workspaceId);
    };
    try {
      const priorHooks = await readHooks();
      if (!reviewed.current()) return false;
      let message: string;
      let acknowledge: (() => void) | undefined;
      if (reviewed.kind === "create") {
        const receipt = await operation.write(
          () => createWorkspaceHook(workspaceId, reviewed.input),
          async (saved) => {
            assertHookCreated(saved, reviewed.input, workspaceId, priorHooks);
            if (!hooksEqual(exactHookRecord(await readHooks(), saved.hookId, "hookId"), saved))
              throw new Error("Saved hook readback differs from its public receipt.");
          },
        );
        const submitted = { label: reviewed.form.label, trigger: reviewed.form.trigger, mode: reviewed.form.mode };
        acknowledge = () => {
          editor.acceptSaved(EMPTY_HOOK_FORM, undefined, submitted);
          setPrivateFields((value) =>
            value.scope === scope && value.url === reviewed.form.url && value.secret === reviewed.form.secret
              ? { scope, url: "", secret: "" }
              : value,
          );
        };
        message = `Hook ${receipt.label} registered. Public configuration and keychain custody reference confirmed; private endpoint and secret values are hidden.`;
      } else {
        const fresh = exactHookRecord(priorHooks, reviewed.hook.hookId, "hookId");
        if (!hooksEqual(fresh, reviewed.hook))
          throw new Error("The hook changed. Refresh and review its current public record.");
        if (reviewed.kind === "delete") {
          if (priorHooks.length >= HOOK_OWNER_LIMIT)
            throw new Error(
              "The hook list may be truncated. Deletion cannot be verified through this bounded owner read.",
            );
          await operation.write(
            () => deleteWorkspaceHook(workspaceId, fresh.hookId),
            async (saved) => {
              if (saved.deleted !== true) throw new Error("The Gateway did not confirm deletion.");
              const remaining = await readHooks();
              if (remaining.length >= HOOK_OWNER_LIMIT || remaining.some((item) => item.hookId === fresh.hookId))
                throw new Error("Hook deletion could not be independently verified.");
            },
          );
          message = "Hook registration deleted. Retained delivery evidence remains; secret cleanup is unverified.";
        } else {
          const priorRuns = await readRuns();
          if (!reviewed.current()) return false;
          if (
            reviewed.kind === "redrive" &&
            (!hooksEqual(exactHookRecord(priorRuns, reviewed.run.runId, "runId"), reviewed.run) ||
              !hookCanRedrive(fresh, reviewed.run))
          )
            throw new Error("The reviewed delivery changed or cannot be redriven.");
          const receipt = await operation.write(
            () =>
              reviewed.kind === "redrive"
                ? redriveWorkspaceHookRun(workspaceId, reviewed.run.runId)
                : testWorkspaceHook(workspaceId, fresh.hookId),
            async (saved) => {
              assertHookRun(saved, fresh, priorRuns, reviewed.kind === "redrive" ? reviewed.run : undefined);
              if (!hooksEqual(exactHookRecord(await readRuns(), saved.runId, "runId"), saved))
                throw new Error("The recorded delivery could not be independently verified.");
            },
          );
          message = `Hook delivery ${receipt.runId}: ${receipt.status}, attempt ${receipt.attemptCount}, confirmed by the Gateway. A queued record does not prove delivery.`;
        }
      }
      const visible = reviewed.current();
      if (visible) {
        cancelReview();
        setNotice({ tone: "success", message });
      }
      acknowledge?.();
      if (visible) {
        try {
          await loaded.reload();
        } catch {
          /* Preserve the confirmed receipt; the loader exposes read failure. */
        }
      }
      return true;
    } catch (error) {
      if (reviewed.current()) {
        cancelReview();
        setNotice({ tone: "error", message: getErrorMessage(error) });
      }
      return false;
    } finally {
      operation.finish();
    }
  }
  return {
    ...loaded,
    data,
    notice,
    hooks,
    runs,
    selectedHook,
    selectedRun,
    selectedRuns,
    selectedRunId,
    setSelectedRunId: (id: string) => {
      invalidate();
      setSelectedRunId(id);
    },
    selectedRunCanRedrive: hookCanRedrive(selectedHook, selectedRun),
    view,
    openView: (next: View) => changeView(next),
    selectHook: (id: string) => changeView("hook", id),
    form,
    setForm,
    editor,
    leave,
    mutation,
    review: review?.current() ? review : null,
    reviewCreate,
    reviewHook,
    reviewRedrive,
    confirmReview,
    cancelReview,
    uncertainty:
      mutation.phase === "uncertain"
        ? "The hook action outcome is uncertain. Further hook writes in this workspace are locked for this app session, including detailed Settings. Inspect Gateway records before continuing."
        : undefined,
  };
}
export type HooksSettingsOwner = ReturnType<typeof useHooksSettings>;
