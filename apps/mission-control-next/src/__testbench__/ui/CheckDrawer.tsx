import { NativeButton, StatusChip } from "@next/features/native-routes/primitives";
import type { CheckRecord } from "../runner/state";
import type { CheckDef } from "../runner/types";
import { STATUS_DISPLAY, STEP_ICON, formatEvidence } from "./status-display";

export interface CheckDrawerProps {
  readonly check: CheckDef | undefined;
  readonly record: CheckRecord | undefined;
  readonly onClose: () => void;
}

export function CheckDrawer({ check, record, onClose }: CheckDrawerProps) {
  if (!check || !record) {
    return (
      <aside className="testbench-drawer testbench-drawer-empty" aria-label="Check details">
        <p className="testbench-meta">Select a check to see its steps and evidence.</p>
      </aside>
    );
  }
  const display = STATUS_DISPLAY[record.status];
  const reached = new Set(record.steps.map((step) => step.title));
  const unreached = (check.steps ?? []).filter((title) => !reached.has(title));
  return (
    <aside className="testbench-drawer" aria-label={`${check.title} details`}>
      <header className="testbench-drawer-header">
        <h2>{check.title}</h2>
        <NativeButton type="button" variant="ghost" aria-label="Close details" onClick={onClose}>
          Close
        </NativeButton>
      </header>
      <p>
        <StatusChip tone={display.tone}>{`${display.icon} ${display.label}`}</StatusChip>{" "}
        <span className="testbench-tier">{check.tier}</span>
      </p>
      {record.summary ? <p className="testbench-summary">{record.summary}</p> : null}
      {check.description ? <p className="testbench-meta">{check.description}</p> : null}
      {record.steps.length > 0 || unreached.length > 0 ? (
        <ol className="testbench-steps">
          {record.steps.map((step, index) => (
            <li key={`${step.title}-${index}`}>{`${STEP_ICON[step.status]} ${step.title}`}</li>
          ))}
          {unreached.map((title) => (
            <li key={`unreached-${title}`} className="testbench-meta">{`– ${title} (not run)`}</li>
          ))}
        </ol>
      ) : null}
      <h3>Routes</h3>
      <ul className="testbench-routes">
        {check.routes.map((route) => (
          <li key={route}>
            <code>{route}</code>
          </li>
        ))}
      </ul>
      {record.log.length > 0 ? (
        <details>
          <summary>{`Log (${record.log.length})`}</summary>
          <ul className="testbench-routes">
            {record.log.map((entry, index) => (
              <li key={`${entry.at}-${index}`}>{`${entry.at} ${entry.message}`}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {record.evidence !== undefined ? (
        <details className="testbench-raw">
          <summary>Raw response (secondary detail)</summary>
          <pre>{formatEvidence(record.evidence)}</pre>
        </details>
      ) : null}
    </aside>
  );
}
