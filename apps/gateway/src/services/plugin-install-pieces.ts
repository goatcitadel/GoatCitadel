import { createHash } from "node:crypto";
import {
  ConflictError,
  canonicalJsonString,
  type CapabilityPluginPieceView,
  type ChangePlanPluginInstallRequest,
  type McpServerCreateInput,
  type McpServerRecord,
  type McpServerTemplateRecord,
  type PluginPiece,
} from "@goatcitadel/contracts";
import type { StoredPlugin } from "./capability-plugin-store.js";
import { isHostAllowlistedInList } from "./connection-url-helpers.js";
import { findInstallableConnectorTemplate, missingHosts } from "./connector-install-change-plan-adapter.js";
import { hookHost, isConnectorLabelSaved, type PluginInstallHosts } from "./plugin-plan-support.js";

// How a plugin install reads its pieces against what is saved now: the plan's binding, the template a connector piece
// names and the connector it saves, the hosts the install adds, and whether a piece the check found already there still
// is. Plain functions over plain values; the install plan (its adapter) reads the owners and hands them in.

/**
 * The plan's binding: the plugin's record now (none, before an install), the inspection and the manifest and snapshot
 * it checked. Taken when the plan is made and again at apply, so a change in between stops the install plainly.
 */
export function pluginInstallBindingHash(
  record: StoredPlugin | undefined,
  request: ChangePlanPluginInstallRequest,
): string {
  return createHash("sha256")
    .update(
      canonicalJsonString({
        record: record ?? null,
        inspectionId: request.inspectionId,
        manifestSha256: request.manifestSha256,
        snapshotTreeSha256: request.snapshotTreeSha256,
      }),
    )
    .digest("hex");
}

/** The shipped template a connector piece names, by the connector install's own rule, or the rule's plain refusal. */
export function requireInstallTemplate(
  templates: readonly McpServerTemplateRecord[],
  templateId: string,
): McpServerTemplateRecord {
  const found = findInstallableConnectorTemplate(templates, templateId);
  if (!found.ok) throw new ConflictError({ message: found.message });
  return found.template;
}

/** The template's own configuration and policy, switched off. The approval setting is the audited write after. */
export function pluginConnectorInput(template: McpServerTemplateRecord): McpServerCreateInput {
  return {
    label: template.label,
    transport: template.transport,
    command: template.command,
    args: template.args,
    url: template.url,
    authType: template.authType,
    oauth: template.oauth,
    category: template.category,
    trustTier: template.trustTier,
    costTier: template.costTier,
    policy: template.policy,
    enabled: false,
  };
}

/**
 * The hosts an install adds: the missing hosts of each connector it saves (one it owns whose label isn't saved), and
 * its hooks' hosts when the hooks list restricts. An empty hooks list already allows every public https host, so adding
 * one would block every other hook.
 */
export function installHostsToAdd(
  ownedConnectors: readonly Extract<PluginPiece, { kind: "connector" }>[],
  hooks: readonly Extract<PluginPiece, { kind: "hook" }>[],
  templates: readonly McpServerTemplateRecord[],
  saved: readonly Pick<McpServerRecord, "label">[],
  networkAllowlist: readonly string[],
  hookAllowlist: readonly string[],
): PluginInstallHosts {
  const network: string[] = [];
  for (const piece of ownedConnectors) {
    const template = requireInstallTemplate(templates, piece.templateId);
    if (isConnectorLabelSaved(saved, template)) continue;
    for (const host of missingHosts(template, [...networkAllowlist, ...network])) network.push(host);
  }
  const hookHosts: string[] = [];
  if (hookAllowlist.length > 0) {
    for (const piece of hooks) {
      const host = hookHost(piece.url);
      if (!isHostAllowlistedInList(host, [...hookAllowlist, ...hookHosts])) hookHosts.push(host);
    }
  }
  return { network, hooks: hookHosts };
}

/**
 * Whether every piece the check found already there still is: a connector saved under its template's label, a group
 * the operator switched off themselves. One that is gone means the plan would keep, and say it keeps, nothing.
 */
export function keptPiecesStillThere(
  pieces: readonly PluginPiece[],
  views: ReadonlyMap<string, CapabilityPluginPieceView>,
  templates: readonly McpServerTemplateRecord[],
  saved: readonly Pick<McpServerRecord, "label">[],
  operatorOff: ReadonlySet<string>,
): boolean {
  return pieces.every((piece) => {
    if (views.get(piece.id)?.check.status !== "already_there") return true;
    if (piece.kind === "tool_group_off") return operatorOff.has(piece.groupId);
    if (piece.kind !== "connector") return true;
    const template = templates.find((item) => item.templateId === piece.templateId);
    return template !== undefined && isConnectorLabelSaved(saved, template);
  });
}
