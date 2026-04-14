import { createElement, type ReactNode } from "react";
import type { ReactTestRenderer } from "react-test-renderer";
import { beforeEach, vi } from "vitest";

// React 19 expects the test environment to explicitly opt into act-aware updates.
// Mission Control still has a large react-test-renderer suite, so we centralize the
// compatibility bridge here instead of rewriting every test up front.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
