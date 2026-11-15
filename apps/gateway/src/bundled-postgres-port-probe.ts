import net from "node:net";

/**
 * Reports whether something accepts a TCP connection on the port. Resolves
 * false on refusal, any error or a timeout; it never throws and never holds
 * the connection open.
 */
export function tcpPortAcceptsConnections(port: number, host = "127.0.0.1", timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      resolve(false);
      return;
    }
    let settled = false;
    const socket = new net.Socket();
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}
