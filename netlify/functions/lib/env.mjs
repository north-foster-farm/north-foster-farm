// Loads a .env file into process.env for scripts run off Netlify.
// KEY=value lines, optional quotes, # comments. Never overrides a
// variable that is already set.

import { existsSync, readFileSync } from "node:fs";

export const loadEnv = (path) => {
  if (!existsSync(path)) return {};

  const loaded = {};

  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();

    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");

    if (eq < 1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded[key] = value;
    }
  }

  return loaded;
};
