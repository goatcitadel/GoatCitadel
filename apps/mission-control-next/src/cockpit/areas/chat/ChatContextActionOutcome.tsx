import type { ReactNode } from "react";
import { ContextDisclosure } from "../../../features/threaded-surface/ThreadedContextDisclosure";
import { Button } from "../../ui/Button";
import type { MissionThreadedContextDockProps } from "@goatcitadel/threaded-surface-core";
export function ChatContextActionOutcome({
  owner,
  family,
}: {
  owner: NonNullable<MissionThreadedContextDockProps["contextMutations"]>["specialists"];
  family: "specialists" | "learnedMemory" | "binding";
}) {
  return (
    <div className="space-y-2">
      {owner.message ? (
        <p role={owner.phase === "uncertain" || owner.phase === "refused" ? "alert" : "status"}>{owner.message}</p>
      ) : null}
      {owner.inspectionError ? <p role="alert">{owner.inspectionError}</p> : null}
      {owner.receipt ? (
        <details>
          <summary>Saved record IDs</summary>
          <p className="break-all text-sm text-fg-muted">
            {owner.receipt.kind}: {owner.receipt.subjectIds.join(" · ")}
          </p>
        </details>
      ) : null}
      <Button
        type="button"
        size="sm"
        className="min-h-8 max-sm:min-h-11"
        disabled={!owner.isCurrent()}
        onClick={() => void owner.onInspect()}
      >
        Inspect current{" "}
        {family === "learnedMemory" ? "learned memory" : family === "binding" ? "binding" : "specialists"}
      </Button>
    </div>
  );
}

export function ChatContextDisclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <ContextDisclosure
      summary={summary}
      className="rounded-md border border-line bg-raised [&>summary]:cursor-pointer [&>summary]:px-3 [&>summary]:py-2 [&>summary]:font-medium [&>div]:space-y-3 [&>div]:px-3 [&>div]:pb-3"
    >
      {children}
    </ContextDisclosure>
  );
}

export function ChatContextMemoryPages({
  pageCount,
  currentPage,
  onPageChange,
}: {
  pageCount: number;
  currentPage: number;
  onPageChange: (page: number) => void;
}) {
  return pageCount > 1 ? (
    <nav className="flex items-center gap-2" aria-label="Loaded learned memory pages">
      <Button
        type="button"
        size="sm"
        className="min-h-8 max-sm:min-h-11"
        disabled={currentPage === 0}
        onClick={() => onPageChange(currentPage - 1)}
      >
        Previous
      </Button>
      <span>
        Page {currentPage + 1} of {pageCount}
      </span>
      <Button
        type="button"
        size="sm"
        className="min-h-8 max-sm:min-h-11"
        disabled={currentPage + 1 === pageCount}
        onClick={() => onPageChange(currentPage + 1)}
      >
        Next
      </Button>
    </nav>
  ) : null;
}
