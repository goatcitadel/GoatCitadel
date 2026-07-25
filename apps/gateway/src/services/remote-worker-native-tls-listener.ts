import { constants as cryptoConstants, X509Certificate } from "node:crypto";
import { createServer, type Server as HttpsServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { TLSSocket } from "node:tls";
import type { RemoteWorkerRuntimeConfig } from "./remote-worker-runtime-config.js";
import {
  REMOTE_WORKER_TLS_EXPORTER_BYTES,
  REMOTE_WORKER_TLS_EXPORTER_LABEL,
  deriveRemoteWorkerTransportIdentityFromPort,
  type RemoteWorkerTlsSocketPort,
  type RemoteWorkerTransportIdentity,
} from "./remote-worker-transport-identity.js";
import { loadRemoteWorkerTrustMaterial, type RemoteWorkerTrustMaterial } from "./remote-worker-trust-material.js";

export const REMOTE_WORKER_NATIVE_TLS_LIMITS = Object.freeze({
  handshakeTimeoutMs: 5_000,
  headersTimeoutMs: 5_000,
  requestTimeoutMs: 10_000,
  socketTimeoutMs: 15_000,
  closeTimeoutMs: 5_000,
  maxHeaders: 32,
  maxHeaderBytes: 16 * 1024,
  maxConnections: 64,
});

const UNAVAILABLE_BODY = Buffer.from('{"error":"REMOTE_WORKER_UNAVAILABLE"}\n', "utf8");
const socketAdapters = new WeakMap<TLSSocket, RemoteWorkerTlsSocketPort>();
const requestAuthorities = new WeakMap<IncomingMessage, object>();

interface SecureSocketState {
  readonly socket: TLSSocket;
  readonly exporter: Buffer;
  readonly certificateChain: readonly Buffer[];
  readonly requests: Set<IncomingMessage>;
  headerDeadline?: ReturnType<typeof setTimeout>;
  requestDeadline?: ReturnType<typeof setTimeout>;
  connectionDeadline?: ReturnType<typeof setTimeout>;
  requestAccepted: boolean;
  revoked: boolean;
}

export interface RemoteWorkerNativeTlsListenerHandle {
  readonly enabled: boolean;
  readonly address?: string;
  close(): Promise<void>;
}

export class RemoteWorkerNativeTlsListenerError extends Error {
  readonly code = "REMOTE_WORKER_NATIVE_TLS_LISTENER_UNAVAILABLE";

  constructor(message: string) {
    super(message);
    this.name = "RemoteWorkerNativeTlsListenerError";
  }
}

export async function startRemoteWorkerNativeTlsListener(
  config: RemoteWorkerRuntimeConfig,
): Promise<RemoteWorkerNativeTlsListenerHandle> {
  if (!config.enabled) return disabledHandle();
  const enabledConfig = config;

  let trust: RemoteWorkerTrustMaterial | undefined;
  let server: HttpsServer | undefined;
  const rawSockets = new Set<Socket>();
  const secureStates = new Map<TLSSocket, SecureSocketState>();
  let closing = false;
  let closePromise: Promise<void> | undefined;

  const revokeRequest = (request: IncomingMessage, state?: SecureSocketState): void => {
    requestAuthorities.delete(request);
    state?.requests.delete(request);
  };
  const revokeSocket = (state: SecureSocketState): void => {
    if (state.revoked) return;
    state.revoked = true;
    clearDeadline(state.headerDeadline);
    clearDeadline(state.requestDeadline);
    clearDeadline(state.connectionDeadline);
    state.headerDeadline = undefined;
    state.requestDeadline = undefined;
    state.connectionDeadline = undefined;
    socketAdapters.delete(state.socket);
    for (const request of state.requests) requestAuthorities.delete(request);
    state.requests.clear();
    state.exporter.fill(0);
    for (const certificate of state.certificateChain) certificate.fill(0);
    secureStates.delete(state.socket);
  };

  try {
    trust = await loadRemoteWorkerTrustMaterial(enabledConfig);
    const tlsMaterial = trust.tlsServerOptions();
    const clientCaDer = new X509Certificate(tlsMaterial.ca).raw;
    try {
      server = createServer(
        {
          cert: tlsMaterial.cert,
          key: tlsMaterial.key,
          ca: tlsMaterial.ca,
          minVersion: "TLSv1.3",
          maxVersion: "TLSv1.3",
          requestCert: true,
          rejectUnauthorized: true,
          secureOptions: cryptoConstants.SSL_OP_NO_TICKET,
          handshakeTimeout: REMOTE_WORKER_NATIVE_TLS_LIMITS.handshakeTimeoutMs,
          honorCipherOrder: true,
          maxHeaderSize: REMOTE_WORKER_NATIVE_TLS_LIMITS.maxHeaderBytes,
        },
        (request, response) => {
          handleRequest(request, response);
        },
      );
    } finally {
      tlsMaterial.dispose();
    }
    const ownedServer = server;
    ownedServer.maxConnections = REMOTE_WORKER_NATIVE_TLS_LIMITS.maxConnections;
    // Node's built-in count/request limits can emit their own 408/503 bodies. Keep them disabled
    // and enforce the same frozen bounds by destroying the exact owned socket below.
    ownedServer.maxHeadersCount = 0;
    ownedServer.maxRequestsPerSocket = 0;
    ownedServer.headersTimeout = 0;
    ownedServer.requestTimeout = 0;
    ownedServer.keepAliveTimeout = 1;

    ownedServer.on("connection", (socket) => {
      const rawSocket = socket as Socket;
      if (closing) {
        rawSocket.destroy();
        return;
      }
      rawSockets.add(rawSocket);
      rawSocket.setTimeout(REMOTE_WORKER_NATIVE_TLS_LIMITS.handshakeTimeoutMs, () => rawSocket.destroy());
      rawSocket.once("close", () => rawSockets.delete(rawSocket));
      rawSocket.once("error", () => rawSockets.delete(rawSocket));
    });
    ownedServer.on("secureConnection", (socket) => {
      if (closing || secureStates.size >= REMOTE_WORKER_NATIVE_TLS_LIMITS.maxConnections) {
        socket.destroy();
        return;
      }
      let state: SecureSocketState | undefined;
      try {
        if (
          !socket.encrypted ||
          !socket.authorized ||
          (socket.authorizationError !== null && socket.authorizationError !== undefined)
        ) {
          throw unavailable();
        }
        const certificateChain = snapshotPeerCertificateChain(socket, clientCaDer, enabledConfig.tls.clientCaSha256);
        const exporter = socket.exportKeyingMaterial(
          REMOTE_WORKER_TLS_EXPORTER_BYTES,
          REMOTE_WORKER_TLS_EXPORTER_LABEL,
          Buffer.alloc(0),
        );
        if (!Buffer.isBuffer(exporter) || exporter.byteLength !== REMOTE_WORKER_TLS_EXPORTER_BYTES) {
          throw unavailable();
        }
        const stableExporter = Buffer.from(exporter);
        const adapter = createExactSocketAdapter(certificateChain, stableExporter);
        state = {
          socket,
          exporter: stableExporter,
          certificateChain,
          requests: new Set(),
          requestAccepted: false,
          revoked: false,
        };
        state.headerDeadline = destroyAtDeadline(socket, REMOTE_WORKER_NATIVE_TLS_LIMITS.headersTimeoutMs);
        state.connectionDeadline = destroyAtDeadline(socket, REMOTE_WORKER_NATIVE_TLS_LIMITS.socketTimeoutMs);
        socketAdapters.set(socket, adapter);
        secureStates.set(socket, state);
        socket.setTimeout(0);
        socket.once("close", () => revokeSocket(state as SecureSocketState));
        socket.once("error", () => revokeSocket(state as SecureSocketState));
      } catch {
        if (state !== undefined) revokeSocket(state);
        socket.destroy();
      }
    });
    ownedServer.on("tlsClientError", (_error, socket) => socket.destroy());
    ownedServer.on("clientError", (_error, socket) => socket.destroy());
    ownedServer.on("checkContinue", (request, response) => {
      request.destroy();
      response.destroy();
    });
    ownedServer.on("checkExpectation", (request, response) => {
      request.destroy();
      response.destroy();
    });
    ownedServer.on("connect", (_request, socket) => socket.destroy());
    ownedServer.on("upgrade", (_request, socket) => socket.destroy());
    ownedServer.on("error", () => {
      closing = true;
      for (const state of [...secureStates.values()]) {
        revokeSocket(state);
        state.socket.destroy();
      }
      for (const socket of rawSockets) socket.destroy();
      ownedServer.closeAllConnections();
    });

    function handleRequest(request: IncomingMessage, response: ServerResponse): void {
      const socket = request.socket as TLSSocket;
      const state = secureStates.get(socket);
      const adapter = socketAdapters.get(socket);
      if (
        closing ||
        state === undefined ||
        state.revoked ||
        state.requestAccepted ||
        adapter === undefined ||
        state.requests.size !== 0
      ) {
        response.destroy();
        socket.destroy();
        return;
      }
      if (request.rawHeaders.length / 2 > REMOTE_WORKER_NATIVE_TLS_LIMITS.maxHeaders) {
        response.destroy();
        socket.destroy();
        return;
      }
      request.pause();
      state.requestAccepted = true;
      clearDeadline(state.headerDeadline);
      state.headerDeadline = undefined;
      state.requestDeadline = destroyAtDeadline(socket, REMOTE_WORKER_NATIVE_TLS_LIMITS.requestTimeoutMs);
      state.requests.add(request);
      let revoked = false;
      const revoke = (): void => {
        if (revoked) return;
        revoked = true;
        clearDeadline(state.requestDeadline);
        state.requestDeadline = undefined;
        revokeRequest(request, state);
      };
      request.once("aborted", revoke);
      request.once("error", revoke);
      response.once("close", revoke);
      response.once("finish", revoke);
      let identity: RemoteWorkerTransportIdentity | undefined;
      try {
        identity = deriveRemoteWorkerTransportIdentityFromPort({
          socket: adapter,
          request: Object.freeze({
            rawPath: request.url ?? "",
            headers: Object.freeze({ ...request.headers }),
            rawHeaders: Object.freeze([...request.rawHeaders]),
          }),
          expectedClientCaSha256: enabledConfig.tls.clientCaSha256,
        });
        const authority = createRequestAuthority(identity);
        requestAuthorities.set(request, authority);
        if (!requestAuthorities.has(request)) throw unavailable();
        response.statusCode = 503;
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Retry-After", "60");
        response.setHeader("Connection", "close");
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.setHeader("Content-Length", String(UNAVAILABLE_BODY.byteLength));
        response.end(UNAVAILABLE_BODY, () => {
          revoke();
          socket.destroy();
        });
      } catch {
        revoke();
        response.destroy();
        socket.destroy();
      } finally {
        identity?.tlsExporter.fill(0);
      }
    }

    await listen(ownedServer, enabledConfig.host, enabledConfig.port);
    const boundAddress = renderAddress(ownedServer, enabledConfig.host, enabledConfig.port);
    const close = async (): Promise<void> => {
      if (closePromise !== undefined) return closePromise;
      closing = true;
      closePromise = closeOwnedServer(ownedServer, rawSockets, secureStates, revokeSocket).finally(() => {
        trust?.dispose();
      });
      return closePromise;
    };
    return Object.freeze(
      Object.assign(Object.create(null) as Record<string, unknown>, {
        enabled: true,
        address: boundAddress,
        close,
      }),
    ) as unknown as RemoteWorkerNativeTlsListenerHandle;
  } catch {
    closing = true;
    for (const state of secureStates.values()) {
      revokeSocket(state);
      state.socket.destroy();
    }
    for (const socket of rawSockets) socket.destroy();
    if (server !== undefined) {
      await closeOwnedServer(server, rawSockets, secureStates, revokeSocket).catch(() => undefined);
    }
    trust?.dispose();
    throw unavailable();
  }
}

function disabledHandle(): RemoteWorkerNativeTlsListenerHandle {
  const close = async (): Promise<void> => undefined;
  return Object.freeze(
    Object.assign(Object.create(null) as Record<string, unknown>, {
      enabled: false,
      close,
    }),
  ) as unknown as RemoteWorkerNativeTlsListenerHandle;
}

function createExactSocketAdapter(certificateChain: readonly Buffer[], exporter: Buffer): RemoteWorkerTlsSocketPort {
  return Object.freeze(
    Object.assign(Object.create(null) as Record<string, unknown>, {
      encrypted: true,
      authorized: true,
      authorizationError: undefined,
      peerCertificateChainDer: (): readonly Buffer[] =>
        Object.freeze(certificateChain.map((certificate) => Buffer.from(certificate))),
      exportKeyingMaterial: (length: number, label: string, context: Buffer): Buffer => {
        if (
          length !== REMOTE_WORKER_TLS_EXPORTER_BYTES ||
          label !== REMOTE_WORKER_TLS_EXPORTER_LABEL ||
          !Buffer.isBuffer(context) ||
          context.byteLength !== 0 ||
          exporter.every((value) => value === 0)
        ) {
          throw unavailable();
        }
        return exporter;
      },
    }),
  ) as unknown as RemoteWorkerTlsSocketPort;
}

function snapshotPeerCertificateChain(
  socket: TLSSocket,
  clientCaDer: Buffer,
  expectedClientCaSha256: string,
): readonly Buffer[] {
  const detailed = socket.getPeerCertificate(true);
  if (detailed === undefined || !Buffer.isBuffer(detailed.raw)) throw unavailable();
  const chain: Buffer[] = [];
  const seen = new Set<string>();
  let current = detailed;
  // `current` is never undefined here: the seed is guarded above and each
  // reassignment is gated by the `issuer === undefined` break below.
  while (Buffer.isBuffer(current.raw)) {
    if (current.raw.byteLength < 1 || current.raw.byteLength > 64 * 1024 || chain.length >= 16) throw unavailable();
    const certificate = Buffer.from(current.raw);
    const digest = sha256Hex(certificate);
    if (seen.has(digest)) break;
    seen.add(digest);
    chain.push(certificate);
    const issuer = current.issuerCertificate;
    if (issuer === undefined || issuer === current || !Buffer.isBuffer(issuer.raw)) break;
    current = issuer;
  }
  if (chain.length < 1) throw unavailable();
  if (sha256Hex(chain.at(-1) as Buffer) !== expectedClientCaSha256) {
    if (sha256Hex(clientCaDer) !== expectedClientCaSha256) throw unavailable();
    chain.push(Buffer.from(clientCaDer));
  }
  if (chain.length < 2 || chain.length > 16) throw unavailable();
  return Object.freeze(chain);
}

function createRequestAuthority(identity: RemoteWorkerTransportIdentity): object {
  return Object.freeze(
    Object.assign(Object.create(null) as Record<string, unknown>, {
      source: identity.source,
      certificateDerSha256: identity.certificateDerSha256,
      publicKeySpkiSha256: identity.publicKeySpkiSha256,
      trustAnchorDerSha256: identity.trustAnchorDerSha256,
      tlsExporterSha256: identity.tlsExporterSha256,
    }),
  );
}

async function listen(server: HttpsServer, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (): void => {
      server.off("listening", onListening);
      reject(unavailable());
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port, exclusive: true });
  });
}

