import { useId, useState } from "react";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ToolGrantRecord } from "@goatcitadel/contracts";
import { fetchToolGrants, revokeToolGrant } from "@goatcitadel/mission-control-shared/api/approvals";
import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { Button } from "../../ui/Button";
import { TimeText } from "../../ui/TimeText";
import { useMinuteClock } from "../inbox/use-minute-clock";
import { presentApprovalAction } from "./chat-vocabulary";

type ChatScope = { workspaceId: string; sessionId: string };

function useChatAllowances({ workspaceId, sessionId }: ChatScope) {
  const access = useProjectAccess(JSON.stringify([workspaceId, sessionId]));
  const queryKey = ["tools", "chat-allowances", sessionId, access.identity] as const;
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const { items } = await fetchToolGrants({ scope: "session", scopeRef: sessionId, limit: 500 });
      return items.filter(
        (grant) => grant.decision === "allow" && grant.scope === "session" && grant.scopeRef === sessionId,
      );
    },
  });
  return { access, queryKey, query };
}

function isActive(grant: ToolGrantRecord, now: number): boolean {
  if (grant.revokedAt || (grant.grantType === "one_time" && (grant.usesRemaining ?? 0) < 1)) return false;
  return grant.grantType !== "ttl" || Date.parse(grant.expiresAt ?? "") > now;
}

function EndAllowance({
  grant,
  scope,
  onEnded,
}: {
  grant: ToolGrantRecord;
  scope: ReturnType<typeof useChatAllowances>;
  onEnded: (alreadyEnded: boolean) => void;
}) {
  const client = useQueryClient();
  const errorId = useId();
  const mutationKey = [...scope.queryKey, grant.grantId, "end"] as const;
  const busy = useIsMutating({ mutationKey, exact: true }) > 0;
  const end = useMutation({
    mutationKey,
    mutationFn: async () => {
      try {
        const receipt = await revokeToolGrant(grant.grantId);
        if (!receipt.revoked || receipt.grantId !== grant.grantId) {
          throw new Error("GoatCitadel could not confirm that the allowance ended.");
        }
        return false;
      } catch (cause) {
        // A competing End click or a lost response can leave the write
        // rejected here even though the exact grant is already revoked.
        if (scope.access.current()) {
          const current = await scope.query.refetch().catch(() => undefined);
          if (
            current?.isSuccess &&
            current.data?.some(
              (item) => item.grantId === grant.grantId && Number.isFinite(Date.parse(item.revokedAt ?? "")),
            )
          )
            return true;
        }
        throw cause;
      }
    },
    onSuccess: async (alreadyEnded) => {
      // The exact revocation is already committed. Retire any older read
      // before removing the row, even if the server cannot be reached again.
      await client.cancelQueries({ queryKey: scope.queryKey, exact: true });
      client.setQueryData<ToolGrantRecord[]>(scope.queryKey, (items) =>
        items?.filter((item) => item.grantId !== grant.grantId),
      );
      if (scope.access.current()) onEnded(alreadyEnded);
    },
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: scope.queryKey });
    },
  });
  const tool = presentApprovalAction(grant.toolPattern);
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="danger"
        disabled={busy}
        aria-label={`End allowance for ${tool}`}
        aria-describedby={end.isError ? errorId : undefined}
        onClick={() => {
          if (scope.access.current() && isActive(grant, Date.now()) && !client.isMutating({ mutationKey, exact: true }))
            end.mutate();
        }}
      >
        {busy ? "Ending allowance…" : "End allowance"}
      </Button>
      {end.isError ? (
        <p id={errorId} role="alert">
          Could not confirm that the allowance ended. Try again.
        </p>
      ) : null}
    </>
  );
}

