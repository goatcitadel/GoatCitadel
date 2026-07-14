import type { LookupAddress } from "node:dns";
import { createConnection, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startBrowserEgressProxy, type BrowserEgressProxy } from "./browser-egress-proxy.js";
import type { DnsLookupFunction } from "./sandbox/network-guard.js";

const openProxies = new Set<BrowserEgressProxy>();
const openServers = new Set<Server>();
const openSockets = new Set<Socket>();

afterEach(async () => {
  for (const socket of openSockets) {
    socket.destroy();
  }
  openSockets.clear();
  await Promise.all([...openProxies].map((proxy) => proxy.close()));
  openProxies.clear();
  await Promise.all([...openServers].map((server) => closeServer(server)));
  openServers.clear();
});

describe("browser egress proxy", () => {
  it("blocks a public hostname whose guarded DNS answer is metadata/private", async () => {
    const dnsLookup = lookupReturning([{ address: "169.254.169.254", family: 4 }]);
    const proxy = await startProxy({ allowlist: ["public.example"], dnsLookup });

    const { socket, reply } = await socksConnect(proxy, domainRequest("public.example", 443));

    expect(reply[1]).toBe(0x02);
    socket.destroy();
  });

  it("rejects an entire DNS answer set when any answer is private", async () => {
    const dnsLookup = lookupReturning([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    const proxy = await startProxy({ allowlist: ["mixed.example"], dnsLookup });

    const { socket, reply } = await socksConnect(proxy, domainRequest("mixed.example", 443));

    expect(reply[1]).toBe(0x02);
    socket.destroy();
  });

  it("resolves each connection once and blocks a later changed private answer", async () => {
    const upstream = await startEchoServer();
    const upstreamPort = (upstream.address() as AddressInfo).port;
    let lookupCount = 0;
    const dnsLookup: DnsLookupFunction = (_hostname, options, callback) => {
      lookupCount += 1;
      const answer = lookupCount === 1 ? "127.0.0.1" : "169.254.169.254";
      if (options.all) {
        callback(null, [{ address: answer, family: 4 }]);
      } else {
        callback(null, answer, 4);
      }
    };
    const proxy = await startProxy({ allowlist: ["localhost"], dnsLookup });

    const first = await socksConnect(proxy, domainRequest("localhost", upstreamPort));
    expect(first.reply[1]).toBe(0x00);
    first.socket.write("first-pinned-connection");
    expect((await readAtLeast(first.socket, "first-pinned-connection".length)).toString()).toBe(
      "first-pinned-connection",
    );
    first.socket.destroy();

    const second = await socksConnect(proxy, domainRequest("localhost", upstreamPort));
    expect(second.reply[1]).toBe(0x02);
    expect(lookupCount).toBe(2);
    second.socket.destroy();
  });

  it("honors an explicit loopback allowlist and pipes an IPv4 CONNECT", async () => {
    const upstream = await startEchoServer();
    const upstreamPort = (upstream.address() as AddressInfo).port;
    const proxy = await startProxy({ allowlist: ["127.0.0.1"] });

    const { socket, reply } = await socksConnect(proxy, ipv4Request([127, 0, 0, 1], upstreamPort));

    expect(reply[1]).toBe(0x00);
    socket.write("loopback-ok");
    expect((await readAtLeast(socket, "loopback-ok".length)).toString()).toBe("loopback-ok");
    socket.destroy();
  });

  it("honors an explicitly allowed IP literal encoded in SOCKS domain form", async () => {
    const upstream = await startEchoServer();
    const upstreamPort = (upstream.address() as AddressInfo).port;
    const proxy = await startProxy({ allowlist: ["127.0.0.1"] });

    // Chromium sends some IP-literal destinations using ATYP=DOMAIN. The
    // egress policy, rather than the SOCKS wire encoding, remains authoritative.
    const { socket, reply } = await socksConnect(proxy, domainRequest("127.0.0.1", upstreamPort));

    expect(reply[1]).toBe(0x00);
    socket.write("domain-encoded-loopback-ok");
    expect((await readAtLeast(socket, "domain-encoded-loopback-ok".length)).toString()).toBe(
      "domain-encoded-loopback-ok",
    );
    socket.destroy();
  });

  it("blocks direct private IPv4 and IPv6 targets even under a wildcard", async () => {
    const proxy = await startProxy({ allowlist: ["*"] });

    const ipv4 = await socksConnect(proxy, ipv4Request([169, 254, 169, 254], 80));
    const ipv6 = await socksConnect(proxy, ipv6Request([0xfd, 0x00], 80));
    const domainEncodedLoopback = await socksConnect(proxy, domainRequest("127.0.0.1", 80));

    expect(ipv4.reply[1]).toBe(0x02);
    expect(ipv6.reply[1]).toBe(0x02);
    expect(domainEncodedLoopback.reply[1]).toBe(0x02);
    ipv4.socket.destroy();
    ipv6.socket.destroy();
    domainEncodedLoopback.socket.destroy();
  });

  it("supports CONNECT only", async () => {
    const proxy = await startProxy({ allowlist: ["example.com"] });
    const bindRequest = domainRequest("example.com", 443);
    bindRequest[1] = 0x02;

    const { socket, reply } = await socksConnect(proxy, bindRequest);

    expect(reply[1]).toBe(0x07);
    socket.destroy();
  });

  it("bounds concurrent clients and oversized handshakes", async () => {
    const proxy = await startProxy({ allowlist: ["example.com"], maxConnections: 1 });
    const held = await connectToProxy(proxy);
    const rejected = await connectToProxy(proxy);

    await expectSocketClose(rejected);
    held.write(Buffer.alloc(1_025, 0x05));
    const failure = await readAtLeast(held, 10);
    expect(failure[1]).toBe(0x01);
    held.destroy();
  });

  it("closes clients that do not finish the SOCKS handshake in time", async () => {
    const proxy = await startProxy({ allowlist: ["example.com"], handshakeTimeoutMs: 250 });
    const held = await connectToProxy(proxy);

    await expectSocketClose(held);
  });

  it("stops accepting connections and destroys open clients on abort", async () => {
    const controller = new AbortController();
    const proxy = await startProxy({ allowlist: ["example.com"], signal: controller.signal });
    const held = await connectToProxy(proxy);
    const port = new URL(proxy.serverUrl).port;
    const closed = expectSocketClose(held);

    controller.abort();
    await closed;
    await proxy.close();

    await expect(connectRaw(Number(port))).rejects.toThrow();
  });
});

async function startProxy(options: Parameters<typeof startBrowserEgressProxy>[0]): Promise<BrowserEgressProxy> {
  const proxy = await startBrowserEgressProxy(options);
  openProxies.add(proxy);
  return proxy;
}

async function startEchoServer(): Promise<Server> {
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    socket.pipe(socket);
  });
  openServers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

function lookupReturning(addresses: LookupAddress[]): DnsLookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, addresses);
      return;
    }
    const first = addresses[0];
    callback(null, first?.address ?? "", first?.family);
  };
}

