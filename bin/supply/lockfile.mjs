// What a package-lock.json resolves, and the two judgments the supply
// chain check makes about each package. Pure functions; the registry
// and the file system stay in check.mjs.

const DAY = 24 * 60 * 60 * 1000;

// Every registry package a lockfile pins, once per name and version.
// The root, linked workspaces and anything not fetched from a registry
// (a git or file dependency) have no publish date to judge.
export const resolvedPackages = (lock) => {
  const seen = new Map();

  for (const [path, entry] of Object.entries(lock.packages || {})) {
    if (!path || entry.link || !entry.version) continue;
    if (!/^https?:/.test(entry.resolved || "")) continue;

    // An npm alias ("string-width-cjs": "npm:string-width@4") sits at
    // the alias path but names the real package in `name`.
    const name = entry.name
      || path.slice(path.lastIndexOf("node_modules/") + 13);

    seen.set(`${name}@${entry.version}`, { name, version: entry.version });
  }

  return [...seen.values()];
};

// The packages published less than `days` days before `now`, minus the
// ones a waiver names. `published` maps "name@version" to an ISO date.
// A package with no known date is returned too, as unknown: a check
// that cannot tell must not pass.
export const tooNew = (packages, published, now, days, waivers = []) => {
  const waived = new Set(waivers.map((w) => `${w.package}@${w.version}`));
  const young = [];
  const unknown = [];

  for (const { name, version } of packages) {
    const key = `${name}@${version}`;

    if (waived.has(key)) continue;

    const when = Date.parse(published[key]);

    if (Number.isNaN(when)) unknown.push(key);
    else if (now - when < days * DAY) young.push(key);
  }

  return { young, unknown };
};

// The packages whose resolved version has no provenance attestation and
// whose name is not in the approved baseline. `attested` maps
// "name@version" to true or false.
export const newlyUnattested = (packages, attested, baseline) => {
  const approved = new Set(baseline);

  return packages
    .filter(({ name, version }) => attested[`${name}@${version}`] === false)
    .map(({ name }) => name)
    .filter((name) => !approved.has(name))
    .filter((name, i, all) => all.indexOf(name) === i)
    .sort();
};
