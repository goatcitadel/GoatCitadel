import type { CapabilityPluginIgnoredPart } from "@goatcitadel/contracts";
import { Section } from "../../../ui/Section";
import { TechnicalDetails } from "../../../ui/TechnicalDetails";
import { LEFT_OUT_TITLE, leftOutGroups } from "./plugin-format-view";

/**
 * "What it leaves out": the parts of a Claude Code plugin GoatCitadel doesn't take, grouped by the kind the Gateway
 * wrote, each group a heading with its count, then each part's name and the Gateway's reason. Paths are for Technical
 * details only. Nothing shows when nothing was left out.
 */
export function PluginLeftOut({ ignored }: { ignored: readonly CapabilityPluginIgnoredPart[] | undefined }) {
  const groups = leftOutGroups(ignored ?? []);
  if (groups.length === 0) return null;
  return (
    <Section title={LEFT_OUT_TITLE} headingLevel={3}>
      <div className="space-y-3">
        {groups.map((group) => (
          <div key={group.kind} className="space-y-1">
            <h4 className="text-xs font-medium text-fg">
              {group.label} <span className="text-fg-muted">{group.parts.length.toLocaleString()}</span>
            </h4>
            <ul className="divide-y divide-line-subtle">
              {group.parts.map((part) => (
                <li key={`${part.path}:${part.label}`} className="space-y-0.5 py-1.5 first:pt-0">
                  <p className="font-medium text-fg">{part.label}</p>
                  <p>{part.reason}</p>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <TechnicalDetails>
          <div className="space-y-1 font-mono">
            {(ignored ?? []).map((part) => (
              <p key={`${part.kind}:${part.path}:${part.label}`}>{`${part.kind}: ${part.path}`}</p>
            ))}
          </div>
        </TechnicalDetails>
      </div>
    </Section>
  );
}
