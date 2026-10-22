import type { ReactNode } from "react";
import type { OpsSavedBoardRecord } from "@goatcitadel/contracts";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { TimeText } from "../../ui/TimeText";

/** The saved layout record's history, in plain language. IDs, actors and request hashes stay in Technical details. */
export function BoardDetails({ board }: { board: OpsSavedBoardRecord }) {
  const rows: Array<[string, ReactNode]> = [
    ["Version", String(board.revision)],
    ["Status", board.status === "archived" ? "Archived" : "Active"],
    ["Created", <TimeText key="created" value={board.createdAt} />],
    ["Last updated", <TimeText key="updated" value={board.updatedAt} />],
    ...(board.archivedByActorId && board.archivedAt
      ? ([["Archived", <TimeText key="archived" value={board.archivedAt} />]] as Array<[string, ReactNode]>)
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
        A saved board is a layout only: each widget reads its data from the page that manages it, and the board never
        controls the runtime.
      </p>
      <TechnicalDetails label="Record identity">
        <p className="wrap-anywhere">Board ID {board.boardId}</p>
        <p className="wrap-anywhere">Created by {board.createdByActorId}</p>
        <p className="wrap-anywhere">Last updated by {board.updatedByActorId}</p>
        {board.archivedByActorId ? <p className="wrap-anywhere">Archived by {board.archivedByActorId}</p> : null}
        <p className="wrap-anywhere">Create request {board.idempotencyKey}</p>
        <p className="wrap-anywhere">Request hash {board.requestSha256}</p>
      </TechnicalDetails>
    </details>
  );
}
