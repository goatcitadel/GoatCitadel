import { useId, useState } from "react";
import { Button } from "../../../ui/Button";
import { Field } from "../../../ui/Field";
import { cockpitInputClass } from "../../../ui/input-class";
import type { ConnectorInstallState } from "./use-connector-install";

type SigningIn = Extract<ConnectorInstallState, { phase: "signing_in" }>;

/**
 * Signing in, which happens in the browser: the sign-in page (in a new tab), where it signs in and what it asks for.
 * The return reaches this page through Settings, so the page carries on by itself. When it doesn't, the code and state
 * from the sign-in page can be pasted instead, named as Settings names them; a paste that doesn't match keeps what was
 * typed and says so beside the fields.
 */
export function ConnectorSignInStep({
  state,
  submit,
}: {
  state: SigningIn;
  submit: (code: string, returnedState: string) => void;
}) {
  const [code, setCode] = useState("");
  const [returned, setReturned] = useState("");
  const errorId = useId();
  const mismatch = state.manualError
    ? ({ "aria-describedby": errorId, "aria-invalid": true } as const)
    : ({ "aria-describedby": undefined, "aria-invalid": undefined } as const);
  return (
    <div className="space-y-2 text-sm text-fg-secondary">
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
