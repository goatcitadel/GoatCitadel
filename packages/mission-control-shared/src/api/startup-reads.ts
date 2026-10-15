import {
  isStartupReadPath,
  STARTUP_READ_BATCH_PATH,
  STARTUP_READ_BATCH_LIMIT,
  STARTUP_READ_BATCH_QUERY_LIMIT,
  type StartupReadRequest,
  type StartupReadResponse,
} from "@goatcitadel/contracts/startup-reads";
import { ApiRequestError } from "./http-internal";
export interface StartupReadScope {
  installation: string;
  accessRevision: number;
  caller: string;
  callerRevision: number;
}
interface PendingRead {
  item: StartupReadRequest;
  url: string;
  init: RequestInit;
  current: () => boolean;
  resolve: (value: Response) => void;
  reject: (reason: unknown) => void;
  cleanup: () => void;
  settled: boolean;
}
interface ReadQueue {
  scope: StartupReadScope;
  authorization: string | null;
  credentials: RequestCredentials | undefined;
  mode: RequestMode | undefined;
  redirect: RequestRedirect | undefined;
  rows: PendingRead[];
}
let windowScope: StartupReadScope | undefined;
let windowEnd = 0;
let queues: ReadQueue[] = [];
const ALLOWED_HEADERS = new Set([
  "authorization",
  "content-type",
  "x-goatcitadel-correlation-id",
  "x-goatcitadel-origin-surface",
]);
const RESPONSE_HEADERS = new Set(["content-type", "cache-control", "etag", "x-goatcitadel-correlation-id"]);
const sameScope = (a: StartupReadScope, b: StartupReadScope) =>
  a.installation === b.installation &&
  a.accessRevision === b.accessRevision &&
  a.caller === b.caller &&
  a.callerRevision === b.callerRevision;
