export const CODE_MODE_CHILD_SOURCE = String.raw`import vm from "node:vm";
const MAX_MESSAGE_BYTES = 131072;
const TRANSPORT = process.env.GOATCITADEL_CODE_MODE_TRANSPORT === "stdio_jsonrpc" ? "stdio_jsonrpc" : "node_ipc";
const pendingRpc = new Map();
let currentRunPromise = null;
let inFlightWrapperCall = null;
let cancelledReason = null;
const pendingConsoleDrains = new Set();

function encodeMessageBytes(message) {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
}

function createMessageTooLargeError(details = {}) {
  return {
    code: "MESSAGE_TOO_LARGE",
    message: "Code Mode IPC message exceeded the maximum allowed size.",
    details: {
      maxBytes: MAX_MESSAGE_BYTES,
      ...details,
    },
  };
}

function sendRpc(message) {
  if (TRANSPORT === "stdio_jsonrpc") {
    const bytes = encodeMessageBytes(message);
    if (bytes > MAX_MESSAGE_BYTES) {
      throw createMessageTooLargeError({
        bytes,
        direction: "child_to_parent",
        id: typeof message?.id === "string" ? message.id : undefined,
        method: typeof message?.method === "string" ? message.method : undefined,
      });
    }
    process.stdout.write(JSON.stringify(message) + "\n");
    return;
  }
  if (!process.send) {
    throw new Error("Code Mode IPC channel is unavailable.");
  }
  if (process.connected === false) {
    throw new Error("Code Mode IPC channel is closed.");
  }
  const bytes = encodeMessageBytes(message);
  if (bytes > MAX_MESSAGE_BYTES) {
    throw createMessageTooLargeError({
      bytes,
      direction: "child_to_parent",
      id: typeof message?.id === "string" ? message.id : undefined,
      method: typeof message?.method === "string" ? message.method : undefined,
    });
  }
  process.send(message, (error) => {
    if (error) {
      cancelledReason = error instanceof Error ? error.message : String(error);
      rejectPendingRpc({
        code: "IPC_SEND_FAILED",
        message: cancelledReason,
      });
    }
  });
}

function sendRpcBestEffort(message) {
  try {
    sendRpc(message);
    return true;
  } catch (error) {
    const serialized = serializeError(error);
    if (serialized.code === "MESSAGE_TOO_LARGE" && message && typeof message === "object" && "id" in message) {
      try {
        sendRpc({
          jsonrpc: "2.0",
          id: typeof message.id === "string" ? message.id : null,
          error: serialized,
        });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

function closeAfterRun() {
  if (TRANSPORT === "node_ipc" && typeof process.disconnect === "function" && process.connected) {
    process.disconnect();
  }
  setTimeout(() => process.exit(0), 100);
}

function serializeError(error) {
  const fallback = error instanceof Error ? error.message : String(error);
  const base = {
    code: "CODE_MODE_CHILD_ERROR",
    message: fallback,
  };
  if (error && typeof error === "object") {
    const record = error;
    if (typeof record.code === "string") {
      base.code = record.code;
    }
    if (typeof record.message === "string" && record.message.trim().length > 0) {
      base.message = record.message;
    }
    if (typeof record.stack === "string") {
      base.stack = record.stack;
    }
    if (record.details && typeof record.details === "object") {
      base.details = record.details;
    }
  }
  return base;
}

function writeConsoleLine(stream, args) {
  const text = args
    .map((value) => {
      if (typeof value === "string") {
        return value;
      }
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(" ");
  if (!stream.write(text + "\n")) {
    const drain = new Promise((resolve) => stream.once("drain", resolve));
    pendingConsoleDrains.add(drain);
    drain.finally(() => pendingConsoleDrains.delete(drain));
  }
}

async function waitForConsoleDrains() {
  const snapshot = Array.from(pendingConsoleDrains);
  if (snapshot.length === 0) {
    return;
  }
  await Promise.race([
    Promise.allSettled(snapshot),
      new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
}

const consoleFacade = Object.freeze({
  log: (...args) => writeConsoleLine(TRANSPORT === "stdio_jsonrpc" ? process.stderr : process.stdout, args),
  info: (...args) => writeConsoleLine(TRANSPORT === "stdio_jsonrpc" ? process.stderr : process.stdout, args),
  warn: (...args) => writeConsoleLine(process.stderr, args),
  error: (...args) => writeConsoleLine(process.stderr, args),
});

function createUnsupportedConcurrencyError(wrapperName) {
  return {
    code: "UNSUPPORTED_CONCURRENCY",
    message: "Code Mode v1 does not support parallel wrapper invocation.",
    details: {
      wrapperName,
      activeWrapperCall: inFlightWrapperCall,
    },
  };
}

async function invokeWrapper(wrapperName, args, deadlineAt) {
  if (cancelledReason) {
    throw {
      code: "RUN_CANCELLED",
      message: cancelledReason,
    };
  }
  if (inFlightWrapperCall) {
    throw createUnsupportedConcurrencyError(wrapperName);
  }
  if (typeof deadlineAt === "number" && Number.isFinite(deadlineAt) && Date.now() > deadlineAt) {
    throw {
      code: "RUN_DEADLINE_EXCEEDED",
      message: "Code Mode wrapper deadline exceeded before invocation.",
      details: { wrapperName },
    };
  }

  const id = "rpc_" + Math.random().toString(36).slice(2, 10);
  inFlightWrapperCall = wrapperName;
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      let timeoutHandle;
      const settle = (callback, value) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        pendingRpc.delete(id);
        callback(value);
      };
      pendingRpc.set(id, {
        resolve: (value) => settle(resolve, value),
        reject: (error) => settle(reject, error),
      });
      if (typeof deadlineAt === "number" && Number.isFinite(deadlineAt)) {
        timeoutHandle = setTimeout(() => {
          settle(reject, {
            code: "RUN_DEADLINE_EXCEEDED",
            message: "Code Mode wrapper deadline exceeded while waiting for parent response.",
            details: { wrapperName },
          });
        }, Math.max(1, deadlineAt - Date.now()));
      }
      sendRpc({
        jsonrpc: "2.0",
        id,
        method: "capability.invoke",
        params: {
          wrapperName,
          args: args && typeof args === "object" ? args : {},
          deadlineAt,
        },
      });
    });
  } finally {
    pendingRpc.delete(id);
    inFlightWrapperCall = null;
  }
}

function buildCapabilities(wrapperManifest, deadlineAt) {
  const root = Object.create(null);
  const wrappers = Array.isArray(wrapperManifest?.wrappers) ? wrapperManifest.wrappers : [];
  for (const wrapper of wrappers) {
    if (!wrapper || typeof wrapper.name !== "string") {
      continue;
    }
    const segments = wrapper.name.split(".");
    if (segments.some((segment) => isUnsafeCapabilitySegment(segment))) {
      continue;
    }
    let cursor = root;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (!segment) {
        continue;
      }
      const isLeaf = index === segments.length - 1;
      if (isLeaf) {
        cursor[segment] = async (args = {}) => invokeWrapper(wrapper.name, args, deadlineAt);
      } else {
        const existing = cursor[segment];
        if (!existing || typeof existing !== "object") {
          cursor[segment] = Object.create(null);
        }
        cursor = cursor[segment];
      }
    }
  }
  return Object.freeze(root);
}

function isUnsafeCapabilitySegment(segment) {
  return segment === "__proto__" || segment === "prototype" || segment === "constructor";
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || (typeof value !== "object" && typeof value !== "function") || Object.isFrozen(value)) {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const next = value[key];
    if (next && (typeof next === "object" || typeof next === "function")) {
      deepFreeze(next, seen);
    }
  }
  return Object.freeze(value);
}

function normalizeResult(result) {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return result;
  }
  return { value: result };
}

function assertNoUnawaitedWrapperCalls() {
  if (pendingRpc.size === 0 && !inFlightWrapperCall) {
    return;
  }
  throw {
    code: "UNAWAITED_WRAPPER_CALL",
    message: "Code Mode wrapper calls must be awaited before the run returns.",
    details: {
      pendingWrapperCallCount: pendingRpc.size,
      activeWrapperCall: inFlightWrapperCall,
    },
  };
}

async function executeRun(params) {
  const deadlineAt =
    typeof params?.deadlineAt === "number" && Number.isFinite(params.deadlineAt) ? params.deadlineAt : undefined;
  if (typeof deadlineAt === "number" && Date.now() > deadlineAt) {
    throw {
      code: "RUN_DEADLINE_EXCEEDED",
      message: "Code Mode wrapper deadline exceeded before invocation.",
    };
  }
  const capabilities = deepFreeze(buildCapabilities(params?.wrapperManifest, deadlineAt));
  const input = deepFreeze(params?.input && typeof params.input === "object" ? params.input : {});
  const context = deepFreeze({
    runId: typeof params?.runId === "string" ? params.runId : undefined,
    requestedOutputIntent:
      typeof params?.requestedOutputIntent === "string" ? params.requestedOutputIntent : undefined,
  });
  // HARDENING ONLY — not a security sandbox.
  // vm.Script.runInNewContext does NOT provide a secure isolation boundary.
  // Blocking Function/eval/generators prevents casual dynamic code generation
  // but a determined payload can still escape via prototype chain, Proxy tricks,
  // or other vm breakout techniques. True sandboxing requires a separate process
  // with restricted OS-level capabilities (e.g. seccomp, containers).
  const blockedConstructor = Object.freeze(function blocked() {
    throw new Error("Code-mode hardening: dynamic code generation is not allowed.");
  });
  const sandboxGlobal = {
    capabilities,
    input,
    context,
    console: consoleFacade,
    process: undefined,
    require: undefined,
    module: undefined,
    exports: undefined,
    __dirname: undefined,
    __filename: undefined,
    fetch: undefined,
    Buffer: undefined,
    globalThis: undefined,
    global: undefined,
    setTimeout: undefined,
    setInterval: undefined,
    setImmediate: undefined,
    clearTimeout: undefined,
    clearInterval: undefined,
    clearImmediate: undefined,
    queueMicrotask: undefined,
    Function: blockedConstructor,
    eval: blockedConstructor,
    GeneratorFunction: blockedConstructor,
    AsyncFunction: blockedConstructor,
    AsyncGeneratorFunction: blockedConstructor,
  };
  sandboxGlobal.globalThis = sandboxGlobal;
  deepFreeze(sandboxGlobal);

  const script = new vm.Script(
    "\"use strict\";\n(async () => {\n" + String(params?.source ?? "") + "\n})()",
    {
      filename: "code-mode-guest.js",
      displayErrors: true,
    },
  );
  try {
    const value = await script.runInNewContext(sandboxGlobal, {
      timeout:
        typeof deadlineAt === "number" && Number.isFinite(deadlineAt)
          ? Math.max(1, deadlineAt - Date.now())
          : undefined,
    });
    await waitForConsoleDrains();
    assertNoUnawaitedWrapperCalls();
    return normalizeResult(value);
  } catch (error) {
    await waitForConsoleDrains();
    throw error;
  }
}

function rejectPendingRpc(error) {
  const normalized = serializeError(error);
  for (const entry of pendingRpc.values()) {
    entry.reject(normalized);
  }
  pendingRpc.clear();
}

async function handleParentMessage(message) {
  if (!message || typeof message !== "object") {
    return;
  }
  if (encodeMessageBytes(message) > MAX_MESSAGE_BYTES) {
    sendRpcBestEffort({
      jsonrpc: "2.0",
      id: typeof message.id === "string" ? message.id : null,
      error: createMessageTooLargeError({
        bytes: encodeMessageBytes(message),
        direction: "parent_to_child",
        method: typeof message.method === "string" ? message.method : undefined,
      }),
    });
    return;
  }

  if (typeof message.id === "string" && (Object.prototype.hasOwnProperty.call(message, "result") || Object.prototype.hasOwnProperty.call(message, "error"))) {
    const pending = pendingRpc.get(message.id);
    if (!pending) {
      return;
    }
    pendingRpc.delete(message.id);
    if (message.error) {
      pending.reject(message.error);
    } else {
      pending.resolve(message.result);
    }
    return;
  }

  if (message.method === "run.cancel") {
    cancelledReason =
      typeof message.params?.reason === "string" ? message.params.reason : "Code Mode run cancelled by parent.";
    rejectPendingRpc({
      code: "RUN_CANCELLED",
      message: cancelledReason,
    });
    return;
  }

  if (message.method !== "run.execute" || typeof message.id !== "string") {
    return;
  }

  if (currentRunPromise) {
    sendRpcBestEffort({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: "RUN_ALREADY_ACTIVE",
        message: "Code Mode child received a second run request while one was already active.",
      },
    });
    return;
  }

  currentRunPromise = executeRun(message.params)
    .then((result) => {
      sendRpcBestEffort({
        jsonrpc: "2.0",
        id: message.id,
        result,
      });
      closeAfterRun();
    })
    .catch((error) => {
      sendRpcBestEffort({
        jsonrpc: "2.0",
        id: message.id,
        error: serializeError(error),
      });
      closeAfterRun();
    })
    .finally(() => {
      currentRunPromise = null;
    });
}

if (TRANSPORT === "node_ipc") {
  process.on("disconnect", () => {
    cancelledReason = "Parent IPC channel disconnected.";
    rejectPendingRpc({
      code: "IPC_DISCONNECTED",
      message: cancelledReason,
    });
    process.exit(0);
  });

  process.on("message", (message) => {
    void handleParentMessage(message);
  });
} else {
  let stdinBuffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    stdinBuffer += chunk;
    let newlineIndex = stdinBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = stdinBuffer.slice(0, newlineIndex).trim();
      stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        try {
          void handleParentMessage(JSON.parse(line));
        } catch (error) {
          sendRpcBestEffort({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: "INVALID_STDIN_JSON",
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
      newlineIndex = stdinBuffer.indexOf("\n");
    }
  });
  process.stdin.on("end", () => {
    cancelledReason = "Parent stdio channel closed.";
    rejectPendingRpc({
      code: "STDIO_DISCONNECTED",
      message: cancelledReason,
    });
    process.exit(0);
  });
}
`;
