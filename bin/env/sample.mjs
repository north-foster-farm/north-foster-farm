// Reads the tracked env samples (#264), in the layout James set
// (#244, 6211853356) and his launch guide writes:
//
//   ### .env.staging.sample          the file's header, ### lines
//
//   ## Square                        a group: its title, a bare ##,
//   ##                               then where to log in and where
//   ## Log in at ...                 the keys live
//
//   # SQUARE_ACCESS_TOKEN            a key's block: its name, then
//   # What it is for.                its purpose; "# Local only:"
//   SQUARE_ACCESS_TOKEN=             marks a key Netlify never gets
//
// A key left empty in the staging or production sample is a secret:
// its value lives in the ignored .env.staging or .env.production and
// on Netlify, never in the repository. "# Public:" marks an empty key
// that is not (an application id, an address): its value is in the env
// file and on Netlify as a plain variable.

import { unquote } from "../../netlify/functions/lib/env.mjs";

const NAME = /^[A-Z][A-Z0-9_]*$/;
const LOCAL = /(^|[^a-z])Local only:/;
const PUBLIC = /(^|[^a-z])Public:/;
const OPTIONAL = /(^|[^a-z])Optional:/;
const EXPORT = /^export\s+/;

// Never pushed, whatever a sample's comments say: the tools' own
// credentials and Netlify's own pointer, read only on James's Mac.
export const NEVER_PUSHED = new Set([
  "NETLIFY_AUTH_TOKEN", "NETLIFY_SITE_ID",
]);

// The environments that have a sample, and the file each is in.
export const ENVIRONMENTS = ["development", "staging", "production"];
export const sampleFile = (env) => `.env.${env}.sample`;

// Text -> { header, groups, entries, errors }. Each entry: { name,
// group, purpose, local, public, value, line }. Errors name lines and keys,
// never values.
export const parseSample = (text) => {
  const header = [];
  const groups = [];
  const entries = [];
  const errors = [];
  const seen = new Set();
  let group = null;
  let block = null;
  let inAbout = false;

  String(text).split("\n").forEach((raw, i) => {
    const line = raw.trimEnd();
    const at = i + 1;

    if (line.startsWith("###")) {
      if (groups.length || entries.length) {
        errors.push(`Line ${at}: a ### header line after the header.`);
      } else {
        header.push(line.replace(/^###\s?/, ""));
      }
    } else if (line.startsWith("##")) {
      const words = line.replace(/^##\s?/, "");

      if (block) {
        errors.push(`Line ${at}: ${block.name} has no ${block.name}= line.`);
        block = null;
      }
      if (group && inAbout) {
        if (words) group.about.push(words);
      } else if (!words) {
        errors.push(`Line ${at}: a ## line with no group title.`);
      } else {
        group = { title: words, about: [] };
        groups.push(group);
        inAbout = true;
      }
    } else if (line.startsWith("#")) {
      const words = line.replace(/^#\s?/, "");

      inAbout = false;
      if (block) {
        if (LOCAL.test(words)) block.local = true;
        if (PUBLIC.test(words)) block.public = true;
        if (OPTIONAL.test(words)) block.optional = true;
        block.purpose.push(words);
      } else if (NAME.test(words)) {
        block = {
          name: words, purpose: [], local: false, public: false,
          optional: false,
        };
      } else {
        errors.push(`Line ${at}: a comment outside a key's block.`);
      }
    } else if (!line.trim()) {
      inAbout = false;
      if (block && !block.purpose.length) {
        errors.push(`Line ${at}: ${block.name} has no purpose line.`);
      }
    } else {
      const bare = line.replace(EXPORT, "");
      const eq = bare.indexOf("=");
      const name = eq > 0 ? bare.slice(0, eq).trim() : "";

      inAbout = false;
      if (bare !== line) errors.push(`Line ${at}: drop the export.`);
      if (!NAME.test(name)) {
        errors.push(`Line ${at}: not a KEY=value line.`);

        return;
      }
      if (!block) {
        errors.push(`Line ${at}: ${name} has no comment block.`);
      } else if (block.name !== name) {
        errors.push(`Line ${at}: ${name} follows the block for ${
          block.name}.`);
      } else if (!block.purpose.length) {
        errors.push(`Line ${at}: ${name} has no purpose line.`);
      }
      if (!group) errors.push(`Line ${at}: ${name} is in no ## group.`);
      if (seen.has(name)) errors.push(`Line ${at}: ${name} again.`);
      seen.add(name);
      entries.push({
        name,
        group: group ? group.title : null,
        purpose: block && block.name === name ? block.purpose : [],
        local: !!(block && block.name === name && block.local),
        public: !!(block && block.name === name && block.public),
        optional: !!(block && block.name === name && block.optional),
        value: unquote(bare.slice(eq + 1)),
        line: at,
      });
      block = null;
    }
  });

  if (block) errors.push(`${block.name} has no ${block.name}= line.`);
  if (!header.length) errors.push("No ### header at the top.");

  return { header, groups, entries, errors };
};

// What a sample means for its environment. -> { keys, local, secrets,
// errors }: the names Netlify gets, the names it never gets, and of
// the first, those whose value is a secret (empty in the sample;
// development has none, since its sample holds a working value for
// every key).
export const readSample = (text, env) => {
  const parsed = parseSample(text);
  const keys = [];
  const local = [];
  const secrets = [];
  const optional = [];
  const errors = [...parsed.errors];

  for (const e of parsed.entries) {
    if (e.local || NEVER_PUSHED.has(e.name)) {
      local.push(e.name);
    } else {
      keys.push(e.name);
      if (e.optional) optional.push(e.name);
      if (!e.value) {
        if (env === "development") {
          if (!e.optional) {
            errors.push(`${e.name} has no value; development needs one.`);
          }
        } else if (!e.public) {
          secrets.push(e.name);
        }
      }
    }
  }

  return { keys, local, secrets, optional, errors };
};

// A filled-in env file (.env.staging, .env.production): any layout,
// comments ignored. -> { values: Map name -> value, errors }.
export const readValues = (text) => {
  const values = new Map();
  const errors = [];

  String(text).split("\n").forEach((raw, i) => {
    const line = raw.trim().replace(EXPORT, "");

    if (!line || line.startsWith("#")) return;

    const eq = line.indexOf("=");
    const name = eq > 0 ? line.slice(0, eq).trim() : "";

    if (!NAME.test(name)) {
      errors.push(`Line ${i + 1}: not a KEY=value line.`);
    } else if (values.has(name)) {
      errors.push(`Line ${i + 1}: ${name} again.`);
    } else {
      values.set(name, unquote(line.slice(eq + 1)));
    }
  });

  return { values, errors };
};
