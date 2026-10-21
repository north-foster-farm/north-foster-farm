// What CI's e2e server (bin/e2e/serve.mjs) needs of netlify.toml: its
// redirects and its headers, read as Netlify reads them. The parser
// covers the TOML this file uses (tables, arrays of tables, strings
// of all four kinds, numbers, booleans, one-line arrays), not all of
// TOML, so the server needs no package and nothing to vet.

// One value on the right of `=`, up to an unquoted `#`.
const scalar = (raw) => {
  const text = raw.trim();

  if (text.startsWith("\"")) {
    let end = 1;

    while (end < text.length && text[end] !== "\"") {
      end += text[end] === "\\" ? 2 : 1;
    }
    return JSON.parse(text.slice(0, end + 1));
  }
  if (text.startsWith("'")) return text.slice(1, text.indexOf("'", 1));

  const bare = text.replace(/\s+#.*$/, "");

  if (bare === "true" || bare === "false") return bare === "true";
  if (/^[+-]?\d+(\.\d+)?$/.test(bare)) return Number(bare);
  if (bare.startsWith("[")) return JSON.parse(bare.replace(/'/g, "\""));

  return bare;
};

// -> the file as nested objects; [[name]] tables are arrays.
export const parseToml = (text) => {
  const root = {};
  const lines = text.split("\n");
  let table = root;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    let m;

    if (!line || line.startsWith("#")) continue;
    if ((m = line.match(/^\[\[([\w.-]+)\]\]$/))) {
      table = {};
      (root[m[1]] ||= []).push(table);
      continue;
    }
    if ((m = line.match(/^\[([\w.-]+)\]$/))) {
      const [head, ...rest] = m[1].split(".");
      let base = Array.isArray(root[head])
        ? root[head][root[head].length - 1]
        : (root[head] ||= {});

      for (const key of rest) base = (base[key] ||= {});
      table = base;
      continue;
    }
    m = line.match(/^([\w-]+|"[^"]+")\s*=\s*(.*)$/);
    if (!m) continue;

    const key = m[1].replace(/^"|"$/g, "");
    const quote = m[2].slice(0, 3);

    if (quote === "\"\"\"" || quote === "'''") {
      let body = m[2].slice(3);

      while (!body.includes(quote) && i + 1 < lines.length) {
        i += 1;
        body += `\n${lines[i]}`;
      }
      body = body.slice(0, body.indexOf(quote)).replace(/^\n/, "");
      // A backslash at a line's end folds away the newline and the
      // whitespace after it.
      if (quote === "\"\"\"") body = body.replace(/\\\s*\n\s*/g, "");
      table[key] = body;
      continue;
    }
    table[key] = scalar(m[2]);
  }

  return root;
};

// A Netlify path pattern: exact, or ending in `*` for any rest of it.
const pattern = (from) => (from.endsWith("*")
  ? { prefix: from.slice(0, -1) }
  : { exact: from });

// -> the splat (what `*` matched, "" for an exact match) or null.
export const matchPath = (from, path) => {
  const p = pattern(from);

  if (p.exact !== undefined) return p.exact === path ? "" : null;

  return path.startsWith(p.prefix) ? path.slice(p.prefix.length) : null;
};

// The first redirect rule for a path. `forced` picks the rules that
// apply even over a file that exists (force = true) or the rest.
export const findRedirect = (redirects, path, { forced }) => {
  for (const rule of redirects) {
    if (!!rule.force !== forced) continue;

    const splat = matchPath(rule.from, path);

    if (splat !== null) {
      return {
        to: String(rule.to).replace(":splat", splat),
        status: rule.status || 301,
      };
    }
  }

  return null;
};

// Every header the rules set for a path, later rules winning, each
// value on one line: a header cannot hold a newline.
export const headersFor = (rules, path) => {
  const out = {};

  for (const rule of rules) {
    if (matchPath(rule.for, path) === null) continue;
    for (const [name, value] of Object.entries(rule.values || {})) {
      out[name] = String(value).replace(/\s+/g, " ").trim();
    }
  }

  return out;
};
