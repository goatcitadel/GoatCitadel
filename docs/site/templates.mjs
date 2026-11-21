import { groups, pages, productSite, repository } from "./catalog.mjs";

const icons = {
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  download: '<path d="M12 3v13m-5-5 5 5 5-5M3 16v4a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-4"/>',
  external: '<path d="M13 5h6v6m0-6-9 9m6-1v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1h5"/>',
  layers: '<path d="m12 3 10 5-10 5-10-5 10-5Zm10 9-10 5-10-5m20 4-10 5-10-5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M12 17v4m-5 0h10"/>',
  moon: '<path d="M20.8 14.4A9 9 0 0 1 9.6 3.2 9 9 0 1 0 20.8 14.4Z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  shield: '<path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5"/>',
};

const githubIcon = `<svg width="22" height="22" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
  <path d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38l-.01-1.49c-2.23.48-2.7-.95-2.7-.95-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.22 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.96 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.13 0 0 .67-.21 2.2.82A7.7 7.7 0 0 1 8 3.85c.68 0 1.36.09 2 .27 1.53-1.03 2.2-.82 2.2-.82.44 1.11.16 1.93.08 2.13.51.56.82 1.28.82 2.15 0 3.08-1.87 3.76-3.65 3.96.29.25.54.73.54 1.48l-.01 2.19c0 .21.14.46.55.38A8 8 0 0 0 8 0Z"/>
</svg>`;

