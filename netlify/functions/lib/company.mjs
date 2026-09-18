// The company data file, for the functions. It is two levels of
// `key: "value"` and nothing else, so a few lines read it and the
// site keeps one copy of its name, address, phone and email.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const parse = (yaml) => {
  const out = {};
  let section = null;

  for (const raw of yaml.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "");
    const m = line.match(/^(\s*)([A-Za-z_]+):\s*(.*)$/);

    if (!m) continue;

    const [, indent, key, rest] = m;
    const value = rest.replace(/^"(.*)"$/, "$1");

    if (indent === "") {
      if (rest === "") {
        section = key;
        out[key] = {};
      } else {
        section = null;
        out[key] = value;
      }
    } else if (section) {
      out[section][key] = value;
    }
  }

  return out;
};

export const company = parse(
  readFileSync(join(here, "../../../data/company.yaml"), "utf8")
);
