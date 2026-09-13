import { createInterface } from "node:readline";

/** Keep one terminal owner across the artifact-review sequence. API requests
 * between reviews must not close and reopen the inherited Windows input handle. */
export function createNativeComparisonReviewConsole({ input = process.stdin, output = process.stdout, signal } = {}) {
  assertNativeApprovalTerminal(input, output);
  signal?.throwIfAborted();
  const terminal = createInterface({ input, output, terminal: true });
  let busy = false,
    closed = false;
  terminal.once("close", () => {
    closed = true;
  });
  return {
    async review(value) {
      if (closed) throw new globalThis.DOMException("Native workflow review closed.", "AbortError");
      if (busy) throw new Error("A native artifact review is already pending.");
      busy = true;
      try {
        return await reviewNativeComparisonArtifact(value, { input, output, signal, terminal });
      } finally {
        busy = false;
      }
    },
    stop() {
      terminal.close();
    },
  };
}

export async function reviewNativeComparisonArtifact(
  { kind, material, sha256 },
  { input = process.stdin, output = process.stdout, signal, terminal: sharedTerminal } = {},
) {
  assertNativeApprovalTerminal(input, output);
  signal?.throwIfAborted();
  if (!["stage", "artifacts", "confirm"].includes(kind) || !/^[a-f0-9]{64}$/u.test(sha256))
    throw new Error("The native review requires an exact bounded action hash.");
  const encoded = JSON.stringify(material);
  if (Buffer.byteLength(encoded) > 256 * 1024) throw new Error("The native review exceeds the display bound.");
  const terminal = sharedTerminal ?? createInterface({ input, output, terminal: true });
  output.write(
    `Native ${kind} review: ${encoded}\nAfter inspecting it, type: ${kind} ${sha256}\nCtrl+C or closing input cancels this workflow.\n`,
  );
  let cleanup = () => {};
  try {
    return await new Promise((resolve, reject) => {
      let attempts = 0;
      const cancel = () => reject(new globalThis.DOMException("Native workflow review cancelled.", "AbortError"));
      const onLine = (line) => {
        if (line === `${kind} ${sha256}`) resolve(sha256);
        else if (++attempts >= 8 || line.length > 512) cancel();
        else output.write(`Enter the exact ${kind} command and hash shown above.\n`);
      };
      terminal.on("line", onLine);
      terminal.once("SIGINT", cancel);
      terminal.once("close", cancel);
      signal?.addEventListener("abort", cancel, { once: true });
      cleanup = () => {
        terminal.removeListener("line", onLine);
        terminal.removeListener("SIGINT", cancel);
        terminal.removeListener("close", cancel);
        signal?.removeEventListener("abort", cancel);
      };
      if (signal?.aborted) cancel();
    });
  } finally {
    cleanup();
    if (!sharedTerminal) terminal.close();
  }
}

export function assertNativeApprovalTerminal(input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY)
    throw new Error(
      "Native approval runs require an interactive terminal. Run this command directly in a terminal; piped input cannot approve execution.",
    );
}

/** This console only forwards typed decisions. Polling displays native pending
 * requests; neither a timer, EOF nor an invalid command can grant approval. */
export function startNativeApprovalConsole({
  pending,
  resolve,
  workspace,
  signal,
  onClosed,
  input = process.stdin,
  output = process.stdout,
  pollMs = 3000,
}) {
  assertNativeApprovalTerminal(input, output);
  signal?.throwIfAborted();
  const terminal = createInterface({ input, output, terminal: true });
  let closed = false,
    tail = Promise.resolve(),
    lastPending = "",
    queued = 0;
  const print = (value) => output.write(`${value}\n`);
  // Native strings are JSON-encoded so a command cannot inject terminal escapes.
  print(`Native approval workspace: ${JSON.stringify(workspace)}`);
  print("Commands: pending | allow-once EXACT_ID | deny EXACT_ID. Ctrl+C stops this comparison run.");
  const inspect = async (force = false) => {
    const result = await pending();
    const encoded = JSON.stringify(result);
    if (!closed && (force || encoded !== lastPending)) print(`Native pending approvals: ${encoded}`);
    lastPending = encoded;
  };
  const enqueue = (work) => {
    if (closed) return;
    if (queued >= 8) {
      print("Wait for the pending native command to finish.");
      return;
    }
    queued++;
    tail = tail
      .then(async () => {
        if (!closed) await work();
      })
      .catch((error) => {
        if (!closed) print(`Native approval command failed: ${JSON.stringify(error.message)}`);
      })
      .finally(() => {
        queued--;
      });
  };
  terminal.on("line", (line) => {
    const parts = line.trim().split(/\s+/u);
    if (parts.length === 1 && parts[0] === "pending") {
      enqueue(() => inspect(true));
      return;
    }
    if (
      parts.length !== 2 ||
      !["allow-once", "deny"].includes(parts[0]) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/=-]{0,255}$/u.test(parts[1])
    ) {
      print("Enter pending, allow-once EXACT_ID, or deny EXACT_ID.");
      return;
    }
    enqueue(async () => {
      const result = await resolve({ decision: parts[0], approvalId: parts[1] });
      if (!closed) print(`Native decision result: ${JSON.stringify(result)}`);
      await inspect(true);
    });
  });
  const unexpectedClose = () => {
    if (!closed) {
      onClosed?.();
      void stop();
    }
  };
  terminal.on("close", unexpectedClose);
  terminal.on("SIGINT", unexpectedClose);
  const timer = setInterval(() => {
    if (!queued) enqueue(inspect);
  }, pollMs);
  const onAbort = () => {
    void stop();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  enqueue(inspect);
  async function stop() {
    if (!closed) {
      closed = true;
      clearInterval(timer);
      signal?.removeEventListener("abort", onAbort);
      terminal.close();
    }
    await tail;
  }
  return { stop };
}
