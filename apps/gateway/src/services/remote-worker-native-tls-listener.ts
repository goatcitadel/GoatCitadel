import { constants as cryptoConstants, X509Certificate } from "node:crypto";
import { createServer, type Server as HttpsServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { TLSSocket } from "node:tls";
import type { RemoteWorkerRuntimeConfig } from "./remote-worker-runtime-config.js";
import { REMOTE_WORKER_PROTOCOL_MAX_BODY_BYTES } from "./remote-worker-protocol.js";
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
  maxProtocolBodyBytes: REMOTE_WORKER_PROTOCOL_MAX_BODY_BYTES,
  maxResponseBodyBytes: REMOTE_WORKER_PROTOCOL_MAX_BODY_BYTES,
  maxResponseHeaders: 16,
  maxResponseHeaderBytes: 8 * 1024,
  maxResponseHeaderNameBytes: 64,
  maxResponseHeaderValueBytes: 1024,
});

const UNAVAILABLE_BODY = Buffer.from('{"error":"REMOTE_WORKER_UNAVAILABLE"}\n', "utf8");
const REQUEST_FAILED_BODY = Buffer.from('{"error":"REMOTE_WORKER_REQUEST_FAILED"}\n', "utf8");
const socketAdapters = new WeakMap<TLSSocket, RemoteWorkerTlsSocketPort>();

