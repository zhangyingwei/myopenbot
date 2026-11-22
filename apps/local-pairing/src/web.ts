import { readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const APP_PREFIX = "/app";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".vtt": "text/vtt",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export async function serveLocalWeb(request: Request, webRoot: string | null): Promise<Response> {
  if (webRoot === null) return missing();
  if (request.method !== "GET" && request.method !== "HEAD") return missing();
  const url = new URL(request.url);
  if (url.pathname !== APP_PREFIX && !url.pathname.startsWith(`${APP_PREFIX}/`)) return missing();
  let relative: string;
  try {
    relative = decodeURIComponent(url.pathname.slice(APP_PREFIX.length)).replace(/^\/+/u, "");
  } catch {
    return missing();
  }
  const root = resolve(webRoot);
  const requested = resolve(root, relative === "" ? "index.html" : relative);
  if (requested !== root && !requested.startsWith(root + sep)) return missing();
  const file = await resolveFile(root, requested);
  if (file === null) return missing();
  const data = await readFile(file).catch(() => null);
  if (data === null) return missing();
  const isIndex = file === join(root, "index.html");
  return new Response(data, {
    status: 200,
    headers: {
      "cache-control": isIndex ? "no-store" : "public, max-age=31536000, immutable",
      "content-type": contentType(file),
      "x-content-type-options": "nosniff",
    },
  });
}

async function resolveFile(root: string, requested: string): Promise<string | null> {
  const info = await stat(requested).catch(() => null);
  if (info?.isFile()) return requested;
  const index = join(root, "index.html");
  const indexInfo = await stat(index).catch(() => null);
  return indexInfo?.isFile() ? index : null;
}

function contentType(file: string): string {
  const dot = file.lastIndexOf(".");
  const extension = dot === -1 ? "" : file.slice(dot).toLowerCase();
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

function missing(): Response {
  return new Response(JSON.stringify({ error: { code: "not_found", message: "The page was not found." } }), {
    status: 404,
    headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
  });
}
