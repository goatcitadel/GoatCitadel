import net from "node:net";
import { describe, expect, it } from "vitest";
import { tcpPortAcceptsConnections } from "./bundled-postgres-port-probe.js";

function listenOnFreePort(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as net.AddressInfo).port });
    });
  });
}

describe("tcpPortAcceptsConnections", () => {
  it("answers true while something listens and false after it closes", async () => {
    const { server, port } = await listenOnFreePort();
    await expect(tcpPortAcceptsConnections(port)).resolves.toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(tcpPortAcceptsConnections(port)).resolves.toBe(false);
  });

  it("answers false for an invalid port without throwing", async () => {
    await expect(tcpPortAcceptsConnections(0)).resolves.toBe(false);
  });
});
