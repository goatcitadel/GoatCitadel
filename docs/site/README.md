# GoatCitadel documentation site

The portal builds to plain HTML, CSS, and JavaScript using Node.js 22 or later. Run these commands from the repository root.

```sh
node docs/site/preview.mjs
```

Open [the local preview](http://127.0.0.1:4178/). Pass a port as the first argument to use a different one. Restart the preview after editing guides or site assets.

```sh
node docs/site/build.mjs
```

Deploy the contents of `docs/site/dist` to a static host that serves directory indexes. The site works at a domain root or a path prefix. Build from a clean checkout for publishing.

## Edit a guide

Add or update its entry in `catalog.mjs` and its HTML fragment in `content/`. Use an `h2` with a unique lowercase, hyphenated `id` for each major section. The build uses those headings for page navigation and the in-browser search index. Link to other guides with `../guide-slug/` and point to the source docs for technical contracts or release-specific details.

The build takes the mark from the product's brand assets. The two bundled typefaces use the SIL Open Font License. Their notices ship with the site assets.
