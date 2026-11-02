import type { CapabilityPluginListItem } from "@goatcitadel/contracts";
import { Button } from "../../../ui/Button";
import { StatusBadge } from "../../../ui/StatusBadge";
import { LetterIcon } from "../LetterIcon";
import { pluginTrustLine } from "./plugin-format-view";
import { pluginRowAction, pluginStateNote, presentPluginState } from "./plugin-view";

export interface PluginRowProps {
  /** The row as the Gateway sent it. */
  item: CapabilityPluginListItem;
  /** A plugin that isn't installed. */
  onInstall: (item: CapabilityPluginListItem) => void;
  /** An install that isn't finished: its panel carries on from the first piece that isn't done. */
  onContinue: (item: CapabilityPluginListItem) => void;
  /** An installed plugin, or one on its way out. */
  onView: (item: CapabilityPluginListItem) => void;
}

/**
 * One plugin as a row card: its letter icon, its name and where it comes from, a one-line description, its state and
 * the one action that state offers (Install, Continue or View). The card itself is not a click target, and every
 * button's accessible name starts with its visible word and ends with the plugin's name.
 */
export function PluginRow({ item, onInstall, onContinue, onView }: PluginRowProps) {
  const action = pluginRowAction(item.state);
  const note = pluginStateNote(item);
  return (
    <li className="min-w-0 rounded-lg border border-line-subtle bg-raised p-3">
      <div className="flex min-w-0 items-start gap-3">
        <LetterIcon name={item.name} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <h3 className="min-w-0 truncate text-base font-semibold text-fg">{item.name}</h3>
            <span className="shrink-0 text-xs text-fg-muted">{pluginTrustLine(item)}</span>
          </div>
          {item.description ? <p className="mt-0.5 truncate text-sm text-fg-secondary">{item.description}</p> : null}
          {/* The badge holds the state; the pieces sit beside it, so the badge never wraps at phone width. */}
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            <StatusBadge status={presentPluginState(item)} />
            {note ? (
              <>
                {" "}
                <span className="text-sm text-fg-secondary">{`· ${note}`}</span>
              </>
            ) : null}
          </div>
        </div>
        {/* The name comes last so the accessible name starts with the visible word. */}
        {action === "install" ? (
          <Button size="sm" variant="primary" aria-label={`Install ${item.name}`} onClick={() => onInstall(item)}>
            Install
          </Button>
        ) : null}
        {action === "continue" ? (
          <Button size="sm" aria-label={`Continue ${item.name}`} onClick={() => onContinue(item)}>
            Continue
          </Button>
        ) : null}
        {action === "view" ? (
          <Button size="sm" aria-label={`View ${item.name}`} onClick={() => onView(item)}>
            View
          </Button>
        ) : null}
      </div>
    </li>
  );
}
