import {
  canonicalJsonString,
  hashRemoteWorkerInstallCapacityCapture,
  normalizeRemoteWorkerInstallCapacityBinding,
  normalizeRemoteWorkerNativePoolCapacityWindow,
  remoteWorkerCellCanonicalSha256,
  REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES,
  type RemoteWorkerInstallCapacityBinding,
  type RemoteWorkerNativePoolCapacityWindow,
} from "@goatcitadel/contracts";
import {
  snapshotRemoteWorkerCellCapacityAuthority,
  snapshotRuntimeInstallPoolCapture,
  type AsyncStorage,
  type RemoteWorkerCellCapacityAuthority,
} from "@goatcitadel/storage";
import type {
  RemoteWorkerInstallationCapacityOwner,
  RemoteWorkerInstallationReservation,
} from "./remote-worker-installation-capacity-owner.js";
import {
  awaitControllerAuthority,
  createControllerSignedInstallationEndpoint,
  type ControllerAttestationTransport,
} from "./remote-worker-controller-attestation.js";

/** Trusted installed transport owner only. The implementation must verify the
 * authenticated endpoint and retained writer exclusion for this exact window.
 * Neither this port nor window registration is accepted over worker RPC. */
export interface RemoteWorkerInstallationEndpoint {
  /** Independently retained authenticated handshake nonce. Keep this endpoint
   * object's identity stable for the complete connection; never wrap/rebind it. */
  readonly connectionNonceHex: string;
  /** Abort on loss of authority or unexpected disconnect. A verified finish and
   * joined normal shutdown are handled by reservation.finish, not cancellation. */
  readonly signal: AbortSignal;
  verify(window: RemoteWorkerNativePoolCapacityWindow, signal: AbortSignal): Promise<void>;
}
export interface RemoteWorkerInstallationSession {
  readonly signal: AbortSignal;
  /** Span the native operation through its verified terminal receipt. Use
   * reservation.finish to authorize the final acknowledgement and join shutdown
   * inside this scope. Publish the canonical outcome only after run() returns. */
  runCapture<T>(
    responseHex: string,
    binding: RemoteWorkerInstallCapacityBinding,
    operation: (reservation: RemoteWorkerInstallationReservation) => Promise<T>,
  ): Promise<T>;
}
type Registration = RemoteWorkerCellCapacityAuthority & {
  readonly nonce: string;
  readonly requestSha256: string;
  readonly window: RemoteWorkerNativePoolCapacityWindow;
  readonly referencesJson: string;
  readonly wallLimitMs: number;
  readonly signal: AbortSignal;
};
const refused = () => new Error("Installation session requires its registered live endpoint and exact capture.");

/** Scoped, process-local registration. Independent native evidence is retained
 * before response ingestion; an incoming response cannot choose its window,
 * references, assignment, installation, or connection. No reconnect or replay. */
export class RemoteWorkerInstallationSessionOwner {
  private readonly endpoints = new WeakMap<RemoteWorkerInstallationEndpoint, () => void>();
  private readonly assignments = new Set<string>();
  constructor(
    private readonly reservations: Pick<RemoteWorkerInstallationCapacityOwner, "run">,
    private readonly storage?: Pick<AsyncStorage, "remoteWorkerRuntimeInstalls">,
  ) {}

  /** Resolve the controller pin and assignment binding from canonical storage.
   * The transport carries challenges/proofs only; it cannot enroll a key or
   * replace the approval. run() authenticates the complete candidate window
   * before exposing a session or allowing capacity admission. */
  async runSigned<T>(
    input: Registration,
    transport: ControllerAttestationTransport,
    operation: (session: RemoteWorkerInstallationSession) => Promise<T>,
  ): Promise<T> {
    if (!this.storage) throw refused();
    const command = Object.freeze({
      ...snapshotRemoteWorkerCellCapacityAuthority(input),
      nonce: input.nonce,
      requestSha256: input.requestSha256,
    });
    const window = normalizeRemoteWorkerNativePoolCapacityWindow(input.window);
    const wallLimitMs = input.wallLimitMs,
      referencesJson = input.referencesJson;
    if (!Number.isSafeInteger(wallLimitMs) || wallLimitMs < 1 || wallLimitMs > 60000) throw refused();
    const deadline = performance.now() + wallLimitMs;
    const repository = this.storage.remoteWorkerRuntimeInstalls;
    const signal = AbortSignal.any([input.signal, transport.signal, AbortSignal.timeout(wallLimitMs)]);
    signal.throwIfAborted();
    const enrollment = await awaitControllerAuthority(
      () => repository.readControllerEnrollmentForAssignment(command),
      signal,
    );
    signal.throwIfAborted();
    const baseline = await awaitControllerAuthority(
      () => repository.readPoolAdmissionMaterialForAssignment(command),
      signal,
    );
    signal.throwIfAborted();
    if (
      remoteWorkerCellCanonicalSha256(baseline.pool) !== window.poolSnapshotSha256 ||
      baseline.request.nonce !== command.nonce ||
      baseline.requestSha256 !== command.requestSha256
    )
      throw refused();
    const baselineSha256 = remoteWorkerCellCanonicalSha256(baseline);
    const endpoint = createControllerSignedInstallationEndpoint(
      {
        ...enrollment,
        authoritySha256: baseline.history.plan.assignmentBindingSha256,
        connectionNonceHex: window.connectionNonceHex,
        installationNonce: command.nonce,
        requestSha256: command.requestSha256,
      },
      transport,
      async (current) => {
        current.throwIfAborted();
        const pin = await repository.readControllerEnrollmentForAssignment(command);
        current.throwIfAborted();
        if (canonicalJsonString(pin) !== canonicalJsonString(enrollment)) throw refused();
        const material = await repository.readPoolAdmissionMaterialForAssignment(command);
        current.throwIfAborted();
        if (remoteWorkerCellCanonicalSha256(material) !== baselineSha256) throw refused();
      },
    );
    const remainingMs = Math.floor(deadline - performance.now());
    if (remainingMs < 1) throw refused();
    return this.run({ ...command, window, referencesJson, wallLimitMs: remainingMs, signal }, endpoint, operation);
  }

