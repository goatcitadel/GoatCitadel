import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CronJobRecord, FollowThroughSetupInput } from "@goatcitadel/contracts";
import {
  createFollowThroughSetup,
  fetchFollowThroughSetup,
} from "@goatcitadel/mission-control-shared/api/follow-through";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { Button } from "../../ui/Button";
import { ChatFollowThroughSetupForm, type ReviewedFollowThroughSetup } from "./ChatFollowThroughSetup";
export function ChatFollowThroughSetupControl({
  open,
  workspaceId,
  sessionId,
  onClose,
  onCreated,
}: {
  open: boolean;
  workspaceId: string;
  sessionId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const access = useProjectAccess(workspaceId),
    query = useQuery({
      queryKey: ["chat", "follow-through-setup", access.identity, workspaceId, sessionId],
      queryFn: () => fetchFollowThroughSetup(sessionId, workspaceId),
      enabled: open,
      retry: false,
      staleTime: 0,
    });
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string>(),
    [uncertain, setUncertain] = useState(false),
    [created, setCreated] = useState<CronJobRecord>();
  const lock = useRef(false),
    submitted = useRef<FollowThroughSetupInput | undefined>(undefined);
  async function create(input: ReviewedFollowThroughSetup) {
    if (lock.current || created) return;
    lock.current = true;
    setPending(true);
    setError(undefined);
    try {
      const fresh = await fetchFollowThroughSetup(sessionId, workspaceId);
      if (!access.current()) return;
      if (fresh.workspaceId !== workspaceId || fresh.sessionId !== sessionId || fresh.sourceHash !== input.sourceHash)
        throw new Error("Setup or access changed after review. Refresh and review the current details.");
      const request: FollowThroughSetupInput = {
        ...input.draft,
        workspaceId,
        sessionId,
        expectedSetupHash: input.sourceHash,
        operationId: submitted.current?.operationId ?? crypto.randomUUID(),
      };
      if (submitted.current && JSON.stringify(submitted.current) !== JSON.stringify(request))
        throw new Error("Inspect the earlier creation outcome before changing this pending request.");
      submitted.current = request;
      const job = await createFollowThroughSetup(request);
      if (!access.current()) return;
      if (
        job.actionConfig?.agentTurn?.sessionId !== sessionId ||
        job.actionConfig.agentTurn.workspaceId !== workspaceId
      )
        throw new Error("The saved schedule has a different scope. Check the saved schedule before acting.");
      setCreated(job);
      setUncertain(false);
      onCreated();
    } catch (cause) {
      if (access.current()) {
        setError(describeApiError(cause).summary);
        setUncertain(Boolean(submitted.current));
        void query.refetch();
      }
    } finally {
      lock.current = false;
      if (access.current()) setPending(false);
    }
  }
  const status = created
    ? "Follow-through is saved. Each occurrence still checks current permissions, policy and limits."
    : !query.data && query.error
      ? describeApiError(query.error).summary
      : "";
  return (
    <div hidden={!open}>
      <p role="status" className="sr-only">
        {status}
      </p>
      {created ? (
        <div className="grid gap-2 text-sm">
          <p>{status}</p>
          <NativeOwnerLink href={`/work/schedules?jobId=${encodeURIComponent(created.jobId)}`} scope={access.identity}>
            Inspect or pause this follow-through
          </NativeOwnerLink>
          <Button size="sm" onClick={onClose}>
            Close setup
          </Button>
        </div>
      ) : query.data ? (
        <ChatFollowThroughSetupForm
          setup={query.data}
          pending={pending}
          uncertain={uncertain}
          error={error}
          onCreate={create}
          onClose={onClose}
          onRefresh={() => void query.refetch()}
        />
      ) : (
        <div className="grid gap-2 text-sm">
          <p>{status || "Reading schedule setup…"}</p>
          <Button size="sm" onClick={() => void query.refetch()}>
            Refresh setup
          </Button>
          <Button size="sm" onClick={onClose}>
            Close setup
          </Button>
        </div>
      )}
      {uncertain ? (
        <NativeOwnerLink href={`/work/schedules?sessionId=${encodeURIComponent(sessionId)}`} scope={access.identity}>
          Inspect current follow-through
        </NativeOwnerLink>
      ) : null}
    </div>
  );
}
