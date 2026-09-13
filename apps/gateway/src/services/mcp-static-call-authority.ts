declare const staticMcpCallBrand: unique symbol;
export interface StaticMcpCallAuthority {
  readonly [staticMcpCallBrand]: true;
  toJSON(): never;
}

interface CallState {
  consumed: boolean;
  revalidateCatalog(result: unknown): Promise<void>;
  beforeDispatch(): Promise<void>;
}
const calls = new WeakMap<StaticMcpCallAuthority, CallState>();

/** Only a Gateway owner with a frozen profile supplies these app-private callbacks. */
export function createStaticMcpCallAuthority(input: Omit<CallState, "consumed">): StaticMcpCallAuthority {
  const handle = Object.freeze({
    toJSON(): never {
      throw new Error("MCP call authority cannot be serialized.");
    },
  }) as StaticMcpCallAuthority;
  calls.set(handle, { ...input, consumed: false });
  return handle;
}

export async function consumeStaticMcpCallAuthority(
  handle: StaticMcpCallAuthority,
  toolsListResult: unknown,
): Promise<void> {
  const state = calls.get(handle);
  if (!state || state.consumed) throw new Error("Static MCP tool call requires unused server-owned authority.");
  state.consumed = true;
  await state.revalidateCatalog(toolsListResult);
  await state.beforeDispatch();
}
