/* global window, document, URLSearchParams */
// Pre-paint theme boot, loaded synchronously from index.html (the Gateway CSP forbids inline scripts). Mirrors the
// preference owner ("light", else "dark") and the access gate's ?theme= override; never throws.
(function () {
  var theme = "dark";
  try {
    if (window.localStorage.getItem("goatcitadel.ui.theme.v1") === "light") theme = "light";
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
