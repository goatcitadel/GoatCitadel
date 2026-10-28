import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../../ui/Button";
import { Field } from "../../../ui/Field";
import { cockpitInputClass } from "../../../ui/input-class";
import type { ConnectorInstallState } from "./use-connector-install";

type SigningIn = Extract<ConnectorInstallState, { phase: "signing_in" }>;

/** The Gateway keeps a sign-in request for 10 minutes; a minute before that, a new one is offered instead (R94). */
const RESTART_AFTER_MS = 9 * 60_000;
const EXPIRES_AFTER_MS = 10 * 60_000;

/** Whether a sign-in request can still be finished, is about to run out of time, or has run out. */
export type SignInTimeLeft = "open" | "nearly_out" | "out";

const TIME_HEADINGS: Readonly<Record<Exclude<SignInTimeLeft, "open">, string>> = {
  nearly_out: "This sign-in request is about to run out of time.",
  out: "This sign-in request has run out of time.",
};
const START_A_NEW_ONE = "Start a new one, then finish signing in within 10 minutes.";

/** What the page says once a request is short of time, as the flow's live region reads it out too. */
export function signInTimeWords(left: Exclude<SignInTimeLeft, "open">): string {
  return `${TIME_HEADINGS[left]} ${START_A_NEW_ONE}`;
}

/** Whether this moment has passed, rechecked when it comes. No deadline never passes. */
function useHasPassed(deadline: number | undefined): boolean {
  // The deadline this view has seen pass; a new sign-in request has a new one.
  const [passed, setPassed] = useState(() => (deadline !== undefined && Date.now() >= deadline ? deadline : undefined));
  useEffect(() => {
    if (deadline === undefined) return undefined;
    const left = deadline - Date.now();
    if (left <= 0) {
      setPassed(deadline);
      return undefined;
    }
    const timer = globalThis.setTimeout(() => setPassed(deadline), left);
    return () => globalThis.clearTimeout(timer);
  }, [deadline]);
  return deadline !== undefined && passed === deadline;
}

/** How much time a sign-in request made at `startedAt` has left, rechecked as each moment comes. */
export function useSignInTimeLeft(startedAt: number | undefined): SignInTimeLeft {
  const nearlyOut = useHasPassed(startedAt === undefined ? undefined : startedAt + RESTART_AFTER_MS);
  const out = useHasPassed(startedAt === undefined ? undefined : startedAt + EXPIRES_AFTER_MS);
  return out ? "out" : nearlyOut ? "nearly_out" : "open";
}

/**
 * Signing in, which happens in the browser: the sign-in page (in a new tab), where it signs in and what it asks for.
 * The return reaches this page through Settings, so the page carries on by itself. When it doesn't, the code and state
 * from the sign-in page can be pasted instead, named as Settings names them; a paste that doesn't match keeps what was
 * typed and says so beside the fields. A request close to its 10 minutes (one started in the background while the
 * operator was in Inbox, say) is offered as a new one instead of a sign-in that would fail, and one past them says it
 * has run out. The flow's live region reads that swap out, and focus that was in this step moves to the new button.
 */
export function ConnectorSignInStep({
  state,
  submit,
  restart,
}: {
  state: SigningIn;
  submit: (code: string, returnedState: string) => void;
  restart: () => void;
}) {
  const [code, setCode] = useState("");
  const [returned, setReturned] = useState("");
  const errorId = useId();
  const timeLeft = useSignInTimeLeft(state.startedAt);
  const root = useRef<HTMLDivElement>(null);
  const restartButton = useRef<HTMLButtonElement>(null);
  // Read while rendering, before the swap reaches the page, as usePanelFocus reads the panel.
  const hadFocus = useRef(false);
  hadFocus.current = Boolean(root.current?.contains(document.activeElement));
  const swapped = timeLeft !== "open";
  useLayoutEffect(() => {
    if (!swapped || !hadFocus.current) return;
    const active = document.activeElement;
    // The link or field that held focus is gone with the swap; focus elsewhere on the page is left alone.
    if (!active || active === document.body || !active.isConnected) restartButton.current?.focus();
  }, [swapped]);
  if (timeLeft !== "open") {
    return (
      <div ref={root} className="space-y-2 text-sm text-fg-secondary">
        <p className="font-medium text-fg">{TIME_HEADINGS[timeLeft]}</p>
        <p>{START_A_NEW_ONE}</p>
        <Button ref={restartButton} size="sm" onClick={restart}>
          Start sign-in again
        </Button>
      </div>
    );
  }
  const mismatch = state.manualError
    ? ({ "aria-describedby": errorId, "aria-invalid": true } as const)
    : ({ "aria-describedby": undefined, "aria-invalid": undefined } as const);
  return (
    <div ref={root} className="space-y-2 text-sm text-fg-secondary">
      <p className="font-medium text-fg">Finish signing in in your browser</p>
      <p>Signs in at {state.signInHost}</p>
      <p>Access requested: {state.scopes}</p>
      <a
        href={state.authorizeUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="block w-fit text-accent underline-offset-2 hover:underline"
      >
        Open sign-in page
      </a>
      <p>Finish within 10 minutes.</p>
      <p>Keep this page open while you sign in. It carries on by itself once you're back.</p>
      <details>
        <summary className="cursor-pointer font-medium text-accent">Paste the code instead</summary>
        <div className="mt-2 space-y-3">
          <p>If the sign-in page doesn't bring you back, copy the code and state from its address.</p>
          <Field label="Authorization code">
            {(props) => (
              <input
                {...props}
                {...mismatch}
                type="password"
                autoComplete="off"
                maxLength={8192}
                value={code}
                className={cockpitInputClass}
                onChange={(event) => setCode(event.target.value)}
              />
            )}
          </Field>
          <Field label="Returned state">
            {(props) => (
              <input
                {...props}
                {...mismatch}
                type="text"
                autoComplete="off"
                maxLength={128}
                value={returned}
                className={cockpitInputClass}
                onChange={(event) => setReturned(event.target.value)}
              />
            )}
          </Field>
          {state.manualError ? (
            <p id={errorId} className="text-status-failed">
              {state.manualError}
            </p>
          ) : null}
          <Button size="sm" disabled={!code.trim() || !returned.trim()} onClick={() => submit(code, returned)}>
            Finish signing in
          </Button>
        </div>
      </details>
    </div>
  );
}
