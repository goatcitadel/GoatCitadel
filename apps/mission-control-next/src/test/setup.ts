/* eslint-disable no-console */
import { createElement, type ReactNode } from "react";
import type { ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, vi } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalConsoleError = console.error.bind(console);
const activeTestRenderers = new Set<ReactTestRenderer>();

export function cleanupTestRenderers(renderers: Set<Pick<ReactTestRenderer, "unmount">>): void {
  let cleanupError: unknown;
  try {
    for (const renderer of [...renderers]) {
      try {
        renderer.unmount();
      } catch (error) {
        cleanupError ??= error;
      }
    }
  } finally {
    renderers.clear();
  }
  if (cleanupError) {
    throw cleanupError;
  }
}

console.error = ((...args: unknown[]) => {
  const [firstArg] = args;
  if (typeof firstArg === "string" && firstArg.includes("react-test-renderer is deprecated")) {
    return;
  }
  originalConsoleError(...args);
}) as typeof console.error;

function installBrowserPolyfills(): void {
  if (typeof globalThis.requestAnimationFrame !== "function") {
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      writable: true,
      value: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    });
  }

  if (typeof globalThis.cancelAnimationFrame !== "function") {
    Object.defineProperty(globalThis, "cancelAnimationFrame", {
      configurable: true,
      writable: true,
      value: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
    });
  }

  if (typeof globalThis.window === "object" && globalThis.window) {
    if (typeof globalThis.window.requestAnimationFrame !== "function") {
      Object.defineProperty(globalThis.window, "requestAnimationFrame", {
        configurable: true,
        writable: true,
        value: globalThis.requestAnimationFrame,
      });
    }
    if (typeof globalThis.window.cancelAnimationFrame !== "function") {
      Object.defineProperty(globalThis.window, "cancelAnimationFrame", {
        configurable: true,
        writable: true,
        value: globalThis.cancelAnimationFrame,
      });
    }
  }

  if (typeof globalThis.document === "object" && globalThis.document) {
    if (typeof globalThis.document.getElementsByTagName !== "function") {
      Object.defineProperty(globalThis.document, "getElementsByTagName", {
        configurable: true,
        writable: true,
        value: () => [],
      });
    }
  }
}

installBrowserPolyfills();
beforeEach(() => {
  installBrowserPolyfills();
});

vi.mock("vaul", () => {
  const passthrough = ({ children, ...props }: Record<string, unknown> & { children?: ReactNode }) =>
    createElement("div", props, children);

  return {
    Drawer: {
      Root: passthrough,
      Trigger: passthrough,
      Portal: passthrough,
      Close: passthrough,
      Overlay: passthrough,
      Content: passthrough,
      Title: passthrough,
      Description: passthrough,
    },
  };
});

vi.mock("react-test-renderer", async () => {
  const actual = await vi.importActual<typeof import("react-test-renderer")>("react-test-renderer");
  const actualWithDefault = actual as typeof actual & { default?: Record<string, unknown> };

  const wrapRenderer = (renderer: ReactTestRenderer): ReactTestRenderer => {
    activeTestRenderers.add(renderer);
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
      try {
        let result: ReturnType<typeof originalUnmount>;
        actual.act(() => {
          result = originalUnmount();
        });
        return result!;
      } finally {
        activeTestRenderers.delete(renderer);
      }
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

afterEach(() => {
  // A mounted renderer can retain polling effects and report React warnings
  // after Vitest begins closing the worker console channel. Tests may still
  // unmount explicitly; this closes only renderers they leave behind.
  cleanupTestRenderers(activeTestRenderers);
});
