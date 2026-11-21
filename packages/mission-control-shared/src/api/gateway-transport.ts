/** Selected before any API owner mounts. A disposed practice document never falls back to the network. */
export interface GatewayTransport {
  fetch: typeof fetch;
  events: (url: string) => EventSource;
}

let practice: GatewayTransport | undefined;
const values = new Map<string, string>();
const practiceStorage: Storage = {
  get length() {
    return values.size;
  },
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  key: (index) => [...values.keys()][index] ?? null,
  removeItem: (key) => {
    values.delete(key);
  },
  setItem: (key, value) => {
    values.set(key, value);
  },
};

export function gatewayLocalStorage(): Storage {
  return practice ? practiceStorage : window.localStorage;
}

export function clearPracticeStorage(): void {
  values.clear();
}

export function installPracticeGatewayTransport(transport: GatewayTransport): void {
  if (practice) throw new Error("The practice transport is already installed.");
  practice = transport;
}

export function isPracticeGateway(): boolean {
  return practice !== undefined;
}

export const gatewayFetch: typeof fetch = (input, init) =>
  practice ? practice.fetch(input, init) : fetch(input, init);

export function openGatewayEvents(url: string): EventSource {
  return practice ? practice.events(url) : new EventSource(url);
}
