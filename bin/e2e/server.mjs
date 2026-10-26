// The HTTP side of CI's e2e server (bin/e2e/serve.mjs, which builds the
// site and loads the functions first): a built site and its functions,
// answered as Netlify answers them. Kept apart so a test can start one
// against a folder of its own.

import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, isAbsolute, join, normalize, relative } from "node:path";

import { findRedirect, headersFor, matchPath } from "./netlify-toml.mjs";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
};

// The file a URL path names inside the site, or what to do about it:
// { file }, { slash } for a folder asked for without its "/", or null.
// Nothing outside the site, however the path is spelled: an encoded
// "../" that lands in a sibling folder whose name starts with the
// site's is refused too.
export const lookup = (site, path) => {
  let decoded;

  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }

  const file = normalize(join(site, decoded));
  const rel = relative(site, file);

  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  if (path.endsWith("/")) {
    const index = join(file, "index.html");

    return existsSync(index) ? { file: index } : null;
  }
  if (existsSync(file) && statSync(file).isFile()) return { file };
  if (existsSync(join(file, "index.html"))) return { slash: `${path}/` };

  return null;
};

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];

  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => resolve(Buffer.concat(chunks)));
  req.on("error", reject);
});

const send = (res, status, headers, body) => {
  res.writeHead(status, headers);
  res.end(body);
};

// Starts the server on `host` (this machine only, unless a test says
// otherwise) and resolves with it once it listens. `functions` are
// { paths, methods, handler }; `redirects` and `headerRules` are
// netlify.toml's.
export const startServer = ({
  site, port, functions = [], redirects = [], headerRules = [],
  host = "localhost",
}) => {
  const functionFor = (path, method) => functions.find((fn) =>
    fn.paths.some((p) => matchPath(p, path) !== null)
    && (!fn.methods || fn.methods.includes(method)));

  const callFunction = async (fn, req, res, url) => {
    const headers = new Headers();

    for (const [name, value] of Object.entries(req.headers)) {
      for (const v of [value].flat()) headers.append(name, v);
    }

    const body = ["GET", "HEAD"].includes(req.method)
      ? undefined : await readBody(req);
    const request = new Request(url, { method: req.method, headers, body });
    const context = {
      ip: String(req.socket.remoteAddress || "").replace(/^::ffff:/, ""),
      waitUntil: (promise) => Promise.resolve(promise).catch(() => {}),
    };
    const answer = await fn.handler(request, context);
    const out = { ...headersFor(headerRules, url.pathname) };

    answer.headers.forEach((value, name) => {
      if (name !== "set-cookie") out[name] = value;
    });

    const cookies = answer.headers.getSetCookie();

    if (cookies.length) out["set-cookie"] = cookies;

    const payload = req.method === "HEAD"
      ? undefined : Buffer.from(await answer.arrayBuffer());

    send(res, answer.status, out, payload);
  };

  const serveFile = (res, req, path, file, status = 200) => {
    const headers = {
      ...headersFor(headerRules, path),
      "content-type": TYPES[extname(file)] || "application/octet-stream",
    };
    const body = readFileSync(file);

    headers["content-length"] = body.length;
    send(res, status, headers, req.method === "HEAD" ? undefined : body);
  };

  const redirect = (res, to, status, search) => send(res, status, {
    location: to.startsWith("http") ? to : `${to}${search}`,
  }, "");

  // Netlify's order: a function on its path; a forced redirect; a
  // file; any other redirect; 404. A 200 redirect is a rewrite: the
  // target is served under the asked-for path, once.
  const handle = async (req, res, url, rewritten = false) => {
    const path = url.pathname;
    const fn = functionFor(path, req.method);

    if (fn) return callFunction(fn, req, res, url);

    const forced = findRedirect(redirects, path, { forced: true });
    const found = lookup(site, path);
    const rule = forced
      || (found ? null : findRedirect(redirects, path, { forced: false }));

    if (rule && rule.status === 200 && !rewritten) {
      return handle(req, res, new URL(rule.to, url), true);
    }
    if (rule && rule.status !== 200) {
      return redirect(res, rule.to, rule.status, url.search);
    }
    if (found && found.file) return serveFile(res, req, path, found.file);
    if (found && found.slash) {
      return redirect(res, found.slash, 301, url.search);
    }

    const missing = join(site, "404.html");

    if (existsSync(missing)) return serveFile(res, req, path, missing, 404);

    return send(res, 404, { "content-type": "text/plain" }, "Not found\n");
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    handle(req, res, url).catch((error) => {
      console.error(`e2e:serve: ${req.method} ${url.pathname}:`, error);
      if (!res.headersSent) send(res, 500, {}, "Server error\n");
      else res.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
};
