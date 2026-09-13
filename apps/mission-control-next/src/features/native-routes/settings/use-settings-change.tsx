import { useEffect, useRef, useSyncExternalStore } from "react";
import type {
  ChangePlanRecord,
  ChangePlanStatus,
} from "@goatcitadel/contracts";
import {
  fetchChangePlan,
  fetchSettings,
  type RuntimeSettingsResponse,
} from "@goatcitadel/mission-control-shared/api/client";
import type { AppRoute } from "../../../app/route-model";
import { NativeButton } from "../primitives";

type Receipt = NonNullable<RuntimeSettingsResponse["changePlanReceipt"]>;
type PendingChange = {
  receipt: Receipt;
  submitted: unknown;
  baseRevision: number;
  blocking: boolean;
  message: string;
  error?: string;
  plan?: ChangePlanRecord;
};
// Settings compatibility saves create plans in the Gateway's installation workspace.
// Retain their identities for this app session; never persist credentials or draft input.
const changes = new Map<string, PendingChange>();
const listeners = new Set<() => void>();
const activeReads = new Set<string>();
const savesInFlight = new Set<string>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function publish(key: string, change: PendingChange) {
  changes.set(key, change);
  for (const listener of listeners) listener();
}
const completed = (status: ChangePlanStatus) =>
  status === "completed" || status === "applied";
const stopped = (status: ChangePlanStatus) =>
  ["failed", "cancelled", "rolled_back"].includes(status);
const statuses = new Set([
  "draft",
  "awaiting_input",
  "awaiting_confirmation",
  "staging",
  "awaiting_approval",
  "applying",
  "verifying",
  "monitoring",
  "completed",
  "applied",
  "manual_required",
  "failed",
  "cancelled",
  "rolling_back",
  "rolled_back",
  "rollback_failed",
]);

type SettingsAcknowledgement = {
  revision: number;
  changePlanReceipt?: Receipt;
};
export function useSettingsChange<
  T,
  R extends SettingsAcknowledgement = RuntimeSettingsResponse,
>(options: {
  key: string;
  operation?: string;
  matchesPlan?: (plan: ChangePlanRecord, submitted: T) => boolean;
  read?: (submitted: T) => Promise<R>;
  matches: (settings: R, submitted: T) => boolean;
  savedValue?: (submitted: T) => T;
  acceptSaved: (value: T, revision: number, submitted: T) => boolean;
  reload: () => Promise<unknown>;
}) {
  const change = useSyncExternalStore(
    subscribe,
    () => changes.get(options.key),
    () => undefined,
  );
  const saving = useSyncExternalStore(
    subscribe,
    () => savesInFlight.has(options.key),
    () => false,
  );
  const acknowledge = (
    owner: typeof options,
    settings: R,
    submitted: T,
    baseRevision: number,
  ) => {
    if (
      !Number.isSafeInteger(settings?.revision) ||
      settings.revision <= baseRevision ||
      !owner.matches(settings, submitted)
    ) {
      throw new Error(
        "The returned settings do not confirm this draft. Your input is preserved; refresh the change status before retrying.",
      );
    }
    return owner.acceptSaved(
      owner.savedValue?.(submitted) ?? submitted,
      settings.revision,
      submitted,
    );
  };
  const receive = (
    settings: R,
    submitted: T,
    baseRevision: number,
  ): boolean => {
    const receipt = settings?.changePlanReceipt;
    if (!receipt)
      return acknowledge(options, settings, submitted, baseRevision);
    if (
      !receipt.planId?.trim() ||
      !statuses.has(receipt.status) ||
      !Number.isSafeInteger(receipt.revision) ||
      receipt.revision < 1
    ) {
      throw new Error(
        "The save returned an incomplete change receipt. Your draft is preserved; inspect Settings activity before retrying.",
      );
    }
    const entry: PendingChange = {
      receipt,
      submitted,
      baseRevision,
      blocking: true,
      message:
        receipt.summary ||
        "Change submitted. Waiting for canonical settlement.",
    };
    publish(options.key, entry);
    if (completed(receipt.status)) {
      const clean = acknowledge(options, settings, submitted, baseRevision);
      publish(options.key, {
        ...entry,
        blocking: false,
        message: clean
          ? "Change saved and confirmed."
          : "Submitted change saved. Your newer input remains unsaved.",
      });
      return clean;
    }
    return false;
  };
  const refresh = async (): Promise<boolean> => {
    const owner = options;
    const key = owner.key;
    const pending = changes.get(key);
    if (!pending || activeReads.has(key)) return false;
    activeReads.add(key);
    try {
      const plan = await fetchChangePlan(pending.receipt.planId, {
        workspaceId: "default",
      });
      if (changes.get(key) !== pending) return false;
      if (
        plan.planId !== pending.receipt.planId ||
        plan.origin.workspaceId !== "default" ||
        plan.origin.surface !== "settings" ||
        plan.kind !== plan.request.kind ||
        !(owner.matchesPlan
          ? owner.matchesPlan(plan, pending.submitted as T)
          : plan.kind === "runtime_configuration" &&
            plan.request.kind === "runtime_configuration" &&
            plan.request.change.operation === owner.operation &&
            plan.target.ownerId === "runtime_settings") ||
        plan.target.expectedRevision !== pending.baseRevision ||
        !statuses.has(plan.status) ||
        !Number.isSafeInteger(plan.revision) ||
        plan.revision < pending.receipt.revision
      ) {
        throw new Error(
          "Change evidence does not match this Settings save. Your draft is preserved.",
        );
      }
      const next: PendingChange = {
        ...pending,
        receipt: {
          ...pending.receipt,
          ...plan,
          summary: completed(plan.status)
            ? (plan.result?.summary ?? plan.summary)
            : plan.summary,
        },
        plan,
        error: undefined,
        message: completed(plan.status)
          ? (plan.result?.summary ?? plan.summary)
          : plan.summary,
      };
      if (completed(plan.status)) {
        const settings = owner.read
          ? await owner.read(pending.submitted as T)
          : ((await fetchSettings()) as unknown as R);
        if (changes.get(key) !== pending) return false;
        const clean = acknowledge(
          owner,
          settings,
          pending.submitted as T,
          pending.baseRevision,
        );
        publish(key, {
          ...next,
          blocking: false,
          message: clean
            ? "Change saved and confirmed."
            : "Submitted change saved. Your newer input remains unsaved.",
        });
        await owner.reload();
        return clean;
      }
      publish(key, {
        ...next,
        blocking: !stopped(plan.status),
        message: stopped(plan.status)
          ? "Change " +
            plan.status.replaceAll("_", " ") +
            ". Your draft is preserved. Refresh the current settings before trying again."
          : next.message,
      });
      if (stopped(plan.status)) await owner.reload();
      return false;
    } catch (error) {
      if (changes.get(key) === pending)
        publish(key, {
          ...pending,
          error:
            error instanceof Error
              ? error.message
              : "Change status unavailable. Your draft is preserved.",
        });
      return false;
    } finally {
      activeReads.delete(key);
    }
  };
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!change?.blocking) return;
    void refreshRef.current();
    const timer = globalThis.setInterval(
      () => void refreshRef.current(),
      15_000,
    );
    return () => globalThis.clearInterval(timer);
  }, [options.key, change?.receipt.planId, change?.blocking]);
  return {
    change,
    receive,
    refresh,
    hasPending: saving || Boolean(change?.blocking),
    isPending: () =>
      savesInFlight.has(options.key) ||
      Boolean(changes.get(options.key)?.blocking),
    beginSave: () => {
      if (savesInFlight.has(options.key) || changes.get(options.key)?.blocking)
        return false;
      savesInFlight.add(options.key);
      for (const listener of listeners) listener();
      return true;
    },
    endSave: () => {
      savesInFlight.delete(options.key);
      for (const listener of listeners) listener();
    },
  };
}

