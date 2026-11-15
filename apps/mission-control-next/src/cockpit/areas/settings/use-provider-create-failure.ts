import { useRef, useState } from "react";
import {
  classifySettingsSaveFailure,
  findWaitingSettingsChange,
  waitingNoticeFor,
  type WaitingSettingsNotice,
  type SettingsSaveFailure,
} from "../../../features/native-routes/settings/settings-save-outcome";

/**
 * What the Gateway said to a provider change request itself, apart from any read that follows it: an earlier change
 * still waiting for approval (found again), a plain refusal (nothing was created), or an answer that cannot be told
 * (the caller keeps its uncertain lock). A read that fails after the request says nothing about the request.
 */
export function useProviderCreateFailure(reload: () => Promise<unknown>) {
  const [waiting, setWaiting] = useState<WaitingSettingsNotice | null>(null);
  const failure = useRef<SettingsSaveFailure | undefined>(undefined);
  return {
    waiting,
    clearWaiting: () => {
      setWaiting(null);
      void reload();
    },
    /** Starts a new request: the last one's notice and failure are gone. */
    begin() {
      failure.current = undefined;
      setWaiting(null);
    },
    /** Records the failure of the request's own dispatch, then lets it propagate. */
    record(cause: unknown): never {
      failure.current = classifySettingsSaveFailure(cause);
      throw cause;
    },
    /**
     * Settles a failed request that was recorded. A refusal reports its reason through `report` and a waiting change
     * is shown by `waiting`; both return true (nothing was created). Anything else returns false, so the caller keeps
     * its lock for a lost answer.
     */
    async settle(stillCurrent: () => boolean, report: (error: string) => void): Promise<boolean> {
      const seen = failure.current;
      if (seen?.kind === "refused") {
        report(`Not saved. ${seen.reason}`);
        return true;
      }
      if (seen?.kind !== "waiting") return false;
      const lookup = await findWaitingSettingsChange(seen.planId);
      // A change that finished meanwhile leaves nothing to show: the reloaded provider speaks for itself.
      if (lookup.kind === "finished") void reload();
      else if (lookup.kind === "foreign")
        report("Provider settings changed. Review the latest version before creating a change.");
      else if (stillCurrent()) setWaiting(waitingNoticeFor(lookup, seen.planId));
      return true;
    },
  };
}