  async run<T>(
    input: Registration,
    endpoint: RemoteWorkerInstallationEndpoint,
    operation: (session: RemoteWorkerInstallationSession) => Promise<T>,
  ): Promise<T> {
    const command = Object.freeze({
      ...snapshotRemoteWorkerCellCapacityAuthority(input),
      nonce: input.nonce,
      requestSha256: input.requestSha256,
    });
    const window = normalizeRemoteWorkerNativePoolCapacityWindow(input.window),
      referencesJson = input.referencesJson,
      wallLimitMs = input.wallLimitMs;
    if (
      ![command.nonce, command.requestSha256].every(
        (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) && !/^0+$/u.test(value),
      ) ||
      !Number.isSafeInteger(wallLimitMs) ||
      wallLimitMs < 1 ||
      wallLimitMs > 60000 ||
      typeof referencesJson !== "string" ||
      Buffer.byteLength(referencesJson, "utf8") > REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES ||
      !endpoint ||
      typeof endpoint.verify !== "function"
    )
      throw refused();
    const references: unknown = JSON.parse(referencesJson);
    if (
      !Array.isArray(references) ||
      references.length > 20000 ||
      remoteWorkerCellCanonicalSha256(references) !== window.referencesSha256
    )
      throw refused();
    const endpointSignal = endpoint.signal,
      connectionNonceHex = endpoint.connectionNonceHex;
    if (connectionNonceHex !== window.connectionNonceHex) throw refused();
    input.signal.throwIfAborted();
    endpointSignal.throwIfAborted();
    const previous = this.endpoints.get(endpoint);
    if (previous) {
      previous();
      throw refused();
    }
    const key = canonicalJsonString([command.registryWorkspaceId, command.assignmentId, command.assignmentGeneration]);
    if (this.assignments.has(key)) throw refused();
    const stop = new AbortController(),
      deadline = performance.now() + wallLimitMs;
    const signal = AbortSignal.any([input.signal, endpointSignal, stop.signal, AbortSignal.timeout(wallLimitMs)]);
    const verifyEndpoint = endpoint.verify.bind(endpoint);
    let open = true,
      accepting = false,
      consumed = false,
      captureComplete = false;
    let terminalComplete = false;
    let pending: Promise<unknown> | undefined;
    const close = () => {
      open = accepting = false;
      if (!stop.signal.aborted) stop.abort();
    };
    const control = () => {
      signal.throwIfAborted();
      if (
        !open ||
        performance.now() >= deadline ||
        endpoint.connectionNonceHex !== connectionNonceHex ||
        endpoint.signal !== endpointSignal
      )
        throw refused();
    };
    const verify = async () => {
      control();
      await verifyEndpoint(window, signal);
      control();
    };
    this.endpoints.set(endpoint, close);
    this.assignments.add(key);
    const session: RemoteWorkerInstallationSession = Object.freeze({
      signal,
      runCapture: <R>(
        responseHex: string,
        supplied: RemoteWorkerInstallCapacityBinding,
        work: (reservation: RemoteWorkerInstallationReservation) => Promise<R>,
      ): Promise<R> => {
        if (!accepting || consumed) {
          close();
          return Promise.reject(refused());
        }
        consumed = true;
        pending = (async () => {
          try {
            control();
            const binding = normalizeRemoteWorkerInstallCapacityBinding(supplied);
            const capture = snapshotRuntimeInstallPoolCapture({ responseHex, binding, window, referencesJson });
            if (
              binding.connectionNonceHex !== window.connectionNonceHex ||
              binding.installationNonce !== command.nonce ||
              binding.requestSha256 !== command.requestSha256 ||
              binding.byteLength !== responseHex.length / 2 ||
              binding.captureSha256 !== hashRemoteWorkerInstallCapacityCapture(Buffer.from(responseHex, "hex"))
            )
              throw refused();
            await verify();
            const remainingMs = Math.floor(deadline - performance.now());
            if (remainingMs < 1) throw refused();
            const result = await this.reservations.run(
              {
                ...command,
                capture,
                signal,
                wallLimitMs: remainingMs,
                window: {
                  verify: async (current) => {
                    if (canonicalJsonString(current) !== canonicalJsonString(binding)) throw refused();
                    await verify();
                  },
                },
              },
              (reservation) =>
                work(
                  Object.freeze({
                    ...reservation,
                    finish: async <R>(join: () => Promise<R>): Promise<R> => {
                      const result = await reservation.finish(join);
                      control();
                      terminalComplete = true;
                      return result;
                    },
                  }),
                ),
            );
            control();
            captureComplete = true;
            return result;
          } catch (error) {
            close();
            throw error;
          }
        })();
        return pending as Promise<R>;
      },
    });
    try {
      await verify();
      accepting = true;
      const result = await operation(session);
      accepting = false;
      if (!captureComplete) throw refused();
      if (terminalComplete) control();
      else await verify();
      return result;
    } finally {
      close();
      await pending?.catch(() => {
        /* Join cleanup; preserve the owning operation's failure. */
      });
      this.assignments.delete(key);
    }
  }
}
