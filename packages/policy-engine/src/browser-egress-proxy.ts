import type { LookupAddress, LookupOptions } from "node:dns";
import { createConnection, createServer, isIP, type Server, type Socket } from "node:net";
import { assertHostAllowed, createGuardedDnsLookup, type DnsLookupFunction } from "./sandbox/network-guard.js";

const LOOPBACK_BIND_HOST = "127.0.0.1";
const MAX_HANDSHAKE_BYTES = 1_024;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CONNECTIONS = 128;
const MAX_CONNECTIONS_LIMIT = 512;

const SOCKS_VERSION = 0x05;
const SOCKS_AUTH_NONE = 0x00;
const SOCKS_COMMAND_CONNECT = 0x01;
const SOCKS_ADDRESS_IPV4 = 0x01;
const SOCKS_ADDRESS_DOMAIN = 0x03;
const SOCKS_ADDRESS_IPV6 = 0x04;

const SOCKS_REPLY_SUCCEEDED = 0x00;
const SOCKS_REPLY_GENERAL_FAILURE = 0x01;
const SOCKS_REPLY_NOT_ALLOWED = 0x02;
const SOCKS_REPLY_COMMAND_UNSUPPORTED = 0x07;
const SOCKS_REPLY_ADDRESS_UNSUPPORTED = 0x08;

export interface BrowserEgressProxyOptions {
  allowlist: string[];
  additionalAllowlists?: string[][];
  signal?: AbortSignal;
  dnsLookup?: DnsLookupFunction;
  handshakeTimeoutMs?: number;
  connectTimeoutMs?: number;
  maxConnections?: number;
}

export interface BrowserEgressProxy {
  serverUrl: string;
  close: () => Promise<void>;
}

interface SocksTarget {
  hostname: string;
  port: number;
}

interface PinnedTarget {
  address: string;
  family: number;
}

interface ClientHandlerOptions {
  allowlist: string[];
  additionalAllowlists: string[][];
  dnsLookup?: DnsLookupFunction;
  handshakeTimeoutMs: number;
  connectTimeoutMs: number;
  isClosing: () => boolean;
  trackUpstream: (socket: Socket) => void;
}

/**
 * Starts a request-scoped SOCKS5 proxy for Chromium.
 *
 * Chromium resolves SOCKS5 domain targets at the proxy. This server applies
 * GoatCitadel's host allowlists, resolves the domain once through the shared
 * DNS rebinding guard, then dials the selected IP address directly. That pins
 * the checked DNS result to the connection instead of letting the browser or
 * socket layer perform a second resolution after policy evaluation.
 */
