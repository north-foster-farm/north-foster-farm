// `bin/nff supply ...`: the recorded way to waive the 7-day cooldown
// for one version of one package (Case B in docs/rollback.md: an
// actively exploited flaw, fixed forward at once). The waiver is a line
// in security/cooldown-waivers.json, which the supply-chain check
// (bin/supply/check.mjs) reads, and a note in incidents/ for the
// write-up. It covers that exact version only; the signature check
// still applies. Put the printed line in the pull request too.

import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const USAGE = `
  bin/nff supply waive <package> <version> --advisory GHSA-..
      --reason "..." [--file <waivers.json>]
                                      waive the 7-day cooldown for that
                                      exact version of one package: an
                                      actively exploited flaw, fixed
                                      forward (docs/rollback.md, Case
                                      B). Records the waiver in
                                      security/cooldown-waivers.json
                                      (--file: another repository's
                                      copy) and an incident note
  bin/nff supply waivers [--file <waivers.json>]
  bin/nff supply unwaive <package> <version> [--file <waivers.json>]
                                      list the waivers, or drop one`.slice(1);

const NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const GHSA = /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/i;

const sameVersion = (entry, name, version) =>
  entry.package === name && entry.version === version;

const read = (path) => (existsSync(path)
  ? JSON.parse(readFileSync(path, "utf8"))
  : []);

const write = (path, waivers) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(waivers, null, 2)}\n`);
};

// The waiver entry, or a thrown Error saying what is wrong.
export const waiverEntry = ({ name, version, advisory, reason }, now) => {
  if (!NAME.test(name || "")) throw new Error(`"${name}" is not a package.`);
  if (!VERSION.test(version || "")) {
    throw new Error(`"${version}" is not one exact version (no ranges).`);
  }
  if (!GHSA.test(advisory || "")) {
    throw new Error("--advisory must name the GHSA id of the flaw being "
      + "fixed.");
  }
  if (typeof reason !== "string" || !reason.trim()) {
    throw new Error("--reason must say why this cannot wait out the "
      + "cooldown.");
  }

  return {
    package: name,
    version,
    advisory: `GHSA-${advisory.slice(5).toLowerCase()}`,
    reason: reason.trim(),
    date: now.toISOString().slice(0, 10),
  };
};

const incidentNote = (entry) => [
  `# Cooldown waived: ${entry.package}@${entry.version}`,
  "",
  `Date: ${entry.date}`,
  `Advisory: ${entry.advisory}`,
  `Reason: ${entry.reason}`,
  "",
  "Case B (docs/rollback.md): an actively exploited flaw, fixed forward.",
  "The waiver covers this one version of this one package; the signature",
  "check still applies. Still to do, and to record here:",
  "",
  "- [ ] Contain the exposure until the patch is live (maintenance mode,",
  "      or turn off the affected feature).",
  "- [ ] Put the waiver line in the pull request. The pull request to",
  "      main still needs James's approval.",
  "- [ ] Record what was exposed, what was exploited, and the timeline.",
  "",
].join("\n");

export const supplyCommand = async (action, rest, {
  flags, out, root, now = new Date(),
}) => {
  const file = resolve(root, flags.file || "security/cooldown-waivers.json");
  const waivers = read(file);
  const [name, version] = rest;

  if (action === "waivers") {
    if (!waivers.length) return out("No cooldown waivers.");

    for (const w of waivers) {
      out(`${w.package}@${w.version}  ${w.advisory}  ${w.date}  ${w.reason}`);
    }

    return undefined;
  }

  if (action === "unwaive") {
    const kept = waivers.filter((w) => !sameVersion(w, name, version));

    if (kept.length === waivers.length) {
      throw new Error(`No waiver for ${name}@${version}.`);
    }

    write(file, kept);

    return out(`Dropped the waiver for ${name}@${version}.`);
  }

  if (action === "waive") {
    const entry = waiverEntry({
      name, version, advisory: flags.advisory, reason: flags.reason,
    }, now);

    if (waivers.some((w) => sameVersion(w, name, version))) {
      throw new Error(`${name}@${version} is already waived.`);
    }

    write(file, [...waivers, entry]);

    const slug = `${entry.package}-${entry.version}`.replace(/[^\w.-]+/g, "-");
    const note = join(root, "incidents",
      `${entry.date}-cooldown-waiver-${slug}.md`);

    mkdirSync(dirname(note), { recursive: true });
    writeFileSync(note, incidentNote(entry));
    out(`Waived the cooldown for ${name}@${version} in `
      + `${relative(root, file) || file}; incident note: `
      + `${relative(root, note)}.`);

    return out(`For the pull request: Cooldown waived for ${name}@`
      + `${version} (${entry.advisory}, ${entry.date}): ${entry.reason}`);
  }

  throw new Error("Usage: supply waive <package> <version> --advisory "
    + "GHSA-... --reason \"...\", supply waivers, supply unwaive "
    + "<package> <version>.");
};