const FORBIDDEN_HANDLER_RESPONSE_HEADERS = new Set([
  "cache-control",
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface RemoteWorkerNativeHandlerRequest {
  readonly method: "POST";
  readonly rawPath: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Ephemeral request bytes. The listener zeroes this buffer as soon as the handler settles or times out. */
  readonly bodyBytes: Buffer;
  /** Ephemeral transport authority, including exporter bytes used by the proof-of-possession verifier. */
  readonly transportIdentity: RemoteWorkerTransportIdentity;
}

export interface RemoteWorkerNativeHandlerResponse {
  readonly statusCode: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: string | Buffer | Uint8Array;
}

export type RemoteWorkerNativeRequestHandler = (
  request: RemoteWorkerNativeHandlerRequest,
) => Promise<RemoteWorkerNativeHandlerResponse> | RemoteWorkerNativeHandlerResponse;

interface SecureSocketState {
  readonly socket: TLSSocket;
  readonly exporter: Buffer;
  readonly certificateChain: readonly Buffer[];
  readonly requests: Set<IncomingMessage>;
  headerDeadline?: ReturnType<typeof setTimeout>;
  requestDeadline?: ReturnType<typeof setTimeout>;
  requestDeadlineAt?: number;
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
  handler?: RemoteWorkerNativeRequestHandler,
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
    state.requestDeadlineAt = undefined;
    state.connectionDeadline = undefined;
    socketAdapters.delete(state.socket);
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
          void handleRequest(request, response);
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

    async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
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
      if (request.method !== "POST") {
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
      state.requestDeadlineAt = Date.now() + REMOTE_WORKER_NATIVE_TLS_LIMITS.requestTimeoutMs;
      state.requests.add(request);
      let revoked = false;
      const revoke = (): void => {
        if (revoked) return;
        revoked = true;
        clearDeadline(state.requestDeadline);
        state.requestDeadline = undefined;
        state.requestDeadlineAt = undefined;
        revokeRequest(request, state);
      };
      request.once("aborted", revoke);
      request.once("error", revoke);
      response.once("close", revoke);
      response.once("finish", revoke);
      let identity: RemoteWorkerTransportIdentity | undefined;
      let bodyBytes: Buffer | undefined;
      let outgoing: NormalizedHandlerResponse | FixedResponse | undefined;
      let requestReady = false;
      try {
        const headers = normalizeRequestHeaders(request);
        const contentLength = inspectRequestEnvelope(request, headers);
        identity = deriveRemoteWorkerTransportIdentityFromPort({
          socket: adapter,
          request: Object.freeze({
            rawPath: request.url ?? "",
            headers,
            rawHeaders: Object.freeze([...request.rawHeaders]),
          }),
          expectedClientCaSha256: enabledConfig.tls.clientCaSha256,
        });
        bodyBytes = await readExactBody(request, contentLength, socket);
        if (socket.destroyed || state.revoked || state.requestDeadlineAt === undefined) throw unavailable();
        requestReady = true;
        if (handler === undefined) {
          outgoing = fixedResponse(503, UNAVAILABLE_BODY, { "retry-after": "60" });
        } else {
          const handlerRequest = createHandlerRequest(request.url ?? "", headers, bodyBytes, identity);
          const handlerResult = await invokeHandlerBeforeDeadline(handler, handlerRequest, state.requestDeadlineAt);
          outgoing = normalizeHandlerResponse(handlerResult);
        }
      } catch {
        if (requestReady && !socket.destroyed && !state.revoked && !response.headersSent) {
          outgoing = fixedResponse(500, REQUEST_FAILED_BODY);
        }
      } finally {
        bodyBytes?.fill(0);
        identity?.tlsExporter.fill(0);
      }
      if (outgoing === undefined || socket.destroyed || state.revoked) {
        outgoing?.dispose();
        revoke();
        response.destroy();
        socket.destroy();
        return;
      }
      try {
        await writeBoundedResponse(response, socket, outgoing);
      } finally {
        outgoing.dispose();
        revoke();
        socket.destroy();
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

interface NormalizedHandlerResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
  dispose(): void;
}

interface FixedResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
  dispose(): void;
}

function normalizeRequestHeaders(request: IncomingMessage): Readonly<Record<string, string>> {
  const normalized = Object.create(null) as Record<string, string>;
  for (const [rawName, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    const name = rawName.toLowerCase();
    if (name !== rawName || typeof value !== "string" || Object.hasOwn(normalized, name)) throw unavailable();
    normalized[name] = value;
  }
  return Object.freeze(normalized);
}

function inspectRequestEnvelope(request: IncomingMessage, headers: Readonly<Record<string, string>>): number {
  if (request.method !== "POST") throw unavailable();
  if (request.rawHeaders.some((value, index) => index % 2 === 0 && value.toLowerCase() === "transfer-encoding")) {
    throw unavailable();
  }
  if (headers["transfer-encoding"] !== undefined) throw unavailable();
  const contentType = headers["content-type"]?.trim().toLowerCase();
  if (contentType !== "application/json" && contentType !== "application/json; charset=utf-8") throw unavailable();
  const rawLength = headers["content-length"];
  if (rawLength === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(rawLength)) throw unavailable();
  const contentLength = Number(rawLength);
  if (
    !Number.isSafeInteger(contentLength) ||
    contentLength < 0 ||
    contentLength > REMOTE_WORKER_NATIVE_TLS_LIMITS.maxProtocolBodyBytes
  ) {
    throw unavailable();
  }
  return contentLength;
}

async function readExactBody(request: IncomingMessage, expectedLength: number, socket: TLSSocket): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const wipeChunks = (): void => {
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
    };
    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
    };
    const fail = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      wipeChunks();
      reject(unavailable());
    };
    const onData = (value: Buffer | string): void => {
      if (settled) return;
      const chunk = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, "utf8");
      chunks.push(chunk);
      received += chunk.byteLength;
      if (received > expectedLength || received > REMOTE_WORKER_NATIVE_TLS_LIMITS.maxProtocolBodyBytes) {
        fail();
        request.destroy();
        socket.destroy();
      }
    };
    const onEnd = (): void => {
      if (settled) return;
      if (received !== expectedLength || socket.destroyed) {
        fail();
        return;
      }
      settled = true;
      cleanup();
      try {
        const body = Buffer.concat(chunks, received);
        wipeChunks();
        resolve(body);
      } catch {
        wipeChunks();
        reject(unavailable());
      }
    };
    const onAborted = (): void => fail();
    const onError = (): void => fail();
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onError);
    request.resume();
  });
}

function createHandlerRequest(
  rawPath: string,
  headers: Readonly<Record<string, string>>,
  bodyBytes: Buffer,
  transportIdentity: RemoteWorkerTransportIdentity,
): RemoteWorkerNativeHandlerRequest {
  return Object.freeze(
    Object.assign(Object.create(null) as Record<string, unknown>, {
      method: "POST",
      rawPath,
      headers,
      bodyBytes,
      transportIdentity,
    }),
  ) as unknown as RemoteWorkerNativeHandlerRequest;
}