export async function startBrowserEgressProxy(options: BrowserEgressProxyOptions): Promise<BrowserEgressProxy> {
  if (options.signal?.aborted) {
    throw abortError();
  }

  const allowlist = [...options.allowlist];
  const additionalAllowlists = (options.additionalAllowlists ?? []).map((entries) => [...entries]);
  const handshakeTimeoutMs = boundedPositiveInt(options.handshakeTimeoutMs, DEFAULT_HANDSHAKE_TIMEOUT_MS, 250, 30_000);
  const connectTimeoutMs = boundedPositiveInt(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, 250, 120_000);
  const maxConnections = boundedPositiveInt(options.maxConnections, DEFAULT_MAX_CONNECTIONS, 1, MAX_CONNECTIONS_LIMIT);
  const clientSockets = new Set<Socket>();
  const upstreamSockets = new Set<Socket>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let runtimeErrorHandler: (() => void) | undefined;

  const server = createServer((socket) => {
    if (closing || clientSockets.size >= maxConnections) {
      socket.destroy();
      return;
    }
    clientSockets.add(socket);
    socket.once("close", () => clientSockets.delete(socket));
    socket.setNoDelay(true);
    handleSocksClient(socket, {
      allowlist,
      additionalAllowlists,
      dnsLookup: options.dnsLookup,
      handshakeTimeoutMs,
      connectTimeoutMs,
      isClosing: () => closing,
      trackUpstream: (upstream) => {
        upstreamSockets.add(upstream);
        upstream.once("close", () => upstreamSockets.delete(upstream));
      },
    });
  });

  const close = (): Promise<void> => {
    if (closePromise) {
      return closePromise;
    }
    closing = true;
    options.signal?.removeEventListener("abort", abortHandler);
    if (runtimeErrorHandler) {
      server.removeListener("error", runtimeErrorHandler);
    }
    const trackedSockets = [...new Set([...clientSockets, ...upstreamSockets])];
    const socketClosePromises = trackedSockets.map((socket) => waitForSocketClose(socket));
    for (const socket of trackedSockets) {
      forceCloseSocket(socket);
    }
    closePromise = Promise.all([closeServer(server), ...socketClosePromises]).then(() => undefined);
    return closePromise;
  };
  const abortHandler = () => {
    void close();
  };

  try {
    await listenOnLoopback(server);
    if (options.signal?.aborted) {
      await close();
      throw abortError();
    }
    runtimeErrorHandler = () => {
      void close();
    };
    server.on("error", runtimeErrorHandler);
    options.signal?.addEventListener("abort", abortHandler, { once: true });
    const address = server.address();
    if (!address || typeof address === "string") {
      await close();
      throw new Error("Browser egress proxy did not expose a loopback TCP address.");
    }
    return {
      serverUrl: `socks5://${LOOPBACK_BIND_HOST}:${address.port}`,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function handleSocksClient(socket: Socket, options: ClientHandlerOptions): void {
  let buffer = Buffer.alloc(0);
  let state: "greeting" | "request" | "connecting" | "closed" = "greeting";
  const handshakeTimeout = setTimeout(() => {
    state = "closed";
    socket.destroy();
  }, options.handshakeTimeoutMs);
  handshakeTimeout.unref();

  const finishHandshake = () => {
    clearTimeout(handshakeTimeout);
  };
  socket.once("close", finishHandshake);
  socket.once("error", () => undefined);

  const fail = (replyCode: number) => {
    if (state === "closed") {
      return;
    }
    state = "closed";
    finishHandshake();
    if (socket.destroyed) {
      return;
    }
    socket.end(createSocksReply(replyCode));
  };

  const onData = (chunk: Buffer) => {
    if (state === "closed" || state === "connecting") {
      return;
    }
    if (buffer.length + chunk.length > MAX_HANDSHAKE_BYTES) {
      fail(SOCKS_REPLY_GENERAL_FAILURE);
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);

    while (state === "greeting" || state === "request") {
      if (state === "greeting") {
        if (buffer.length < 2) {
          return;
        }
        const methodCount = buffer[1] ?? 0;
        const greetingBytes = 2 + methodCount;
        if (buffer.length < greetingBytes) {
          return;
        }
        if (buffer[0] !== SOCKS_VERSION || !buffer.subarray(2, greetingBytes).includes(SOCKS_AUTH_NONE)) {
          state = "closed";
          finishHandshake();
          socket.end(Buffer.from([SOCKS_VERSION, 0xff]));
          return;
        }
        buffer = buffer.subarray(greetingBytes);
        state = "request";
        socket.write(Buffer.from([SOCKS_VERSION, SOCKS_AUTH_NONE]));
        continue;
      }

      const parsed = parseSocksRequest(buffer);
      if (parsed.status === "incomplete") {
        return;
      }
      if (parsed.status === "rejected") {
        fail(parsed.replyCode);
        return;
      }
      buffer = buffer.subarray(parsed.bytesConsumed);
      state = "connecting";
      socket.pause();
      finishHandshake();
      socket.removeListener("data", onData);
      connectPinnedTarget(socket, parsed.target, buffer, options, fail);
      return;
    }
  };

  socket.on("data", onData);
}

function parseSocksRequest(
  buffer: Buffer,
):
  | { status: "incomplete" }
  | { status: "rejected"; replyCode: number }
  | { status: "accepted"; target: SocksTarget; bytesConsumed: number } {
  if (buffer.length < 4) {
    return { status: "incomplete" };
  }
  if (buffer[0] !== SOCKS_VERSION || buffer[2] !== 0x00) {
    return { status: "rejected", replyCode: SOCKS_REPLY_GENERAL_FAILURE };
  }
  if (buffer[1] !== SOCKS_COMMAND_CONNECT) {
    return { status: "rejected", replyCode: SOCKS_REPLY_COMMAND_UNSUPPORTED };
  }

  const addressType = buffer[3];
  let hostname: string;
  let addressEnd: number;
  if (addressType === SOCKS_ADDRESS_IPV4) {
    addressEnd = 8;
    if (buffer.length < addressEnd + 2) {
      return { status: "incomplete" };
    }
    hostname = Array.from(buffer.subarray(4, addressEnd)).join(".");
  } else if (addressType === SOCKS_ADDRESS_DOMAIN) {
    if (buffer.length < 5) {
      return { status: "incomplete" };
    }
    const hostnameLength = buffer[4] ?? 0;
    if (hostnameLength === 0) {
      return { status: "rejected", replyCode: SOCKS_REPLY_ADDRESS_UNSUPPORTED };
    }
    addressEnd = 5 + hostnameLength;
    if (buffer.length < addressEnd + 2) {
      return { status: "incomplete" };
    }
    hostname = buffer.subarray(5, addressEnd).toString("ascii");
    if (!isSafeDomainTarget(hostname)) {
      return { status: "rejected", replyCode: SOCKS_REPLY_ADDRESS_UNSUPPORTED };
    }
  } else if (addressType === SOCKS_ADDRESS_IPV6) {
    addressEnd = 20;
    if (buffer.length < addressEnd + 2) {
      return { status: "incomplete" };
    }
    hostname = formatIpv6Address(buffer.subarray(4, addressEnd));
  } else {
    return { status: "rejected", replyCode: SOCKS_REPLY_ADDRESS_UNSUPPORTED };
  }

  const port = buffer.readUInt16BE(addressEnd);
  if (port === 0 || (isIP(hostname) === 0 && addressType !== SOCKS_ADDRESS_DOMAIN)) {
    return { status: "rejected", replyCode: SOCKS_REPLY_ADDRESS_UNSUPPORTED };
  }
  return {
    status: "accepted",
    target: { hostname, port },
    bytesConsumed: addressEnd + 2,
  };
}

function connectPinnedTarget(
  client: Socket,
  target: SocksTarget,
  bufferedPayload: Buffer,
  options: ClientHandlerOptions,
  fail: (replyCode: number) => void,
): void {
  let policyUrl: string;
  try {
    policyUrl = targetPolicyUrl(target);
    assertHostAllowed(policyUrl, options.allowlist);
    for (const additionalAllowlist of options.additionalAllowlists) {
      if (additionalAllowlist.length > 0) {
        assertHostAllowed(policyUrl, additionalAllowlist);
      }
    }
  } catch {
    fail(SOCKS_REPLY_NOT_ALLOWED);
    return;
  }

  let settled = false;
  let upstream: Socket | undefined;
  const connectTimeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      if (upstream) {
        forceCloseSocket(upstream);
      }
      fail(SOCKS_REPLY_GENERAL_FAILURE);
    }
  }, options.connectTimeoutMs);
  connectTimeout.unref();
  client.once("close", () => {
    settled = true;
    clearTimeout(connectTimeout);
    if (upstream) {
      forceCloseSocket(upstream);
    }
  });

  void resolvePinnedTarget(target.hostname, policyUrl, options.allowlist, options.dnsLookup)
    .then((resolved) => {
      if (settled || client.destroyed || options.isClosing()) {
        return;
      }
      const connectedSocket = createConnection({
        host: resolved.address,
        port: target.port,
        family: resolved.family === 4 || resolved.family === 6 ? resolved.family : undefined,
      });
      upstream = connectedSocket;
      options.trackUpstream(connectedSocket);
      connectedSocket.setNoDelay(true);
      connectedSocket.once("close", () => {
        if (!client.destroyed) {
          forceCloseSocket(client);
        }
      });
      connectedSocket.once("error", () => {
        if (!settled) {
          settled = true;
          clearTimeout(connectTimeout);
          fail(SOCKS_REPLY_GENERAL_FAILURE);
        }
      });
      connectedSocket.once("connect", () => {
        if (settled || client.destroyed || options.isClosing()) {
          forceCloseSocket(connectedSocket);
          return;
        }
        settled = true;
        clearTimeout(connectTimeout);
        client.write(createSocksReply(SOCKS_REPLY_SUCCEEDED));
        if (bufferedPayload.length > 0) {
          connectedSocket.write(bufferedPayload);
        }
        client.pipe(connectedSocket);
        connectedSocket.pipe(client);
        client.resume();
      });
    })
    .catch(() => {
      if (!settled) {
        settled = true;
        clearTimeout(connectTimeout);
        fail(SOCKS_REPLY_NOT_ALLOWED);
      }
    });
}