async function closeOwnedServer(
  server: HttpsServer,
  rawSockets: Set<Socket>,
  secureStates: Map<TLSSocket, SecureSocketState>,
  revokeSocket: (state: SecureSocketState) => void,
): Promise<void> {
  for (const state of [...secureStates.values()]) {
    revokeSocket(state);
    state.socket.destroy();
  }
  for (const socket of rawSockets) socket.destroy();
  server.closeIdleConnections();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      for (const socket of rawSockets) socket.destroy();
      server.closeAllConnections();
      finish(server.listening ? unavailable() : undefined);
    }, REMOTE_WORKER_NATIVE_TLS_LIMITS.closeTimeoutMs);
    timer.unref();
    try {
      server.close(() => finish(server.listening ? unavailable() : undefined));
    } catch {
      finish(server.listening ? unavailable() : undefined);
    }
  });
}

function renderAddress(server: HttpsServer, fallbackHost: string, fallbackPort: number): string {
  const address = server.address();
  if (address !== null && typeof address === "object") return `${address.address}:${address.port}`;
  return `${fallbackHost}:${fallbackPort}`;
}

function sha256Hex(value: Buffer): string {
  return new X509Certificate(value).fingerprint256.replaceAll(":", "").toLowerCase();
}

function destroyAtDeadline(socket: Socket, timeoutMs: number): ReturnType<typeof setTimeout> {
  const deadline = setTimeout(() => socket.destroy(), timeoutMs);
  deadline.unref();
  return deadline;
}

function clearDeadline(deadline: ReturnType<typeof setTimeout> | undefined): void {
  if (deadline !== undefined) clearTimeout(deadline);
}

function unavailable(): RemoteWorkerNativeTlsListenerError {
  return new RemoteWorkerNativeTlsListenerError("Remote worker native TLS listener is unavailable.");
}
