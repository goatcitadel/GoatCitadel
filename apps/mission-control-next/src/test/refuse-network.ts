import { afterAll, afterEach, beforeAll, expect } from "vitest";

/**
 * Fails the calling file's tests on any fetch. A test file reaches the Gateway only through the api modules it
 * mocks; a request that slips past them would go to the Gateway URL, the operator's own install on this computer.
 *
 * Call it at file level, before the file's own hooks, so its afterEach check runs after theirs (unmounts included).
 * fetch stays refused for the whole file, because a read a test left running can still call it after the test; a
 * request fails the test that made it or, when it comes after the last test, the file. The guard is a plain function
 * set outside vi.stubGlobal, so vi.unstubAllGlobals and vi.resetAllMocks in the file's own hooks leave it in place.
 */
export function refuseNetwork(): void {
  const requests: string[] = [];
  const takeRequests = () => requests.splice(0);
  const refuse = (input: RequestInfo | URL): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push(url);
    return Promise.reject(new Error(`Unmocked request: ${url}`));
  };
  let original: PropertyDescriptor | undefined;
  beforeAll(() => {
    original = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: refuse });
  });
  afterEach(() => {
    expect(takeRequests()).toEqual([]);
  });
  afterAll(() => {
    if (original) Object.defineProperty(globalThis, "fetch", original);
    else Reflect.deleteProperty(globalThis, "fetch");
    expect(takeRequests()).toEqual([]);
  });
}
