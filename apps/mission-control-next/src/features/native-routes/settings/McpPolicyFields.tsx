import { useId, type Dispatch, type SetStateAction } from "react";
import type { McpServerPolicy } from "@goatcitadel/contracts";
import type { createMcpEditForm } from "./sections/mcp-editor-drafts";

type Draft = ReturnType<typeof createMcpEditForm>;
/** Shared field semantics; each presentation provides its own field classes. */
export function McpPolicyFields({
  value,
  onChange,
  stdio,
  fieldClass,
  className,
}: {
  value: Draft;
  onChange: Dispatch<SetStateAction<Draft>>;
  stdio: boolean;
  fieldClass: string;
  className?: string;
}) {
  const id = useId();
  const policy = value.policy;
  const patch = (update: Partial<McpServerPolicy>) =>
    onChange((current) => ({ ...current, policy: { ...current.policy, ...update } }));
  return (
    <details className={className}>
      <summary>Arguments and tool policy</summary>
      <p>
        These are installation-wide saved settings. Saving closes current connections. Tool policy remains subordinate
        to Gateway approvals and deny rules.
      </p>
      {stdio ? (
        <div>
          <label htmlFor={`${id}-args`}>Process arguments — one per line</label>
          <textarea
            id={`${id}-args`}
            className={fieldClass}
            rows={4}
            value={value.args.join("\n")}
            onChange={(event) => onChange((current) => ({ ...current, args: event.target.value.split("\n") }))}
          />
          <p>
            Each line is one argument; spaces within a line stay together. Existing redaction markers preserve saved
            secrets through the Gateway owner.
          </p>
        </div>
      ) : null}
      <label>
        <input
          type="checkbox"
          checked={policy.requireFirstToolApproval}
          onChange={(event) => patch({ requireFirstToolApproval: event.target.checked })}
        />
        Require approval for each tool's first use
      </label>
      <div>
        <label htmlFor={`${id}-redaction`}>Tool output redaction</label>
        <select
          id={`${id}-redaction`}
          className={fieldClass}
          value={policy.redactionMode}
          onChange={(event) => patch({ redactionMode: event.target.value as McpServerPolicy["redactionMode"] })}
        >
          <option value="off">Off</option>
          <option value="basic">Basic</option>
          <option value="strict">Strict</option>
        </select>
      </div>
      {(
        [
          ["allowedToolPatterns", "Allowed tool patterns"],
          ["blockedToolPatterns", "Blocked tool patterns"],
          ["allowedEnvKeys", "Allowed environment keys"],
        ] as const
      ).map(([key, label]) => (
        <div key={key}>
          <label htmlFor={`${id}-${key}`}>{label} — one per line</label>
          <textarea
            id={`${id}-${key}`}
            className={fieldClass}
            rows={3}
            value={(policy[key] ?? []).join("\n")}
            onChange={(event) => patch({ [key]: event.target.value.split("\n") })}
          />
        </div>
      ))}
      <p>
        Tool patterns support *. Blocked patterns win. Environment entries are key names, never values; they select host
        variables available to this server.
      </p>
      <div>
        <label htmlFor={`${id}-notes`}>Policy notes</label>
        <textarea
          id={`${id}-notes`}
          className={fieldClass}
          rows={3}
          value={policy.notes ?? ""}
          onChange={(event) => patch({ notes: event.target.value })}
        />
      </div>
    </details>
  );
}

export function McpPolicySummary({ args, policy }: { args: string[]; policy: McpServerPolicy }) {
  return (
    <dl>
      <dt>Process arguments</dt>
      <dd>
        <code className="break-all font-mono">
          {args
            .filter((item) => item.trim())
            .map((item) => item.trim())
            .join(" · ") || "None"}
        </code>
      </dd>
      <dt>First tool use approval</dt>
      <dd>{policy.requireFirstToolApproval ? "Required" : "Not required by this server policy"}</dd>
      <dt>Output redaction</dt>
      <dd>{policy.redactionMode}</dd>
      <dt>Allowed tool patterns</dt>
      <dd>{policy.allowedToolPatterns.filter(Boolean).join(", ") || "No additional allow restriction"}</dd>
      <dt>Blocked tool patterns</dt>
      <dd>{policy.blockedToolPatterns.filter(Boolean).join(", ") || "None"}</dd>
      <dt>Allowed environment keys</dt>
      <dd>{policy.allowedEnvKeys?.filter(Boolean).join(", ") || "None"}</dd>
      <dt>Policy notes</dt>
      <dd>{policy.notes?.trim() || "None"}</dd>
    </dl>
  );
}
