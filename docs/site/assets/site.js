/* global document, navigator, window */

const html = document.documentElement;
const root = html.dataset.docsRoot;
const themeToggle = document.querySelector("[data-theme-toggle]");
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
const themeKey = "goatcitadel-docs-theme";
let themeChosen = false;

try {
  themeChosen = ["light", "dark"].includes(window.localStorage.getItem(themeKey));
} catch {
  // The toggle still works for the current page when storage is unavailable.
}

function applyTheme(theme) {
  html.dataset.theme = theme;
  themeToggle.setAttribute("aria-pressed", String(theme === "dark"));
}

applyTheme(html.dataset.theme);
themeToggle.hidden = false;
themeToggle.addEventListener("click", () => {
  const theme = html.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(theme);
  themeChosen = true;
  try {
    window.localStorage.setItem(themeKey, theme);
  } catch {
    // A blocked storage write does not affect the current page.
  }
});
systemTheme.addEventListener("change", (event) => {
  if (!themeChosen) applyTheme(event.matches ? "dark" : "light");
});

const menu = document.querySelector(".mobile-navigation");
document.addEventListener("click", (event) => {
  if (menu.open && !menu.contains(event.target)) menu.open = false;
});

const searchTrigger = document.querySelector("[data-search]");
const searchDialog = document.querySelector("#search-dialog");
const searchInput = document.querySelector("#search-input");
const searchStatus = searchDialog.querySelector(".search-status");
const searchResults = searchDialog.querySelector(".search-results");
const suggestedPages = ["quickstart/", "install/", "model-providers/", "troubleshooting/"];
let index;
let indexRequest;
let previousFocus;

if (/Mac|iPhone|iPad/.test(navigator.platform)) {
  document.querySelector("[data-search-shortcut]").textContent = "⌘ K";
}

function words(value) {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function findEntries(terms) {
  const phrase = terms.join(" ");
  return index
    .map((entry) => {
      const title = words(entry.title).join(" ");
      const group = words(entry.group).join(" ");
      const text = words(entry.text).join(" ");
      if (!terms.every((term) => title.includes(term) || group.includes(term) || text.includes(term))) {
        return { entry, score: 0 };
      }
      const titleScore = title === phrase ? 100 : title.includes(phrase) ? 40 : 0;
      const termScore = terms.reduce((score, term) => {
        return score + (title.includes(term) ? 10 : group.includes(term) ? 4 : 1);
      }, 0);
      return { entry, score: titleScore + termScore };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .map(({ entry }) => entry);
}

function excerpt(text, terms) {
  const lower = text.toLowerCase();
  const match = terms.map((term) => lower.indexOf(term)).find((position) => position >= 0) ?? 0;
  const start = match > 45 ? text.lastIndexOf(" ", match - 35) + 1 : 0;
  const limit = start + 126;
  const end = text.length > limit ? Math.max(text.lastIndexOf(" ", limit), start + 100) : text.length;
  return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function addResult(entry, terms) {
  const item = document.createElement("li");
  const link = document.createElement("a");
  const title = document.createElement("strong");
  const group = document.createElement("span");
  const snippet = document.createElement("span");
  link.href = `${root}${entry.url}`;
  title.textContent = entry.title;
  group.textContent = entry.group;
  group.className = "result-group";
  snippet.textContent = excerpt(entry.text, terms);
  snippet.className = "result-snippet";
  link.append(title, group, snippet);
  link.addEventListener("click", () => searchDialog.close());
  item.append(link);
  searchResults.append(item);
}

function renderSearch() {
  searchResults.replaceChildren();
  if (!index) return;

  const terms = [...new Set(words(searchInput.value))];
  const results = terms.length
    ? findEntries(terms)
    : suggestedPages.map((url) => index.find((entry) => entry.url === url)).filter(Boolean);
  const shown = results.slice(0, 9);
  if (!terms.length) {
    searchStatus.textContent = "Suggested guides";
  } else if (results.length === 0) {
    searchStatus.textContent = "No guides found. Try a different search.";
  } else {
    searchStatus.textContent =
      results.length > shown.length
        ? `Showing ${shown.length} of ${results.length} results`
        : `${results.length} ${results.length === 1 ? "result" : "results"}`;
  }
  for (const entry of shown) addResult(entry, terms);
}

async function openSearch() {
  if (searchDialog.open) return;
  const active = document.activeElement;
  previousFocus = menu.open && menu.contains(active) ? menu.querySelector("summary") : active;
  menu.open = false;
  searchDialog.showModal();
  searchInput.focus();
  if (index) {
    renderSearch();
    return;
  }

  searchStatus.textContent = "Loading documentation…";
  try {
    indexRequest ??= window.fetch(`${root}assets/search-index.json`).then((response) => {
      if (!response.ok) throw new Error("The search index is unavailable.");
      return response.json();
    });
    index = await indexRequest;
    renderSearch();
  } catch {
    indexRequest = undefined;
    searchStatus.textContent = "Search is unavailable. Close it and try again, or browse the guide menu.";
  }
}

searchTrigger.hidden = false;
searchTrigger.addEventListener("click", openSearch);
searchDialog.querySelector("[data-close-search]").addEventListener("click", () => searchDialog.close());
searchDialog.addEventListener("click", (event) => {
  if (event.target !== searchDialog) return;
  const bounds = searchDialog.getBoundingClientRect();
  if (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom
  ) {
    searchDialog.close();
  }
});
searchDialog.addEventListener("close", () => {
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
});
searchInput.addEventListener("input", renderSearch);
searchDialog.querySelector("form").addEventListener("submit", (event) => {
  event.preventDefault();
  searchResults.querySelector("a")?.click();
});

searchDialog.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    searchDialog.close();
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const links = [...searchResults.querySelectorAll("a")];
  if (!links.length) return;
  event.preventDefault();
  const current = links.indexOf(document.activeElement);
  if (event.key === "ArrowDown") links[Math.min(current + 1, links.length - 1)].focus();
  else if (current <= 0) searchInput.focus();
  else links[current - 1].focus();
});

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    void openSearch();
  } else if (event.key === "Escape" && menu.open && !searchDialog.open) {
    menu.open = false;
    menu.querySelector("summary").focus();
  }
});

const copyStatus = document.querySelector("#copy-status");
for (const block of document.querySelectorAll(".code-block")) {
  const code = block.querySelector("code");
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy-button";
  copy.textContent = "Copy";
  let resetTimer;
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(code.textContent.trimEnd());
      copy.textContent = "Copied";
      copyStatus.textContent = "Command copied.";
    } catch {
      copyStatus.textContent = "Clipboard unavailable. Select the command and copy it.";
      copy.textContent = "Copy unavailable";
    }
    window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => {
      copy.textContent = "Copy";
      copyStatus.textContent = "";
    }, 2200);
  });
  block.querySelector("figcaption").append(copy);
}
