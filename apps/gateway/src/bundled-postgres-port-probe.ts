import net from "node:net";

/**
 * Reports whether something accepts a TCP connection on the port. Resolves
 * false on refusal, any error or a timeout; it never throws and never holds
 * the connection open.
 */
export function tcpPortAcceptsConnections(port: number, host = "127.0.0.1", timeoutMs = 1_000): Promise<boolean> {
  return probeBundledPostgresTcpPort(port, host, timeoutMs).then((state) => state === "accepting");
}

export function probeBundledPostgresTcpPort(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 1_000,
): Promise<"accepting" | "refused" | "unknown"> {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      resolve("unknown");
      return;
    }
    let settled = false;
    const socket = new net.Socket();
    const finish = (result: "accepting" | "refused" | "unknown") => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish("accepting"));
    socket.once("timeout", () => finish("unknown"));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(error.code === "ECONNREFUSED" ? "refused" : "unknown"),
    );
    try {
      socket.connect(port, host);
    } catch {
      finish("unknown");
    }
  });
}
