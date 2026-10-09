// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The pre-paint theme boot is a plain same-origin script (the Gateway CSP forbids inline scripts), so the test runs
// its exact shipped source against a document.
const appRoot = path.resolve(__dirname, "..");
const source = readFileSync(path.join(appRoot, "public/theme-boot.js"), "utf8");
const indexHtml = readFileSync(path.join(appRoot, "index.html"), "utf8");
function boot(url: string) {
  window.history.replaceState(null, "", url);
  delete document.documentElement.dataset.theme;
  new Function(source)();
  return document.documentElement.dataset.theme;
}
afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("first-frame theme boot", () => {
  it("applies the saved theme before the app loads, defaulting to dark like the preference owner", () => {
    expect(boot("/chat")).toBe("dark");
    localStorage.setItem("goatcitadel.ui.theme.v1", "light");
    expect(boot("/chat")).toBe("light");
    localStorage.setItem("goatcitadel.ui.theme.v1", "unexpected");
    expect(boot("/chat")).toBe("dark");
  });

  it("honours an explicit theme query the same way the access gate does", () => {
    localStorage.setItem("goatcitadel.ui.theme.v1", "dark");
    expect(boot("/chat?theme=light")).toBe("light");
    expect(boot("/chat?theme=citadel-light")).toBe("light");
    localStorage.setItem("goatcitadel.ui.theme.v1", "light");
    expect(boot("/chat?theme=signal-noir")).toBe("dark");
  });

  it("never throws when storage is unavailable", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    try {
      expect(boot("/chat")).toBe("dark");
    } finally {
      Object.defineProperty(window, "localStorage", original);
    }
  });

  it("is loaded synchronously in the head and paired with pre-paint canvas colours", () => {
    const head = indexHtml.slice(0, indexHtml.indexOf("</head>"));
    expect(head).toMatch(/<script src="\/theme-boot\.js"><\/script>/);
    expect(head).toContain('html[data-theme="dark"]');
    expect(head).toContain("#122235");
    expect(head).toContain('html[data-theme="light"]');
    expect(head).toContain("#f0f8ff");
  });
});