async function resolvePinnedTarget(
  hostname: string,
  policyUrl: string,
  allowlist: string[],
  dnsLookup?: DnsLookupFunction,
): Promise<PinnedTarget> {
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    return { address: hostname, family: literalFamily };
  }

  const guardedLookup = createGuardedDnsLookup(policyUrl, allowlist, dnsLookup);
  return new Promise<PinnedTarget>((resolve, reject) => {
    const lookupOptions: LookupOptions = { all: true, verbatim: true };
    guardedLookup(hostname, lookupOptions, (error, address, family) => {
      if (error) {
        reject(error);
        return;
      }
      const selected = selectResolvedAddress(address, family);
      if (!selected) {
        reject(new Error("Browser egress target did not resolve to an IP address."));
        return;
      }
      resolve(selected);
    });
  });
}

function selectResolvedAddress(address: string | LookupAddress[], family?: number): PinnedTarget | undefined {
  const selected = Array.isArray(address) ? address[0] : { address, family: family ?? isIP(address) };
  if (!selected || (selected.family !== 4 && selected.family !== 6) || isIP(selected.address) !== selected.family) {
    return undefined;
  }
  return { address: selected.address, family: selected.family };
}

function targetPolicyUrl(target: SocksTarget): string {
  const authorityHost = isIP(target.hostname) === 6 ? `[${target.hostname}]` : target.hostname;
  return `https://${authorityHost}:${target.port}/`;
}

function isSafeDomainTarget(hostname: string): boolean {
  return hostname.length <= 253 && !hostname.includes("\0") && !/[\s/?#@\\]/.test(hostname);
}

function formatIpv6Address(bytes: Buffer): string {
  const groups: string[] = [];
  for (let offset = 0; offset < 16; offset += 2) {
    groups.push(bytes.readUInt16BE(offset).toString(16));
  }
  return groups.join(":");
}

function createSocksReply(replyCode: number): Buffer {
  return Buffer.from([SOCKS_VERSION, replyCode, 0x00, SOCKS_ADDRESS_IPV4, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
}

function boundedPositiveInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value!)));
}

function listenOnLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, LOOPBACK_BIND_HOST);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function waitForSocketClose(socket: Socket): Promise<void> {
  if (socket.closed) {
    return Promise.resolve();
  }
  return new Promise((resolve) => socket.once("close", resolve));
}

function forceCloseSocket(socket: Socket): void {
  if (socket.destroyed) {
    return;
  }
  if (socket.readyState === "open") {
    socket.resetAndDestroy();
    return;
  }
  socket.destroy();
}

function abortError(): Error {
  const error = new Error("Browser egress proxy start was aborted.");
  error.name = "AbortError";
  return error;
}
