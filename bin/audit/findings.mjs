// Turns what `npm audit` and the GitHub advisory database report into
// findings, and sets them against the recorded exceptions
// (security/exceptions.json). Pure functions; check.mjs does the I/O.
//
// A finding is { package, advisory, severity, fix }. `fix` is what
// would resolve it (a version or "available"), or null when nothing
// does yet.

const GHSA = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i;

// The advisories in one `npm audit --json` report. A package that is
// vulnerable only through another one (its `via` holds a name, not an
// advisory) adds nothing: the advisory sits on the package it names.
export const npmFindings = (report) => {
  const found = new Map();

  for (const [name, vuln] of Object.entries(report.vulnerabilities || {})) {
    const fix = vuln.fixAvailable === true
      ? "available"
      : vuln.fixAvailable
        ? `${vuln.fixAvailable.name}@${vuln.fixAvailable.version}`
        : null;

    for (const via of vuln.via || []) {
      if (typeof via === "string") continue;

      const advisory = GHSA.exec(via.url || "")?.[0] || `npm-${via.source}`;

      found.set(`${name}|${advisory}`, {
        package: name, advisory, severity: via.severity, fix,
      });
    }
  }

  return [...found.values()];
};

// The actions a workflow uses, as { repo, version }. The version is
// the `# v1.2.3` comment after a pinned SHA, else the ref itself.
export const usesFromWorkflow = (text) => {
  const found = [];
  const uses = /^\s*-?\s*uses:\s*([^\s@]+)@(\S+)(?:\s+#\s*v?(\S+))?/gm;

  for (const [, path, ref, comment] of String(text).matchAll(uses)) {
    if (path.startsWith(".") || path.startsWith("docker:")) continue;

    found.push({
      repo: path.split("/").slice(0, 2).join("/"),
      version: comment || ref.replace(/^v/, ""),
    });
  }

  return found;
};

// The findings in a list of GitHub advisories returned for one action.
export const actionFindings = (repo, advisories) => advisories.map((a) => {
  const hit = (a.vulnerabilities || []).find(
    (v) => v.package?.name?.toLowerCase() === repo.toLowerCase(),
  ) || (a.vulnerabilities || [])[0] || {};

  return {
    package: repo,
    advisory: a.ghsa_id,
    severity: a.severity,
    fix: hit.first_patched_version || null,
  };
});

const keyOf = (item) => `${item.package}|${item.advisory}`;

// Sorts findings against the exceptions:
//   unresolved  no exception covers it
//   reraised    an exception covers it but a fix has since shipped, and
//               James has not yet acknowledged that fix (an exception's
//               `reraisedFor` names the fix he looked at)
//   excepted    covered, and nothing new to decide
// `stale` lists exceptions whose advisory no longer shows up.
export const evaluate = (findings, exceptions) => {
  const byKey = new Map(exceptions.map((e) => [keyOf(e), e]));
  const seen = new Set(findings.map(keyOf));
  const result = { unresolved: [], reraised: [], excepted: [], stale: [] };

  for (const finding of findings) {
    const exception = byKey.get(keyOf(finding));

    if (!exception) result.unresolved.push(finding);
    else if (finding.fix && exception.reraisedFor !== finding.fix) {
      result.reraised.push(finding);
    } else result.excepted.push(finding);
  }

  result.stale = exceptions.filter((e) => !seen.has(keyOf(e)));

  return result;
};

// An exception is complete only with all five fields James asked for.
export const incompleteExceptions = (exceptions) => exceptions
  .filter((e) => !["package", "advisory", "why", "exposure", "plan"]
    .every((field) => typeof e[field] === "string" && e[field].trim()))
  .map(keyOf);
