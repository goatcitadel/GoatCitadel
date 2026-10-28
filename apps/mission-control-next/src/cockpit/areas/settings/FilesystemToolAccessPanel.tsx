import {
  CURATED_FS_MUTATION_TOOLS,
  type CuratedFsMutationTool,
  type GlobalToolAccessPosture,
} from "@goatcitadel/contracts";
import { Button } from "../../ui/Button";
import {
  TOOL_ACCESS_LABELS,
  TOOL_ACCESS_ORDER,
  TOOL_DESCRIPTIONS,
  toolAccessConsequence,
  toolAccessRisk,
  wildcardDenyEntries,
} from "./filesystem-write-access";
import { FilesToolsOffNote } from "./FilesystemWriteAccessParts";
import type { FilesystemWriteAccess } from "./use-filesystem-write-access";

export interface ToolAccessReviewRequest {
  tool: CuratedFsMutationTool;
  current: GlobalToolAccessPosture;
  next: GlobalToolAccessPosture;
}

/** Global allow/deny for the five curated filesystem tools; each row saves on its own. */
export function FilesystemToolAccessPanel({
  control,
  onApply,
}: {
  control: FilesystemWriteAccess;
  onApply: (request: ToolAccessReviewRequest) => void;
}) {
  const { currentTools, toolDraft, locked, settings } = control;
  const wildcards = wildcardDenyEntries(settings.data?.globalToolAccess);
  return (
    <div className="mt-5 border-t border-line-subtle pt-4">
      <h4 id="filesystem-tool-access-title" className="text-sm font-semibold text-fg">
        Global filesystem tool access
      </h4>
      <p className="mt-1 text-sm text-fg-secondary">
        Denied blocks a tool everywhere. Available lets Chat call it in every write root. Not listed leaves the decision
        to permission profiles and agent policy.
      </p>
      <FilesToolsOffNote switchedOffToolGroups={settings.data?.switchedOffToolGroups} />
      {wildcards.length ? (
        <p className="mt-2 text-sm text-status-waiting">
          A wildcard deny rule ({wildcards.join(", ")}) still blocks matching tools. Edit it in the config file; these
          controls change exact entries only.
        </p>
      ) : null}
      {toolDraft.hasRemoteChanges ? (
        <div className="mt-2 space-y-2 text-sm text-fg-secondary">
          <p>Tool access changed after this draft began. Review the current values before applying your draft.</p>
          <Button size="sm" disabled={locked} onClick={toolDraft.rebaseToCurrent}>
            Apply draft to latest version
          </Button>
        </div>
      ) : null}
      <ul aria-labelledby="filesystem-tool-access-title" className="mt-3 divide-y divide-line-subtle">
        {CURATED_FS_MUTATION_TOOLS.map((tool) => {
          const current = currentTools[tool];
          const next = toolDraft.value[tool] ?? current;
          const changed = next !== current;
          const risk = toolAccessRisk(tool, current, next);
          return (
            <li key={tool} className="py-3">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-mono text-sm text-fg">{tool}</p>
                  <p className="text-xs text-fg-muted">
                    {TOOL_DESCRIPTIONS[tool]} · Saved: {TOOL_ACCESS_LABELS[current]}
                  </p>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="block text-sm font-medium text-fg">
                    <span className="sr-only">Access for {tool}</span>
                    <select
                      className="block min-h-10 rounded-md border border-line-control bg-canvas px-2 text-fg"
                      value={next}
                      disabled={locked}
                      onChange={(event) => {
                        control.setNotice(null);
                        const value = event.target.value as GlobalToolAccessPosture;
                        toolDraft.setValue((draft) => ({ ...draft, [tool]: value }));
                      }}
                    >
                      {TOOL_ACCESS_ORDER.map((posture) => (
                        <option key={posture} value={posture}>
                          {TOOL_ACCESS_LABELS[posture]}
                        </option>
                      ))}
                    </select>
                  </label>
                  {changed ? (
                    <Button
                      variant="primary"
                      disabled={locked || toolDraft.hasRemoteChanges}
                      onClick={() => onApply({ tool, current, next })}
                    >
                      {risk === "danger" ? `Review ${tool} change` : `Apply ${tool}`}
                    </Button>
                  ) : null}
                </div>
              </div>
              {changed ? (
                <p className="mt-2 text-sm text-status-waiting">
                  Unsaved: {TOOL_ACCESS_LABELS[current]} to {TOOL_ACCESS_LABELS[next]}.{" "}
                  {toolAccessConsequence(tool, next)}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
