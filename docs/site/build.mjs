import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pages } from "./catalog.mjs";
import { guidePage, homePage, htmlPage } from "./templates.mjs";

const source = fileURLToPath(new URL("./", import.meta.url));
export const output = join(source, "dist");

const staticAssets = [
  "citadel.webp",
  "geist.woff2",
  "geist-license.txt",
  "hanken-grotesk.woff2",
  "hanken-grotesk-license.txt",
  "site.css",
  "site.js",
  "theme.js",
];

function plainText(html) {
  const entities = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
  return html
    .replace(/<\/?(?:p|li|h[2-6]|pre|figcaption|div)\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => entities[entity])
    .replace(/\s+/g, " ")
    .trim();
}

function guideSections(html, slug) {
  const headings = [...html.matchAll(/<h2 id="([a-z0-9-]+)">([^<]+)<\/h2>/g)];
  const ids = new Set(headings.map((heading) => heading[1]));
  if (headings.length === 0 || ids.size !== headings.length) {
    throw new Error(`${slug}.html must have h2 headings with unique IDs.`);
  }

  return headings.map((heading, index) => ({
    id: heading[1],
    title: plainText(heading[2]),
    text: plainText(html.slice(heading.index + heading[0].length, headings[index + 1]?.index)),
  }));
}

export async function buildSite() {
  const articles = await Promise.all(
    pages.map(async (page) => {
      if (!page.slug) return { page, html: "", sections: [] };
      const html = await readFile(join(source, "content", `${page.slug}.html`), "utf8");
      return { page, html, sections: guideSections(html, page.slug) };
    }),
  );
  const uniqueSlugs = new Set(pages.map((page) => page.slug));
  if (uniqueSlugs.size !== pages.length) throw new Error("Documentation page slugs must be unique.");

  const assets = join(output, "assets");
  await mkdir(assets, { recursive: true });
  await Promise.all([
    ...staticAssets.map((name) => copyFile(join(source, "assets", name), join(assets, name))),
    copyFile(
      join(source, "../../apps/mission-control-next/public/brand/source/goatcitadel-mark.svg"),
      join(assets, "mark.svg"),
    ),
  ]);

  const searchIndex = [];
  const routes = new Map(staticAssets.map((name) => [`/assets/${name}`, join(assets, name)]));
  for (const { page, html, sections } of articles) {
    const root = page.slug ? "../" : "./";
    const pathname = page.slug ? `/${page.slug}/` : "/";
    const directory = join(output, page.slug);
    const file = join(directory, "index.html");
    const content = page.slug ? guidePage(root, page, html, sections) : homePage(root);
    await mkdir(directory, { recursive: true });
    await writeFile(file, htmlPage(root, page, content));
    routes.set(pathname, file);
    routes.set(`${pathname}index.html`, file);
    const url = pathname.slice(1);
    searchIndex.push({ url, title: page.title, group: page.group, text: page.description });
    for (const section of sections) {
      searchIndex.push({
        url: `${url}#${section.id}`,
        title: section.title,
        group: page.title,
        text: section.text,
      });
    }
  }

  const indexFile = join(assets, "search-index.json");
  await writeFile(indexFile, JSON.stringify(searchIndex));
  routes.set("/assets/search-index.json", indexFile);
  routes.set("/assets/mark.svg", join(assets, "mark.svg"));
  return routes;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildSite();
  console.log(`Built ${pages.length} documentation pages in ${output}`);
}
