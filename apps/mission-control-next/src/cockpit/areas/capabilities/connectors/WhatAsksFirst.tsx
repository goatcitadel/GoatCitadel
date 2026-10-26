import { useId, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { CapabilityConnectorItem, CapabilityConnectorsResponse, McpApprovalPosture } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { updateMcpServerPolicy } from "@goatcitadel/mission-control-shared/api/mcp-operations";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { queryKeys } from "../../../data/query-keys";
import { Button } from "../../../ui/Button";
import { cn } from "../../../lib/cn";
import { CONNECTOR_CONFLICT_MESSAGE, withRow } from "./use-connector-enabled";

interface Choice {
  value: McpApprovalPosture;
  title: string;
  detail: string;
  recommended?: true;
}

const CHOICES: readonly Choice[] = [
  { value: "everything_asks", title: "Everything asks", detail: "Every action asks you first." },
  {
    value: "reads_free",
    title: "Reading is free",
    detail: "Reads run on their own. Anything that creates or changes something asks you first.",
    recommended: true,
  },
  {
    value: "nothing_asks",
    title: "Nothing asks",
    detail: "Changes run on their own. Anything the app marks as destructive, or doesn't label, still asks you first.",
  },
];

const BOUNDARY_LINE =
  "This goes by how the app labels its own tools. Deny rules, wards and quarantine still apply, and it applies whichever approval profile Chat uses.";
const PER_CHAT_LINE = "This connector's tools are listed per chat, so every action asks you first.";
const NO_BINDING_LINE = "This server's saved version isn't available, so it can't be changed here.";

interface Failure {
  message: string;
  conflict: boolean;
}

/**
 * Which of a saved server's tool calls ask the operator first. Choosing saves at once against the version the list
 * carried: the choice shows while it saves, goes back if the save fails, and a conflict says so and offers a reload. The
 * tool labels in the panel follow the saved setting (`item.approvalPosture`), never the choice still in flight.
 * A choice made while a save is running is remembered and saved when that one settles, so moving through the group with
 * the arrow keys ends on the last choice.
 * A server whose tools are listed per chat has nothing to relax, so it shows "Everything asks" and can't be changed.
 */
export function WhatAsksFirst({ item }: { item: CapabilityConnectorItem }) {
  const client = useQueryClient();
  const { activeWorkspaceId: workspaceId } = useUiPreferences();
  const listKey = queryKeys.capabilityConnectors(workspaceId);
  const groupName = useId();
  const noteId = useId();
  const [saving, setSaving] = useState(false);
  const [choice, setChoice] = useState<{ value: McpApprovalPosture; since: string | undefined } | undefined>();
  const [failure, setFailure] = useState<Failure | undefined>();
  // State is one render behind a second click in the same tick; this is not.
  const busy = useRef(false);
  // The last choice made while a save was running.
  const queued = useRef<McpApprovalPosture | undefined>(undefined);

  const { serverId, serverRevision } = item;
  const perChat = item.requesterScoped === true;
  const locked = perChat || !serverId || !serverRevision;
  const saved: McpApprovalPosture = perChat ? "everything_asks" : (item.approvalPosture ?? "everything_asks");
  // The group shows the choice while it saves, and after that until the list carries a newer version of the server, so it
  // never flickers back to the old setting between the save and the list catching up.
  const selected = choice && (saving || choice.since === serverRevision) ? choice.value : saved;

  async function choose(next: McpApprovalPosture) {
    if (locked) return;
    if (busy.current) {
      queued.current = next;
      setChoice((current) => (current ? { ...current, value: next } : current));
      return;
    }
    if (next === saved) return;
    busy.current = true;
    setSaving(true);
    setChoice({ value: next, since: serverRevision });
    setFailure(undefined);
    try {
      let revision: string = serverRevision;
      let current: McpApprovalPosture = saved;
      let target: McpApprovalPosture | undefined = next;
      while (target !== undefined && target !== current) {
        const applied: McpApprovalPosture = target;
        // The server merges the policy, so only the version and the one field are sent.
        const record = await updateMcpServerPolicy(serverId, { expectedRevision: revision, approvalPosture: applied });
        current = applied;
        revision = record.revision ?? revision;
        // The next save has to start from the version this one made.
        client.setQueryData<CapabilityConnectorsResponse>(listKey, (list) =>
          withRow(list, item.id, (row) => ({
            ...row,
            approvalPosture: applied,
            ...(record.revision !== undefined ? { serverRevision: record.revision } : {}),
            ...(record.connectionRevision !== undefined ? { serverConnectionRevision: record.connectionRevision } : {}),
          })),
        );
        void client.invalidateQueries({ queryKey: queryKeys.capabilityConnectorServer(serverId) });
        void client.invalidateQueries({ queryKey: ["settings", "mcp-servers"] });
        target = queued.current;
        queued.current = undefined;
      }
      void client.invalidateQueries({ queryKey: listKey });
    } catch (error) {
      queued.current = undefined;
      setChoice(undefined);
      const described = describeApiError(error);
      const conflict = described.category === "conflict";
      setFailure({ message: conflict ? CONNECTOR_CONFLICT_MESSAGE : described.summary, conflict });
      // A request that reported a failure can still have been committed (a lost reply, a timeout), so the list is read
      // again and shows whatever the Gateway really holds.
      void client.invalidateQueries({ queryKey: listKey });
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  const note = perChat ? PER_CHAT_LINE : !serverRevision ? NO_BINDING_LINE : BOUNDARY_LINE;
  return (
    <div className="space-y-3">
      <fieldset
        className="space-y-3"
        disabled={locked}
        aria-busy={saving || undefined}
        aria-describedby={locked ? noteId : undefined}
      >
        <legend className="sr-only">What asks first</legend>
        {CHOICES.map((entry) => (
          <ChoiceRow
            key={entry.value}
            choice={entry}
            groupName={groupName}
            checked={selected === entry.value}
            locked={locked}
            dimmed={saving}
            onChoose={() => void choose(entry.value)}
          />
        ))}
      </fieldset>
      <p id={noteId} className="text-sm text-fg-secondary">
        {note}
      </p>
      {failure ? (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-status-failed">
            {failure.message}
          </p>
          {failure.conflict ? (
            <Button
              size="sm"
              onClick={() => {
                setFailure(undefined);
                void client.invalidateQueries({ queryKey: listKey });
              }}
            >
              Reload
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** One choice. The whole row, title and detail, is the radio's label, so its name says what the choice does. */
function ChoiceRow({
  choice,
  groupName,
  checked,
  locked,
  dimmed,
  onChoose,
}: {
  choice: Choice;
  groupName: string;
  checked: boolean;
  locked: boolean;
  dimmed: boolean;
  onChoose: () => void;
}) {
  return (
    <label className={cn("flex items-start gap-2 text-sm text-fg", (locked || dimmed) && "opacity-70")}>
      <input
        type="radio"
        name={groupName}
        value={choice.value}
        checked={checked}
        disabled={locked}
        className="mt-1 shrink-0"
        onChange={onChoose}
      />
      <span className="min-w-0">
        <span className="text-md font-medium sm:text-sm">
          {choice.title}
          {choice.recommended ? " " : null}
          {choice.recommended ? <span className="ml-2 text-xs font-normal text-fg-secondary">Recommended</span> : null}
        </span>
        <span className="block text-sm text-fg-secondary">{choice.detail}</span>
      </span>
    </label>
  );
}
