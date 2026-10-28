import { useId, useState, type ComponentType } from "react";
import { Button } from "../../../../cockpit/ui/Button";
import { Callout } from "../../../../cockpit/ui/Callout";
import { NativeOwnerLink } from "../../../../cockpit/ui/NativeOwnerLink";
import { ensureHostsAllowed, HOSTS_UNKNOWN, inboxApprovalHref, inboxPlanHref, useMissingHosts } from "../channel-hosts";

/** The link to an Inbox page. Cockpit opens it in place; the Classic guide passes one that lands in Cockpit. */
export type InboxLink = ComponentType<{ href: string; scope: string; children: string }>;

type Outcome = Awaited<ReturnType<typeof ensureHostsAllowed>>;
/** What the last click left to say: the click did not allow the hosts, so the operator needs to know why. */
type NotAllowed = Exclude<Outcome, { kind: "allowed" | "completed" }>;
type Answer =
  | { state: "idle" }
  | { state: "working"; for: string }
  | { state: "notAllowed"; for: string; outcome: NotAllowed };

const IDLE: Answer = { state: "idle" };

/**
 * Whether GoatCitadel may reach the hosts a channel needs, on the step that tests it. The list is checked, never
 * changed, by itself. Only a click on Allow these hosts adds a host, and it adds exactly the hosts listed beside it:
 * `ensureHostsAllowed` is given that list both as what to allow and as what the page showed. It adds no live region.
 */
export function ChannelHostsCheck({
  hosts,
  workspaceId,
  inboxLink = NativeOwnerLink,
}: {
  hosts: readonly string[];
  workspaceId: string;
  inboxLink?: InboxLink;
}) {
  if (hosts.length === 0) return null;
  return <HostsCheck hosts={hosts} workspaceId={workspaceId} InboxLink={inboxLink} />;
}

function HostsCheck({
  hosts,
  workspaceId,
  InboxLink,
}: {
  hosts: readonly string[];
  workspaceId: string;
  InboxLink: InboxLink;
}) {
  const check = useMissingHosts(hosts, true);
  const [answer, setAnswer] = useState<Answer>(IDLE);
  const listId = useId();
  if (check.failed) {
    return (
      <Callout tone="warning" announce={false}>
        <p>{HOSTS_UNKNOWN}</p>
        <div className="mt-2">
          <Button size="sm" onClick={check.retry}>
            Try again
          </Button>
        </div>
      </Callout>
    );
  }
  // Until the allowlist has been read the page says nothing it has not seen, and offers nothing to click.
  if (!check.known) return null;
  if (check.missing.length === 0) {
    return <p className="text-sm text-fg-secondary">{`GoatCitadel may reach ${[...new Set(hosts)].join(", ")}.`}</p>;
  }
  const { missing } = check;
  // An answer belongs to the hosts and workspace it was given for; a different list starts clean.
  const current = JSON.stringify([workspaceId, missing]);
  const shown = answer.state === "idle" || answer.for !== current ? IDLE : answer;

  async function allow() {
    setAnswer({ state: "working", for: current });
    const outcome = await ensureHostsAllowed(missing, workspaceId, missing);
    if (outcome.kind === "allowed" || outcome.kind === "completed") {
      setAnswer(IDLE);
      check.retry();
      return;
    }
    setAnswer({ state: "notAllowed", for: current, outcome });
  }

  return (
    <Callout tone="warning" announce={false}>
      <p
        id={listId}
      >{`GoatCitadel can't reach these yet: ${missing.join(", ")}. Real messages fail until they're allowed.`}</p>
      {shown.state === "notAllowed" ? (
        <LastAnswer outcome={shown.outcome} workspaceId={workspaceId} Link={InboxLink} />
      ) : null}
      <div className="mt-2">
        <Button
          size="sm"
          aria-describedby={listId}
          loading={shown.state === "working"}
          loadingLabel="Allowing…"
          onClick={() => void allow()}
        >
          Allow these hosts
        </Button>
      </div>
    </Callout>
  );
}

/** Why the last click did not allow the hosts, or where to go to finish it. */
function LastAnswer({ outcome, workspaceId, Link }: { outcome: NotAllowed; workspaceId: string; Link: InboxLink }) {
  switch (outcome.kind) {
    case "failed":
      return <p className="mt-2">{outcome.message}</p>;
    case "blocked":
      return (
        <div className="mt-2 space-y-1">
          {outcome.reasons.map((reason, index) => (
            <p key={`${index}:${reason}`}>{reason}</p>
          ))}
        </div>
      );
    case "elsewhere":
      return (
        <div className="mt-2">
          {outcome.approvalId ? (
            <Link href={inboxApprovalHref(outcome.approvalId, workspaceId)} scope={workspaceId}>
              Approve it in Inbox
            </Link>
          ) : (
            <Link href={inboxPlanHref(outcome.plan.planId, workspaceId)} scope={workspaceId}>
              Review it in Inbox
            </Link>
          )}
        </div>
      );
  }
}
