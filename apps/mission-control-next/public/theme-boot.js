/* global window, document, URLSearchParams */
// Pre-paint theme (CSP forbids inline scripts): saved "light"/"dark", else Match system (dark if the host can't
// say), then the ?theme= override. Mirrors ui-preferences; never throws.
(function () {
  var theme = "dark";
  try {
    var saved = window.localStorage.getItem("goatcitadel.ui.theme.v1");
    if (saved === "light" || saved === "dark") theme = saved;
    else if (window.matchMedia && !window.matchMedia("(prefers-color-scheme: dark)").matches) theme = "light";
  } catch {
    theme = "dark";
  }
  try {
    var value = (new URLSearchParams(window.location.search).get("theme") || "").trim().toLowerCase();
    if (value === "light" || value === "citadel-light" || value === "theme-citadel-light") theme = "light";
    if (value === "dark" || value === "signal-noir" || value === "theme-signal-noir") theme = "dark";
  } catch {
    // An unreadable location keeps the stored preference.
  }
  document.documentElement.dataset.theme = theme;
})();