async function socksConnect(proxy: BrowserEgressProxy, request: Buffer): Promise<{ socket: Socket; reply: Buffer }> {
  const socket = await connectToProxy(proxy);
  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  expect([...(await readAtLeast(socket, 2))]).toEqual([0x05, 0x00]);
  socket.write(request);
  return { socket, reply: await readAtLeast(socket, 10) };
}

async function connectToProxy(proxy: BrowserEgressProxy): Promise<Socket> {
  const url = new URL(proxy.serverUrl);
  const socket = await connectRaw(Number(url.port));
  openSockets.add(socket);
  socket.once("close", () => openSockets.delete(socket));
  return socket;
}

function connectRaw(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.removeListener("error", reject);
      socket.on("error", () => undefined);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

function readAtLeast(socket: Socket, byteCount: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const timeout = setTimeout(() => finish(new Error(`Timed out waiting for ${byteCount} proxy bytes.`)), 3_000);
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= byteCount) {
        finish(undefined, received);
      }
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error("Proxy socket closed before the expected response."));
    const finish = (error?: Error, value?: Buffer) => {
      clearTimeout(timeout);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      if (error) {
        reject(error);
      } else {
        resolve(value ?? Buffer.alloc(0));
      }
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function expectSocketClose(socket: Socket): Promise<void> {
  if (socket.destroyed) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Expected proxy client to close.")), 3_000);
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function domainRequest(hostname: string, port: number): Buffer {
  const host = Buffer.from(hostname, "ascii");
  const request = Buffer.alloc(7 + host.length);
  request.set([0x05, 0x01, 0x00, 0x03, host.length], 0);
  host.copy(request, 5);
  request.writeUInt16BE(port, 5 + host.length);
  return request;
}

function ipv4Request(octets: [number, number, number, number], port: number): Buffer {
  const request = Buffer.alloc(10);
  request.set([0x05, 0x01, 0x00, 0x01, ...octets], 0);
  request.writeUInt16BE(port, 8);
  return request;
}

function ipv6Request(prefix: [number, number], port: number): Buffer {
  const request = Buffer.alloc(22);
  request.set([0x05, 0x01, 0x00, 0x04, ...prefix], 0);
  request.writeUInt16BE(port, 20);
  return request;
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
