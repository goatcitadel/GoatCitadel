import { useRef, useState, type KeyboardEvent } from "react";
import { EmptyState, NativeButton, StatusChip } from "@next/features/native-routes/primitives";
import type { Permission } from "../runner/policy";
import { recordFor, type CheckRecord, type RunState } from "../runner/state";
import type { CheckDef } from "../runner/types";
import { KIND_LABELS, STATUS_DISPLAY, formatDuration } from "./status-display";

export const CHECK_PAGE_SIZE = 200;

export interface CheckListProps {
  readonly checks: readonly CheckDef[];
  readonly state: RunState;
  readonly selectedId: string | undefined;
  readonly running: boolean;
  readonly onSelect: (checkId: string) => void;
  readonly onRun: (check: CheckDef) => void;
  readonly permissionOf: (check: CheckDef) => Permission;
}

export function CheckList({ checks, state, selectedId, running, onSelect, onRun, permissionOf }: CheckListProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const [limit, setLimit] = useState(CHECK_PAGE_SIZE);
  if (checks.length === 0) {
    return (
      <section className="testbench-list" aria-label="Checks">
        <EmptyState size="compact" title="No checks match these filters." />
      </section>
    );
  }
  const hidden = checks.length - limit;
  const moveFocus = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-testbench-row]") ?? []);
    // Resolve the row that holds focus, whether that is its main button or its Run button.
    const activeItem = document.activeElement?.closest("li");
    const current = rows.findIndex((row) => row.closest("li") === activeItem);
    const target = event.key === "ArrowDown" ? current + 1 : current - 1;
    const next = rows[Math.min(rows.length - 1, Math.max(0, target))];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };
  return (
    <section className="testbench-list" aria-label="Checks">
      <ul ref={listRef} onKeyDown={moveFocus}>
        {checks.slice(0, limit).map((check) => (
          <CheckRow
            key={check.id}
            check={check}
            record={recordFor(state, check.id)}
            selected={check.id === selectedId}
            running={running}
            permission={permissionOf(check)}
            onSelect={onSelect}
            onRun={onRun}
          />
        ))}
      </ul>
      {hidden > 0 ? (
        <NativeButton
          type="button"
          variant="outline"
          className="testbench-more"
          onClick={() => setLimit(limit + CHECK_PAGE_SIZE)}
        >
          {`Show ${Math.min(CHECK_PAGE_SIZE, hidden)} more (${hidden} hidden)`}
        </NativeButton>
      ) : null}
    </section>
  );
}

interface CheckRowProps {
  readonly check: CheckDef;
  readonly record: CheckRecord;
  readonly selected: boolean;
  readonly running: boolean;
  readonly permission: Permission;
  readonly onSelect: (checkId: string) => void;
  readonly onRun: (check: CheckDef) => void;
}

function CheckRow({ check, record, selected, running, permission, onSelect, onRun }: CheckRowProps) {
  const display = STATUS_DISPLAY[record.status];
  return (
    <li className="testbench-row" data-selected={selected ? "true" : undefined}>
      <button
        type="button"
        className="testbench-row-main"
        data-testbench-row=""
        aria-pressed={selected}
        onClick={() => onSelect(check.id)}
      >
        <StatusChip tone={display.tone} size="sm">{`${display.icon} ${display.label}`}</StatusChip>
        <span className="testbench-row-title">
          {check.title} <span className="testbench-meta">{KIND_LABELS[check.kind]}</span>
        </span>
        <span className="testbench-tier">{check.tier}</span>
        <span className="testbench-meta testbench-duration">
          {record.durationMs === undefined ? "—" : formatDuration(record.durationMs)}
        </span>
      </button>
      <NativeButton
        type="button"
        variant="outline"
        aria-label={`Run ${check.title}`}
        disabled={running || !permission.allowed}
        onClick={() => onRun(check)}
      >
        Run
      </NativeButton>
      {permission.allowed ? null : <span className="testbench-meta testbench-reason">{permission.reason}</span>}
    </li>
  );
}
