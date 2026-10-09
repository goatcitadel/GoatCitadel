import type {
  BrowserSessionGrantRecord,
  BrowserSessionRecord,
  BrowserSessionStateProjection,
} from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { Callout } from "../../ui/Callout";
import { buildSessionPosture, describeContext, formatTime, LIST_LIMIT } from "./browser-sessions-model";

const CARD = "grid min-w-0 grid-cols-1 gap-2 rounded-lg border border-line p-3";
const LIST = "grid min-w-0 grid-cols-1 gap-2 text-sm sm:grid-cols-2";

/** Tool posture and the read-only state projection. Values are never shown; only counts, origins and flags. */
export function BrowserSessionStateView({
  status,
  grants,
  grantsPending,
  grantsError,
  projection,
  pending,
  error,
}: {
  status: BrowserSessionRecord["status"];
  /** Undefined until grants are read: posture is never derived from unknown grants. */
  grants: BrowserSessionGrantRecord[] | undefined;
  grantsPending: boolean;
  grantsError: unknown;
  projection: BrowserSessionStateProjection | undefined;
  pending: boolean;
  error: unknown;
}) {
  const posture = projection && grants ? buildSessionPosture(status, grants, projection.eventSummary) : undefined;
  const state = projection?.state;
  return (
    <>
      {pending ? <p role="status">Reading state projection…</p> : null}
      {error ? <Callout tone="error">{describeApiError(error).summary}</Callout> : null}
      {grantsError ? (
        <Callout tone="error">
          {describeApiError(grantsError).summary} Tool posture is unavailable until grants can be read.
        </Callout>
      ) : grantsPending ? (
        <p role="status">Reading grants…</p>
      ) : null}
      {grants && grants.length >= LIST_LIMIT ? (
        <p className="text-sm text-fg-secondary">
          Posture uses the newest {LIST_LIMIT} grants. Older grants exist; counts may be incomplete.
        </p>
      ) : null}
      {posture ? (
        <section className={CARD} aria-label="State and tool posture">
          <h3 className="font-display text-md font-semibold">State and tool posture</h3>
          <p className="text-sm text-fg-secondary">
            From session records, scoped grants and retained guard events. This does not show that a browser is open,
            bound or active; tools still pass policy checks and guardrails.
          </p>
          <dl className={LIST}>
            <div>
              <dt className="font-medium">Tool use</dt>
              <dd>{posture.callable}</dd>
            </div>
            <div>
              <dt className="font-medium">Active grants</dt>
              <dd>
                {posture.activeGrantCount} · highest scope {posture.highestScope}
              </dd>
            </div>
            <div>
              <dt className="font-medium">Hosts</dt>
              <dd className="wrap-anywhere">{posture.hostPosture}</dd>
            </div>
            <div>
              <dt className="font-medium">Retained evidence</dt>
              <dd>
                {posture.grantedAccessCount} granted · {posture.guardBlockCount} guard blocks · last access{" "}
                {formatTime(posture.lastAccessAt) ?? "none recorded"}
              </dd>
            </div>
          </dl>
        </section>
      ) : null}
      {state && projection ? (
        <section className={CARD} aria-label="Read-only state projection">
          <h3 className="font-display text-md font-semibold">Read-only state projection</h3>
          <p className="text-sm text-fg-secondary">
            Counts and origins come from volatile browser-session memory. Cookie, storage and page values are never
            shown.
          </p>
          <dl className={LIST}>
            <div>
              <dt className="font-medium">Availability</dt>
              <dd>
                {state.availability === "present"
                  ? "State retained"
                  : state.availability === "empty"
                    ? "Empty state"
                    : "Not retained"}{" "}
                · updated {formatTime(state.updatedAt) ?? "not retained"}
              </dd>
            </div>
            <div>
              <dt className="font-medium">Cookies</dt>
              <dd className="wrap-anywhere">
                {state.cookies.count} · {state.cookies.domains.join(", ") || "no domains"}
              </dd>
            </div>
            <div>
              <dt className="font-medium">Local storage</dt>
              <dd className="wrap-anywhere">
                {state.localStorage.keyCount} keys · {state.localStorage.origins.join(", ") || "no origins"}
              </dd>
            </div>
            <div>
              <dt className="font-medium">Session storage</dt>
              <dd className="wrap-anywhere">
                {state.sessionStorage.keyCount} keys · {state.sessionStorage.origins.join(", ") || "no origins"}
              </dd>
            </div>
            <div>
              <dt className="font-medium">Context</dt>
              <dd className="wrap-anywhere">{describeContext(state.context)}</dd>
            </div>
            <div>
              <dt className="font-medium">Recent events</dt>
              <dd>{projection.eventSummary.recentEventCount}</dd>
            </div>
          </dl>
        </section>
      ) : null}
    </>
  );
}
