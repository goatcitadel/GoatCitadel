import type { CapabilityConnectorItem } from "@goatcitadel/contracts";
import { Button } from "../../../ui/Button";
import { StatusBadge } from "../../../ui/StatusBadge";
import { LetterIcon } from "../LetterIcon";
import { connectorAction, connectorKindLabel, presentConnectorState } from "./connector-view";

/**
 * One connector as a row card: its letter icon, name and kind, a one-line description, its state with the reason, and
 * the one thing to do next. The button opens the row's panel through `onOpen`; the row itself is not a click target.
 */
export function ConnectorRow({
  item,
  onOpen,
}: {
  item: CapabilityConnectorItem;
  onOpen: (item: CapabilityConnectorItem) => void;
}) {
  const state = presentConnectorState(item);
  const action = connectorAction(item);
  return (
    <li className="flex min-w-0 items-start gap-3 rounded-lg border border-line-subtle bg-raised p-3">
      <LetterIcon name={item.name} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <h3 className="min-w-0 truncate text-base font-semibold text-fg">{item.name}</h3>
          <span className="shrink-0 text-xs text-fg-muted">{connectorKindLabel(item.kind)}</span>
        </div>
        <p className="mt-0.5 truncate text-sm text-fg-secondary">{item.description}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
          <StatusBadge status={state} />
          <span className="text-sm text-fg-secondary">{state.reason}</span>
        </div>
      </div>
      {/* The name comes last so the accessible name starts with the visible words, and rows with the same action differ. */}
      <Button size="sm" aria-label={`${action.label} ${item.name}`} onClick={() => onOpen(item)}>
        {action.label}
      </Button>
    </li>
  );
}
