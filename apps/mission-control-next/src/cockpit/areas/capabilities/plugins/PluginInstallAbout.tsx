import type { ReactNode } from "react";
import type { CapabilityPluginDetail, CapabilityPluginInspection } from "@goatcitadel/contracts";
import { Section } from "../../../ui/Section";
import { PLUGIN_TRUST_LABELS } from "./plugin-view";
import { SIGN_IN_NEXT, SKIP_ON_NEXT, UNVERIFIED_WARNING, skipOffNext, sourceLine } from "./plugin-install-view";

/** What the panel shows a plugin from: its inspection before the install, its detail after. */
export type ShownPlugin = CapabilityPluginInspection | CapabilityPluginDetail;

/** "What it is": the name, version, author (when the manifest names one) and description. */
export function WhatItIs({ plugin }: { plugin: ShownPlugin }) {
  return (
    <Section title="What it is" headingLevel={3}>
      <div className="space-y-1">
        <p>
          <span className="font-medium text-fg">{plugin.name}</span>
          {` · Version ${plugin.version}`}
          {plugin.author ? ` · By ${plugin.author}` : null}
        </p>
        {plugin.description ? <p>{plugin.description}</p> : null}
      </div>
    </Section>
  );
}

/** "Where it comes from": the source in plain words, its trust label, and the warning an unverified plugin carries. */
export function WhereItComesFrom({
  plugin,
  children,
}: {
  plugin: Pick<ShownPlugin, "sourceKind" | "sourceDisplay" | "pin" | "trust">;
  /** Technical details about the source (the full pin, the folder path). */
  children?: ReactNode;
}) {
  return (
    <Section title="Where it comes from" headingLevel={3}>
      <div className="space-y-1">
        <p>{sourceLine(plugin)}</p>
        <p>{PLUGIN_TRUST_LABELS[plugin.trust]}</p>
        {plugin.trust === "unverified" ? <p>{UNVERIFIED_WARNING}</p> : null}
        {children}
      </div>
    </Section>
  );
}

/**
 * "What happens next", for a check that can be installed. `skip` is the operator's setting to skip approvals for their
 * own changes, from the plugins list; unknown (it couldn't be read) leaves the section out.
 */
export function WhatHappensNext({
  inspection,
  skip,
}: {
  inspection: CapabilityPluginInspection;
  skip: boolean | undefined;
}) {
  if (skip === undefined || !inspection.installable) return null;
  const skills = inspection.pieces.filter((piece) => piece.kind === "skill" && piece.check.status === "ready").length;
  const connectors = inspection.pieces.some((piece) => piece.kind === "connector" && piece.check.status === "ready");
  return (
    <Section title="What happens next" headingLevel={3}>
      <div className="space-y-1">
        <p>{skip ? SKIP_ON_NEXT : skipOffNext(skills)}</p>
        {connectors ? <p>{SIGN_IN_NEXT}</p> : null}
      </div>
    </Section>
  );
}