/** Called only after native operator access and server caller identity have been verified. No response cache. */
export function beginStartupReadWindow(scope: StartupReadScope): void {
  windowScope = scope;
  windowEnd = Date.now() + 10_000;
}
function batchUrl(scope: StartupReadScope, rows: PendingRead[]): string {
  return (
    scope.installation.replace(/\/$/u, "") +
    STARTUP_READ_BATCH_PATH +
    "?" +
    new URLSearchParams({ reads: JSON.stringify(rows.map((row) => row.item)) })
  );
}
function invalid(path: string) {
  return new ApiRequestError("Invalid Gateway startup read response", { kind: "protocol", method: "GET", path });
}
function validResult(value: unknown): value is StartupReadResponse {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    Number.isInteger(row.status) &&
    Number(row.status) >= 200 &&
    Number(row.status) <= 599 &&
    typeof row.bodyText === "string" &&
    row.headers !== null &&
    typeof row.headers === "object" &&
    !Array.isArray(row.headers) &&
    Object.entries(row.headers).every(
      ([key, value]) => RESPONSE_HEADERS.has(key) && typeof value === "string" && !/[\r\n]/u.test(value),
    ) &&
    (row.directReadRequired === undefined || row.directReadRequired === true)
  );
}
async function dispatch(queue: ReadQueue): Promise<void> {
  queues = queues.filter((candidate) => candidate !== queue);
  const rows = queue.rows.filter((row) => !row.settled && row.current());
  for (const row of queue.rows)
    if (!row.settled && !row.current()) row.reject(new DOMException("Gateway scope changed", "AbortError"));
  const groups: PendingRead[][] = [];
  for (const row of rows) {
    let group = groups.at(-1);
    if (
      !group ||
      group.length >= STARTUP_READ_BATCH_LIMIT ||
      batchUrl(queue.scope, [...group, row]).length >
        queue.scope.installation.length + STARTUP_READ_BATCH_QUERY_LIMIT + 100
    ) {
      group = [];
      groups.push(group);
    }
    group.push(row);
  }
  await Promise.all(
    groups.map(async (group) => {
      try {
        if (group.length === 1) {
          const row = group[0]!;
          row.resolve(await fetch(row.url, row.init));
          return;
        }
        const first = group[0]!;
        const response = await fetch(batchUrl(queue.scope, group), {
          ...first.init,
          method: "GET",
          signal: undefined,
          cache: "no-store",
        });
        if (response.status === 404 || response.status === 405) {
          await Promise.all(
            group.map(async (row) => {
              if (row.current() && !row.settled) row.resolve(await fetch(row.url, row.init));
              else row.reject(new DOMException("Gateway scope changed", "AbortError"));
            }),
          );
          return;
        }
        if (!response.ok) {
          const body = await response.text();
          for (const row of group)
            row.resolve(new Response(body, { status: response.status, headers: response.headers }));
          return;
        }
        const body: unknown = await response.json();
        const items = body && typeof body === "object" ? (body as { items?: unknown }).items : undefined;
        if (!Array.isArray(items) || items.length !== group.length || !items.every(validResult))
          throw invalid(first.item.path);
        await Promise.all(
          group.map(async (row, index) => {
            if (!row.current() || row.settled) {
              row.reject(new DOMException("Gateway scope changed", "AbortError"));
              return;
            }
            const result = items[index]!;
            if (result.directReadRequired) row.resolve(await fetch(row.url, row.init));
            else
              row.resolve(
                new Response([204, 205, 304].includes(result.status) ? null : result.bodyText, {
                  status: result.status,
                  headers: result.headers,
                }),
              );
          }),
        );
      } catch (error) {
        for (const row of group) row.reject(error);
      } finally {
        for (const row of group) row.cleanup();
      }
    }),
  );
}
export function fetchStartupRead(
  url: string,
  init: RequestInit,
  scope: StartupReadScope,
  current: () => boolean,
): Promise<Response> {
  const parsed = new URL(url),
    path = parsed.pathname + parsed.search,
    headers = new Headers(init.headers);
  if (
    !windowScope ||
    !sameScope(scope, windowScope) ||
    Date.now() >= windowEnd ||
    init.method !== "GET" ||
    init.body ||
    !isStartupReadPath(path) ||
    [...headers.keys()].some((key) => !ALLOWED_HEADERS.has(key))
  )
    return fetch(url, init);
  const item = {
    path,
    correlationId: headers.get("x-goatcitadel-correlation-id") ?? "startup-read",
    ...(headers.get("x-goatcitadel-origin-surface")
      ? { originSurface: headers.get("x-goatcitadel-origin-surface")! }
      : {}),
  };
  let queue = queues.find(
    (candidate) =>
      sameScope(candidate.scope, scope) &&
      candidate.authorization === headers.get("authorization") &&
      candidate.credentials === init.credentials &&
      candidate.mode === init.mode &&
      candidate.redirect === init.redirect,
  );
  // Flush at the next task boundary so promise-based owner reads join the same packet.
  if (!queue) {
    queue = {
      scope,
      authorization: headers.get("authorization"),
      credentials: init.credentials,
      mode: init.mode,
      redirect: init.redirect,
      rows: [],
    };
    queues.push(queue);
    const owner = queue;
    globalThis.setTimeout(() => {
      void dispatch(owner);
    }, 0);
  }
  const owner = queue;
  return new Promise<Response>((resolve, reject) => {
    const row: PendingRead = {
      item,
      url,
      init,
      current,
      settled: false,
      resolve(value) {
        if (!row.settled) {
          row.settled = true;
          row.cleanup();
          resolve(value);
        }
      },
      reject(reason) {
        if (!row.settled) {
          row.settled = true;
          row.cleanup();
          reject(reason);
        }
      },
      cleanup() {
        init.signal?.removeEventListener("abort", abort);
      },
    };
    function abort() {
      row.reject(init.signal?.reason ?? new DOMException("Read cancelled", "AbortError"));
    }
    owner.rows.push(row);
    init.signal?.addEventListener("abort", abort, { once: true });
    if (init.signal?.aborted) abort();
  });
}
