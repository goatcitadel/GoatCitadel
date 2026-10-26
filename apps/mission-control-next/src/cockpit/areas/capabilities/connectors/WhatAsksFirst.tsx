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
 * A server whose tools are listed per chat has nothing to relax, so it shows "Everything asks" and can't be changed.
 */
export function WhatAsksFirst({ item }: { item: CapabilityConnectorItem }) {
  const client = useQueryClient();
  const { activeWorkspaceId: workspaceId } = useUiPreferences();
  const listKey = queryKeys.capabilityConnectors(workspaceId);
  const groupName = useId();
  const [saving, setSaving] = useState(false);
  const [choice, setChoice] = useState<{ value: McpApprovalPosture; since: string | undefined } | undefined>();
  const [failure, setFailure] = useState<Failure | undefined>();
  // State is one render behind a second click in the same tick; this is not.
  const busy = useRef(false);

  const { serverId, serverRevision } = item;
  const perChat = item.requesterScoped === true;
  const locked = perChat || !serverId || !serverRevision;
  const saved: McpApprovalPosture = perChat ? "everything_asks" : (item.approvalPosture ?? "everything_asks");
  // The group shows the choice from the click until the list carries a newer version of the server, so it never flickers
  // back to the old setting between the save and the list catching up.
  const selected = choice && choice.since === serverRevision ? choice.value : saved;

  async function choose(next: McpApprovalPosture) {
    if (busy.current || locked || next === saved) return;
    busy.current = true;
    setSaving(true);
    setChoice({ value: next, since: serverRevision });
    setFailure(undefined);
    try {
      // The server merges the policy, so only the version and the one field are sent.
      const record = await updateMcpServerPolicy(serverId, { expectedRevision: serverRevision, approvalPosture: next });
      // The next save has to start from the version this one made.
      client.setQueryData<CapabilityConnectorsResponse>(listKey, (list) =>
        withRow(list, item.id, (row) => ({
          ...row,
          approvalPosture: next,
          ...(record.revision !== undefined ? { serverRevision: record.revision } : {}),
          ...(record.connectionRevision !== undefined ? { serverConnectionRevision: record.connectionRevision } : {}),
        })),
      );
      void client.invalidateQueries({ queryKey: queryKeys.capabilityConnectorServer(serverId) });
      void client.invalidateQueries({ queryKey: ["settings", "mcp-servers"] });
      void client.invalidateQueries({ queryKey: listKey });
    } catch (error) {
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

  return (
    <div className="space-y-3">
      <fieldset className="space-y-3" disabled={locked} aria-busy={saving || undefined}>
        <legend className="sr-only">What asks first</legend>
        {CHOICES.map((choice) => (
          <ChoiceRow
            key={choice.value}
            choice={choice}
            groupName={groupName}
            checked={selected === choice.value}
            locked={locked}
            dimmed={saving}
            onChoose={() => void choose(choice.value)}
          />
        ))}
      </fieldset>
      <p className="text-sm text-fg-secondary">
        {perChat ? PER_CHAT_LINE : !serverRevision ? NO_BINDING_LINE : BOUNDARY_LINE}
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
  const inputId = useId();
  const detailId = useId();
  return (
    <div className={cn("flex items-start gap-2", (locked || dimmed) && "opacity-70")}>
      <input
        id={inputId}
        type="radio"
        name={groupName}
        value={choice.value}
        checked={checked}
        disabled={locked}
        aria-describedby={detailId}
        className="mt-1 shrink-0"
        onChange={onChoose}
      />
      <div className="min-w-0">
        <label htmlFor={inputId} className="text-md font-medium text-fg sm:text-sm">
          {choice.title}
          {choice.recommended ? " " : null}
          {choice.recommended ? <span className="ml-2 text-xs font-normal text-fg-secondary">Recommended</span> : null}
        </label>
        <p id={detailId} className="text-sm text-fg-secondary">
          {choice.detail}
        </p>
      </div>
    </div>
  );
}
