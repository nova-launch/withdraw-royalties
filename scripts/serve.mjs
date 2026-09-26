import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const files = new Map([
  ["index.html", "text/html; charset=utf-8"],
  ["styles.css", "text/css; charset=utf-8"],
  ["app.js", "text/javascript; charset=utf-8"],
  ["catalog.json", "application/json"],
  ["vendor/solana-web3-1.98.4.min.js", "text/javascript; charset=utf-8"],
]);

// Serve only the five public files, never Git metadata or local development files.
export function siteServer() {
  return createServer(async (request, response) => {
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/withdraw-royalties") {
      response.writeHead(301, { Location: "/withdraw-royalties/" }).end();
      return;
    }
    const name = pathname.replace(/^\/(?:withdraw-royalties\/)?/, "") || "index.html";
    if (!files.has(name)) { response.writeHead(404).end(); return; }
    try {
      const body = await readFile(new URL(`../${name}`, import.meta.url));
      response.writeHead(200, { "Content-Type": files.get(name), "Cache-Control": "no-store" });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch { response.writeHead(500).end("Could not read site file."); }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4175);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT.");
  const server = siteServer();
  server.on("error", error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, "127.0.0.1", () => console.log(`NFT royalties: http://127.0.0.1:${port}/`));
}
