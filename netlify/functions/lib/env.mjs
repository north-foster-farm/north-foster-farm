// Loads a .env file into process.env for scripts run off Netlify.
// KEY=value lines, optional quotes, # comments. Never overrides a
// variable that is already set.

import { existsSync, readFileSync } from "node:fs";

// A value as written after the "=". Double quotes may escape \n, \"
// and \\, as James's launch guide writes them; single quotes are
// literal.
export const unquote = (written) => {
  const value = written.trim();

  if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\([n"\\])/g,
      (_, c) => (c === "n" ? "\n" : c));
  }
  if (value.length > 1 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }

  return value;
};

export const loadEnv = (path) => {
  if (!existsSync(path)) return {};

  const loaded = {};

  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();

    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");

    if (eq < 1) continue;

    const key = line.slice(0, eq).trim();
    const value = unquote(line.slice(eq + 1));

    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded[key] = value;
    }
  }

  return loaded;
};
