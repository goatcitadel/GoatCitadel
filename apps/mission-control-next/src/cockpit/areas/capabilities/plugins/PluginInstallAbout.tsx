import type { ReactNode } from "react";
import type { CapabilityPluginDetail, CapabilityPluginInspection } from "@goatcitadel/contracts";
import { Section } from "../../../ui/Section";
import { StatusBadge } from "../../../ui/StatusBadge";
import {
  CLAUDE_CODE_READING_LINE,
  EXPERIMENTAL_LABEL,
  coverageLine,
  isClaudeCodeFormat,
  pluginTrustLine,
} from "./plugin-format-view";
import { SIGN_IN_NEXT, SKIP_ON_NEXT, UNVERIFIED_WARNING, skipOffNext, sourceLine } from "./plugin-install-view";

/** What the panel shows a plugin from: its inspection before the install, its detail after. */
export type ShownPlugin = CapabilityPluginInspection | CapabilityPluginDetail;

/** "What it is": the name, version, author (when the manifest names one) and description. */
export function WhatItIs({ plugin }: { plugin: Pick<ShownPlugin, "name" | "version" | "author" | "description"> }) {
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
  plugin: Pick<ShownPlugin, "sourceKind" | "sourceDisplay" | "pin" | "trust" | "sourceFormat" | "claudeCode">;
  /** Technical details about the source (the full pin, the folder path). */
  children?: ReactNode;
}) {
  const claudeCode = isClaudeCodeFormat(plugin);
  return (
    <Section title="Where it comes from" headingLevel={3}>
      <div className="space-y-1">
        <p>{sourceLine(plugin)}</p>
        <p>{pluginTrustLine(plugin)}</p>
        {plugin.trust === "unverified" ? <p>{UNVERIFIED_WARNING}</p> : null}
        {claudeCode ? (
          <>
            <StatusBadge status={{ label: EXPERIMENTAL_LABEL, tone: "neutral" }} />
            <p>{CLAUDE_CODE_READING_LINE}</p>
            {plugin.claudeCode ? <p>{coverageLine(plugin.claudeCode.coverage)}</p> : null}
          </>
        ) : null}
        {children}
      </div>
    </Section>
  );
}

/** A Claude Code plugin's translator version and plugin.json hash, for Technical details; nothing for any other. */
export function ClaudeCodeDetails({ plugin }: { plugin: Pick<ShownPlugin, "claudeCode"> }) {
  if (!plugin.claudeCode) return null;
  return (
    <>
      <p>{`translator ${plugin.claudeCode.translatorVersion}`}</p>
      <p>{plugin.claudeCode.pluginJsonSha256}</p>
    </>
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