export function SettingsChangeStatus({
  change,
  onRefresh,
  navigate,
  route,
  onReview,
}: {
  change: PendingChange | undefined;
  onRefresh: () => Promise<boolean>;
  navigate: (route: AppRoute) => void;
  route: AppRoute;
  onReview?: (plan: ChangePlanRecord) => void;
}) {
  if (!change) return null;
  const action = change.receipt.requiredAction;
  const approvalId =
    action?.kind === "approval" ? action.approvalId : undefined;
  return (
    <section
      aria-label="Settings change status"
      className="mc-next-settings-notice"
    >
      <p role="status">
        <strong>{change.receipt.status.replaceAll("_", " ")}</strong> ·{" "}
        {change.message}
      </p>
      {change.blocking ? (
        <p>
          Save is paused until this change settles. You can keep editing your
          draft.
        </p>
      ) : null}
      {change.error ? <p role="alert">{change.error}</p> : null}
      <div className="mc-next-settings-button-row">
        <NativeButton variant="outline" onClick={() => void onRefresh()}>
          Refresh change status
        </NativeButton>
        {change.blocking &&
        change.plan?.requiredAction &&
        !approvalId &&
        onReview ? (
          <NativeButton onClick={() => onReview(change.plan!)}>
            Continue setup
          </NativeButton>
        ) : null}
        {approvalId ? (
          <NativeButton
            variant="default"
            onClick={() =>
              navigate({
                area: "ops",
                section: "approvals",
                approvalId,
                theme: route.theme,
              })
            }
          >
            Review approval
          </NativeButton>
        ) : null}
      </div>
      <details>
        <summary>Change details</summary>
        <dl>
          <dt>Plan</dt>
          <dd>{change.receipt.planId}</dd>
          <dt>Status</dt>
          <dd>{change.receipt.status.replaceAll("_", " ")}</dd>
          <dt>Revision</dt>
          <dd>{change.receipt.revision}</dd>
          <dt>Required action</dt>
          <dd>{action?.title ?? "No action reported"}</dd>
          <dt>Evidence</dt>
          <dd>{change.plan?.evidenceRefs?.join(", ") || "Not loaded"}</dd>
          <dt>Rollback evidence</dt>
          <dd>{change.plan?.rollbackRefs?.join(", ") || "None reported"}</dd>
        </dl>
      </details>
    </section>
  );
}

export function __resetSettingsChangesForTests() {
  changes.clear();
  activeReads.clear();
  savesInFlight.clear();
  for (const listener of listeners) listener();
}
