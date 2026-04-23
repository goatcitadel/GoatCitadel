/* eslint-disable no-console */
import type { ReactTestRenderer } from "react-test-renderer";
import { beforeEach, vi } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalConsoleError = console.error.bind(console);

console.error = ((...args: unknown[]) => {
  const [firstArg] = args;
  if (typeof firstArg === "string" && firstArg.includes("react-test-renderer is deprecated")) {
    return;
  }
  originalConsoleError(...args);
}) as typeof console.error;

vi.mock("react-test-renderer", async () => {
  const actual = await vi.importActual<typeof import("react-test-renderer")>("react-test-renderer");
  const actualWithDefault = actual as typeof actual & { default?: Record<string, unknown> };

  const wrapRenderer = (renderer: ReactTestRenderer): ReactTestRenderer => {
    const originalUpdate = renderer.update.bind(renderer);
    renderer.update = ((...args: Parameters<typeof originalUpdate>) => {
      let result: ReturnType<typeof originalUpdate>;
      actual.act(() => {
        result = originalUpdate(...args);
      });
      return result!;
    }) as typeof renderer.update;

    const originalUnmount = renderer.unmount.bind(renderer);
    renderer.unmount = (() => {
      let result: ReturnType<typeof originalUnmount>;
      actual.act(() => {
        result = originalUnmount();
      });
      return result!;
    }) as typeof renderer.unmount;

    return renderer;
  };

  const create: typeof actual.create = (...args) => {
    let renderer!: ReturnType<typeof actual.create>;
    actual.act(() => {
      renderer = actual.create(...args);
    });
    return wrapRenderer(renderer);
  };

  const mockedModule = {
    ...actual,
    create,
  } as typeof actual & { default?: Record<string, unknown> };

  if (actualWithDefault.default && typeof actualWithDefault.default === "object") {
    mockedModule.default = {
      ...actualWithDefault.default,
      create,
    };
  }

  return mockedModule;
});

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