/** The receipt remains inline on the turn that created the allowance. */
export function ChatAllowanceReceipt({
  grant,
  message,
  ...chat
}: ChatScope & { grant: ToolGrantRecord; message: string }) {
  const scope = useChatAllowances(chat);
  const [ended, setEnded] = useState(false);
  const recorded = scope.query.data?.find((item) => item.grantId === grant.grantId);
  const now = Math.max(useMinuteClock(grant.expiresAt), Date.now());
  const expired = Date.parse(grant.expiresAt ?? "") <= now;
  const tool = presentApprovalAction(grant.toolPattern);
  const status =
    ended || recorded?.revokedAt
      ? `Allowance ended for ${tool}.`
      : expired
        ? `Allowance expired for ${tool}.`
        : scope.query.isError
          ? "Approved. Could not check the current allowance."
          : scope.query.data && !recorded
            ? "Approved. This allowance is no longer listed for this Chat."
            : message;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-fg-secondary">
      <p role="status">{status}</p>
      {!ended && !expired && scope.query.isError ? (
        <Button type="button" size="sm" onClick={() => void scope.query.refetch()}>
          Try again
        </Button>
      ) : null}
      {!ended && !scope.query.isError && recorded && isActive(recorded, now) ? (
        <EndAllowance grant={recorded} scope={scope} onEnded={() => setEnded(true)} />
      ) : null}
    </div>
  );
}

function ChatAllowanceList(chat: ChatScope) {
  const scope = useChatAllowances(chat);
  const [notice, setNotice] = useState("");
  const nextExpiry = scope.query.data?.reduce<string | undefined>((next, grant) => {
    if (!grant.expiresAt || !isActive(grant, Date.now())) return next;
    return !next || Date.parse(grant.expiresAt) < Date.parse(next) ? grant.expiresAt : next;
  }, undefined);
  const now = Math.max(useMinuteClock(nextExpiry), Date.now());
  if (scope.query.isError)
    return (
      <div className="mt-2">
        {notice ? <p role="status">{notice}</p> : null}
        <p role="alert">Could not load this Chat’s allowances.</p>
        <Button size="sm" onClick={() => void scope.query.refetch()}>
          Try again
        </Button>
      </div>
    );
  if (!scope.query.data)
    return (
      <p role="status" className="mt-2">
        Loading allowances…
      </p>
    );
  const active = scope.query.data.filter((grant) => isActive(grant, now));
  return (
    <>
      {notice ? (
        <p role="status" className="mt-2">
          {notice}
        </p>
      ) : null}
      {active.length ? (
        <ul aria-label="Active Chat allowances" className="mt-2 space-y-2">
          {active.map((grant) => {
            const tool = presentApprovalAction(grant.toolPattern);
            const targets = [
              ...(grant.constraints?.allowedHosts ?? []),
              ...(grant.constraints?.allowedPaths ?? []),
              ...(grant.constraints?.writeRoots ?? []),
              ...(grant.constraints?.referenceRoots?.map((root) => root.label) ?? []),
            ];
            return (
              <li key={grant.grantId} className="space-y-1 rounded-md border border-line-subtle p-2">
                <p className="font-medium">{tool}</p>
                {targets.length ? <p className="break-words text-fg-muted">{targets.join(", ")}</p> : null}
                <p className="text-fg-muted">
                  {grant.expiresAt ? (
                    <TimeText value={grant.expiresAt} prefix="Expires" absolute />
                  ) : grant.grantType === "one_time" ? (
                    "One use remaining"
                  ) : (
                    "Until ended"
                  )}
                </p>
                <EndAllowance
                  grant={grant}
                  scope={scope}
                  onEnded={(alreadyEnded) =>
                    setNotice(alreadyEnded ? `Allowance for ${tool} already ended.` : `Allowance ended for ${tool}.`)
                  }
                />
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-2 text-fg-muted">No active allowances for this Chat.</p>
      )}
    </>
  );
}

export function ChatAllowances(chat: ChatScope) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer font-medium">Allowances</summary>
      {open ? <ChatAllowanceList {...chat} /> : null}
    </details>
  );
}
