/* global document, window */

(() => {
  let savedTheme;
  try {
    savedTheme = window.localStorage.getItem("goatcitadel-docs-theme");
  } catch {
    // Private or restricted browser contexts can still use the system theme.
  }
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  document.documentElement.dataset.theme =
    savedTheme === "light" || savedTheme === "dark" ? savedTheme : systemTheme.matches ? "dark" : "light";
})();
