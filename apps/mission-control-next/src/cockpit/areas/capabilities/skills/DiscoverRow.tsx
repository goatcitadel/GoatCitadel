import { ExternalLink } from "lucide-react";
import type { CapabilitySkillDiscoverItem } from "@goatcitadel/contracts";
import { Button } from "../../../ui/Button";
import { StatusBadge } from "../../../ui/StatusBadge";
import { TechnicalDetails } from "../../../ui/TechnicalDetails";
import { LetterIcon } from "../LetterIcon";
import { discoverAction, presentDiscoverState, VIEW_ONLY_NOTE } from "./discover-view";

export interface DiscoverRowProps {
  /** The row as the Gateway sent it. */
  item: CapabilitySkillDiscoverItem;
  /** Opens the install panel for a source that can be installed. */
  onInstall: (item: CapabilitySkillDiscoverItem) => void;
  /** Opens the install panel at the step an unfinished install has reached. */
  onContinue: (item: CapabilitySkillDiscoverItem) => void;
  /** Opens the installed skill's panel. */
  onView: (skillId: string, name: string) => void;
}

/**
 * One skill on offer as a row card: its letter icon, name and where it came from, a one-line description, the state the
 * Gateway gave it and one action. The action is a button (the card itself is not a click target), or for a listing the
 * Gateway says can't be installed from here, a link to the listing. Every button's accessible name starts with its
 * visible word and ends with the skill's name.
 */
export function DiscoverRow({ item, onInstall, onContinue, onView }: DiscoverRowProps) {
  const state = presentDiscoverState(item.state);
  const action = discoverAction(item);
  return (
    <li className="min-w-0 rounded-lg border border-line-subtle bg-raised p-3">
      <div className="flex min-w-0 items-start gap-3">
        <LetterIcon name={item.name} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <h3 className="min-w-0 truncate text-base font-semibold text-fg">{item.name}</h3>
            <span className="shrink-0 text-xs text-fg-muted">From {item.providerLabel}</span>
          </div>
          {item.description ? <p className="mt-0.5 truncate text-sm text-fg-secondary">{item.description}</p> : null}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusBadge status={state} />
            {item.state === "view_only" ? <span className="text-sm text-fg-secondary">{VIEW_ONLY_NOTE}</span> : null}
          </div>
          {item.listingUrl ? (
            <div className="mt-1">
              <TechnicalDetails>
                <p className="font-mono">{item.listingUrl}</p>
              </TechnicalDetails>
            </div>
          ) : null}
        </div>
        {/* The name comes last so the accessible name starts with the visible word. */}
        {action.kind === "install" ? (
          <Button size="sm" variant="primary" aria-label={`Install ${item.name}`} onClick={() => onInstall(item)}>
            Install
          </Button>
        ) : null}
        {action.kind === "continue" ? (
          <Button size="sm" aria-label={`Continue ${item.name}`} onClick={() => onContinue(item)}>
            Continue
          </Button>
        ) : null}
        {action.kind === "view" ? (
          <Button size="sm" aria-label={`View ${item.name}`} onClick={() => onView(action.skillId, item.name)}>
            View
          </Button>
        ) : null}
        {action.kind === "listing" ? (
          <a
            href={action.href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`See listing for ${item.name}`}
            className="inline-flex shrink-0 items-center gap-1 text-sm text-accent underline-offset-2 hover:underline"
          >
            See listing
            <ExternalLink aria-hidden="true" className="size-3.5" />
          </a>
        ) : null}
      </div>
    </li>
  );
}
