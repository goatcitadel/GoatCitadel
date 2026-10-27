import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "../../../lib/cn";

export interface SetupStepView {
  id: string;
  title: string;
  /** Locked: waits on an earlier step. Current: the operator acts here. Done: it checked itself. */
  state: "locked" | "current" | "done";
  /** What the step found, in words. Shown once the step is open (current or done). */
  result?: ReactNode;
  /** What the operator does here. Shown only while the step is current. */
  children?: ReactNode;
}

/** The state in words, for readers who cannot see the check mark or the muted title. A current step says it by `aria-current`. */
const STATE_WORD: Readonly<Partial<Record<SetupStepView["state"], string>>> = { done: "Done", locked: "Locked" };

/**
 * A channel's setup as numbered steps. A locked step shows only its title; a done step shows what it found; a
 * current step shows what to do. More than one step can be open at once (a step whose work happens elsewhere stays
 * open beside the one that takes its result), and each shows what to do; but assistive technology is told about one
 * current step, the last open one, where the operator acts. The one status line is the page's only live region: it
 * announces an outcome while the visible text sits in the step that has it, so nothing is read twice on screen.
 */
export function SetupSteps({ steps, status }: { steps: readonly SetupStepView[]; status?: string }) {
  const currentIndex = steps.reduce((last, step, index) => (step.state === "current" ? index : last), -1);
  return (
    <div>
      <ol className="grid gap-4">
        {steps.map((step, index) => (
          <li
            key={step.id}
            data-state={step.state}
            aria-current={index === currentIndex ? "step" : undefined}
            className="border-t border-line-subtle pt-4 first:border-t-0 first:pt-0"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h2 className={cn("text-base font-semibold", step.state === "locked" ? "text-fg-muted" : "text-fg")}>
                {index + 1}. {step.title}
              </h2>
              {step.state === "done" ? <Check aria-hidden="true" className="size-4 text-status-done" /> : null}
              {STATE_WORD[step.state] ? <span className="sr-only">{STATE_WORD[step.state]}</span> : null}
            </div>
            {step.state !== "locked" && step.result ? (
              <div className="mt-1 text-sm text-fg-secondary">{step.result}</div>
            ) : null}
            {step.state === "current" && step.children ? <div className="mt-3 space-y-3">{step.children}</div> : null}
          </li>
        ))}
      </ol>
      <p role="status" className="sr-only">
        {status}
      </p>
    </div>
  );
}
