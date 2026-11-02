import { fetch as undiciFetch, type Dispatcher } from "undici";

export type ProviderFetch = (url: string, init: RequestInit & { dispatcher?: Dispatcher }) => Promise<Response>;

// Keep fetch and the guarded Agent/ProxyAgent on the same pinned Undici version.
// Newer Node fetch implementations can use an incompatible dispatcher protocol.
// The Web Fetch types are structural here: consumers use standard response/body
// methods, and the pinned implementation accepts native FormData and AbortSignal.
export const fetchLlmProvider = undiciFetch as unknown as ProviderFetch;