async function invokeHandlerBeforeDeadline(
  handler: RemoteWorkerNativeRequestHandler,
  request: RemoteWorkerNativeHandlerRequest,
  deadlineAt: number,
): Promise<RemoteWorkerNativeHandlerResponse> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw unavailable();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => handler(request)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(unavailable()), remainingMs);
        timer.unref();
      }),
    ]);
  } finally {
    clearDeadline(timer);
  }
}

function normalizeHandlerResponse(response: RemoteWorkerNativeHandlerResponse): NormalizedHandlerResponse {
  if (response === null || typeof response !== "object") throw unavailable();
  if (
    !Number.isInteger(response.statusCode) ||
    response.statusCode < 200 ||
    response.statusCode > 599 ||
    response.statusCode === 204 ||
    response.statusCode === 304
  ) {
    throw unavailable();
  }
  const headers = normalizeHandlerResponseHeaders(response.headers);
  const body = copyBoundedHandlerBody(response.body);
  return Object.freeze({
    statusCode: response.statusCode,
    headers,
    body,
    dispose: (): void => {
      body.fill(0);
    },
  });
}

function normalizeHandlerResponseHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  const normalized = Object.create(null) as Record<string, string>;
  if (headers === undefined) return Object.freeze(normalized);
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) throw unavailable();
  const entries = Object.entries(headers);
  if (entries.length > REMOTE_WORKER_NATIVE_TLS_LIMITS.maxResponseHeaders) throw unavailable();
  let totalBytes = 0;
  for (const [rawName, value] of entries) {
    const name = rawName.toLowerCase();
    if (
      name !== rawName ||
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(name) ||
      Buffer.byteLength(name, "utf8") > REMOTE_WORKER_NATIVE_TLS_LIMITS.maxResponseHeaderNameBytes ||
      FORBIDDEN_HANDLER_RESPONSE_HEADERS.has(name) ||
      Object.hasOwn(normalized, name) ||
      typeof value !== "string" ||
      /[\u0000-\u001f\u007f]/u.test(value) ||
      Buffer.byteLength(value, "utf8") > REMOTE_WORKER_NATIVE_TLS_LIMITS.maxResponseHeaderValueBytes
    ) {
      throw unavailable();
    }
    totalBytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8");
    if (totalBytes > REMOTE_WORKER_NATIVE_TLS_LIMITS.maxResponseHeaderBytes) throw unavailable();
    normalized[name] = value;
  }
  return Object.freeze(normalized);
}

function copyBoundedHandlerBody(value: string | Buffer | Uint8Array): Buffer {
  let byteLength: number;
  if (typeof value === "string") byteLength = Buffer.byteLength(value, "utf8");
  else if (Buffer.isBuffer(value) || value instanceof Uint8Array) byteLength = value.byteLength;
  else throw unavailable();
  if (byteLength > REMOTE_WORKER_NATIVE_TLS_LIMITS.maxResponseBodyBytes) throw unavailable();
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}

function fixedResponse(
  statusCode: number,
  body: Buffer,
  headers: Readonly<Record<string, string>> = Object.freeze(Object.create(null) as Record<string, string>),
): FixedResponse {
  return Object.freeze({ statusCode, headers: Object.freeze({ ...headers }), body, dispose: (): void => undefined });
}

async function writeBoundedResponse(
  response: ServerResponse,
  socket: TLSSocket,
  outgoing: NormalizedHandlerResponse | FixedResponse,
): Promise<void> {
  response.statusCode = outgoing.statusCode;
  response.shouldKeepAlive = false;
  for (const [name, value] of Object.entries(outgoing.headers)) response.setHeader(name, value);
  if (!response.hasHeader("content-type")) response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Connection", "close");
  response.setHeader("Content-Length", String(outgoing.body.byteLength));
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      response.off("error", finish);
      response.off("close", finish);
      resolve();
    };
    response.once("error", finish);
    response.once("close", finish);
    try {
      response.end(outgoing.body, finish);
    } catch {
      finish();
    }
  });
  socket.destroy();
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
