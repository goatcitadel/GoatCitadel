import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname } from "node:path";
import { buildSite } from "./build.mjs";

const port = Number(process.argv[2] ?? 4178);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("Provide a port from 1 to 65535.");
}

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

const routes = await buildSite();
createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }

  const pathname = request.url.split("?", 1)[0];
  const file = routes.get(pathname);
  if (!file) {
    if (routes.has(`${pathname}/`)) {
      response.writeHead(308, { Location: `${pathname}/` }).end();
      return;
    }
    response.writeHead(404, { "Content-Type": contentTypes[".txt"] }).end("Page not found");
    return;
  }

  try {
    const body = await readFile(file);
    response.writeHead(200, {
      "Content-Type": contentTypes[extname(file)],
      "Content-Length": body.length,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    console.error(error.message);
    response.writeHead(500).end();
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`GoatCitadel Docs is ready at http://127.0.0.1:${port}/`);
});
