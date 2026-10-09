import type { OpsSavedBoardRecord } from "@goatcitadel/contracts";
import { TechnicalDetails } from "../../ui/TechnicalDetails";

const formatTime = (iso: string) => (Number.isFinite(Date.parse(iso)) ? new Date(iso).toLocaleString() : iso);

/** The saved layout record's identity and history, in plain language. Request hashes stay in Technical details. */
export function BoardDetails({ board }: { board: OpsSavedBoardRecord }) {
  const rows: Array<[string, string]> = [
    ["Board ID", board.boardId],
    ["Revision", String(board.revision)],
    ["Status", board.status === "archived" ? "Archived" : "Active"],
    ["Created by", `${board.createdByActorId} · ${formatTime(board.createdAt)}`],
    ["Last updated by", `${board.updatedByActorId} · ${formatTime(board.updatedAt)}`],
    ...(board.archivedByActorId && board.archivedAt
      ? ([["Archived by", `${board.archivedByActorId} · ${formatTime(board.archivedAt)}`]] as Array<[string, string]>)
      : []),
  ];
  return (
    <details className="rounded-md border border-line p-3 text-sm">
      <summary className="min-h-11 cursor-pointer content-center font-medium text-fg">Board details</summary>
      <dl className="mt-2 grid min-w-0 grid-cols-1 gap-1">
        {rows.map(([label, value]) => (
          <div key={label} className="flex min-w-0 flex-wrap gap-x-2">
            <dt className="text-fg-secondary">{label}</dt>
            <dd className="min-w-0 wrap-anywhere text-fg">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-fg-secondary">
        A saved board is a layout only: its widgets read their own owners, and the board never controls the runtime.
      </p>
      <TechnicalDetails label="Request identity">
        <p className="wrap-anywhere">Create request {board.idempotencyKey}</p>
        <p className="wrap-anywhere">Request hash {board.requestSha256}</p>
      </TechnicalDetails>
    </details>
  );
}