function icon(name, className = "") {
  return `<svg class="${className}" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
}

export function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
  });
}

function pageUrl(root, slug) {
  return slug ? `${root}${slug}/` : root;
}

function sidebar(root, current) {
  return `<nav class="docs-nav" aria-label="Documentation">${groups
    .map(
      (group) => `<div class="nav-group">
        <p>${group.title}</p>
        <ul>${group.pages
          .map(
            (page) =>
              `<li><a href="${pageUrl(root, page.slug)}"${page.slug === current ? ' aria-current="page"' : ""}>${page.title}</a></li>`,
          )
          .join("")}</ul>
      </div>`,
    )
    .join("")}</nav>`;
}

function header(root, current) {
  return `<header class="site-header">
    <a class="brand" href="${root}" aria-label="GoatCitadel docs home">
      <img src="${root}assets/mark.svg" width="48" height="48" alt="">
      <span class="wordmark">GoatCitadel</span><span class="brand-section">Docs</span>
    </a>
    <div class="header-search">
      <button class="search-trigger" type="button" aria-haspopup="dialog" aria-keyshortcuts="Control+k Meta+k" aria-label="Search documentation" data-search hidden>
        ${icon("search")}<span>Search documentation</span><kbd data-search-shortcut>Ctrl K</kbd>
      </button>
    </div>
    <nav class="header-links" aria-label="GoatCitadel">
      <a class="product-link" href="${productSite}">Product site ${icon("external")}</a>
      <a class="icon-link github-link" href="${repository}" aria-label="GoatCitadel on GitHub">${githubIcon}</a>
      <button class="icon-link theme-toggle" type="button" aria-label="Dark mode" aria-pressed="false" data-theme-toggle hidden>
        ${icon("sun", "sun-icon")}${icon("moon", "moon-icon")}
      </button>
      <details class="mobile-navigation">
        <summary class="icon-link" aria-label="Documentation menu">${icon("menu")}</summary>
        <div class="mobile-menu">
          ${sidebar(root, current)}
          <div class="mobile-external-links"><a href="${productSite}">Product site ${icon("external")}</a><a href="${repository}">GitHub ${icon("external")}</a></div>
        </div>
      </details>
    </nav>
  </header>`;
}

function topicRow(root, slug) {
  const page = pages.find((item) => item.slug === slug);
  return `<li><a class="topic-link" href="${pageUrl(root, page.slug)}">
    ${icon(page.icon, "topic-icon")}
    <span><strong>${page.title}</strong><span class="topic-description">${page.description}</span></span>
    ${icon("arrow", "topic-arrow")}
  </a></li>`;
}

export function homePage(root) {
  return `<div class="front-page">
    <section class="hero" aria-labelledby="overview-heading">
      <div class="hero-copy">
        <h1 id="overview-heading">GoatCitadel <span>documentation</span></h1>
        <p>${pages[0].description}</p>
        <div class="hero-actions">
          <a class="button button-primary" href="${pageUrl(root, "quickstart")}">Quickstart ${icon("arrow")}</a>
          <a class="button button-secondary" href="${pageUrl(root, "install")}">Install GoatCitadel</a>
        </div>
      </div>
      <img class="hero-art" src="${root}assets/citadel.webp" width="1200" height="800" alt="" fetchpriority="high">
    </section>
    <div class="topic-groups">
      <section aria-labelledby="workspace-heading">
        <h2 id="workspace-heading">Set up your workspace</h2>
        <ul>${topicRow(root, "install")}${topicRow(root, "model-providers")}</ul>
      </section>
      <section aria-labelledby="mission-control-heading">
        <h2 id="mission-control-heading">Work in Mission Control</h2>
        <ul>${topicRow(root, "mission-control")}${topicRow(root, "approvals")}</ul>
      </section>
    </div>
    <nav class="home-footer" aria-label="More documentation">
      <a href="${pageUrl(root, "troubleshooting")}">Troubleshooting ${icon("arrow")}</a>
      <a href="${pageUrl(root, "architecture")}">Architecture ${icon("arrow")}</a>
    </nav>
  </div>`;
}

function pageNavigation(root, page, direction) {
  if (!page) return "";

  return `<a class="${direction}" href="${pageUrl(root, page.slug)}" rel="${direction === "previous" ? "prev" : "next"}">
    <span>${direction === "previous" ? "Previous" : "Next"}</span>
    <strong>${page.title} ${icon("arrow")}</strong>
  </a>`;
}

export function guidePage(root, page, article, sections) {
  const index = pages.indexOf(page);
  return `<article class="guide">
    <header class="guide-header">
      <nav class="breadcrumbs" aria-label="Breadcrumb">
        <a href="${root}">Docs</a>${icon("chevron")}<span>${page.group}</span>
      </nav>
      <h1>${page.title}</h1>
      <p>${page.description}</p>
    </header>
    <aside class="guide-toc">
      <nav aria-labelledby="toc-title">
        <h2 id="toc-title">On this page</h2>
        <ul>${sections.map(({ id, title }) => `<li><a href="#${id}">${escapeHtml(title)}</a></li>`).join("")}</ul>
      </nav>
    </aside>
    <div class="guide-body">${article}</div>
    <nav class="guide-pagination" aria-label="Adjacent guides">
      ${pageNavigation(root, pages[index - 1], "previous")}
      ${pageNavigation(root, pages[index + 1], "next")}
    </nav>
  </article>`;
}

export function htmlPage(root, page, content) {
  const title = page.slug ? `${page.title} | GoatCitadel Docs` : "GoatCitadel documentation";
  return `<!doctype html>
<html lang="en" data-docs-root="${root}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeHtml(page.description)}">
  <meta name="color-scheme" content="light dark">
  <title>${title}</title>
  <link rel="icon" href="${root}assets/mark.svg" type="image/svg+xml">
  <script src="${root}assets/theme.js"></script>
  <link rel="stylesheet" href="${root}assets/site.css">
</head>
<body>
  <a class="skip-link" href="#main-content">Skip to content</a>
  ${header(root, page.slug)}
  <div class="doc-shell">
    <aside class="site-sidebar">${sidebar(root, page.slug)}</aside>
    <main id="main-content" tabindex="-1">${content}</main>
  </div>
  <dialog id="search-dialog" class="search-dialog" aria-labelledby="search-title">
    <h2 id="search-title" class="sr-only">Search documentation</h2>
    <form class="search-field" role="search">
      ${icon("search")}
      <input type="search" id="search-input" aria-label="Search documentation" placeholder="Search documentation…" autocomplete="off" autofocus>
      <button class="icon-link search-close" type="button" aria-label="Close search" aria-keyshortcuts="Escape" data-close-search><span>Close</span><kbd>Esc</kbd></button>
    </form>
    <p class="search-status" role="status"></p>
    <ul class="search-results" aria-label="Search results"></ul>
  </dialog>
  <span id="copy-status" class="sr-only" role="status"></span>
  <script type="module" src="${root}assets/site.js"></script>
</body>
</html>\n`;
}
