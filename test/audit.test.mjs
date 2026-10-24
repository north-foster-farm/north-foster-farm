import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import {
  collectFindings, main, patchedVersion,
} from "../bin/audit/check.mjs";
import {
  actionFindings, evaluate, incompleteExceptions, npmFindings,
  usesFromWorkflow,
} from "../bin/audit/findings.mjs";
import { alertBody, deployedSha, prodAudit } from "../bin/audit/prod.mjs";

const advisoryUrl = (id) => `https://github.com/advisories/${id}`;

const via = (source, id) => ({
  source, severity: "high", url: advisoryUrl(id),
});

const report = {
  vulnerabilities: {
    "fast-uri": {
      fixAvailable: true,
      via: [via(1, "GHSA-aaaa-bbbb-cccc"), via(2, "GHSA-aaaa-bbbb-cccc")],
    },
    braces: {
      fixAvailable: { name: "postcss-cli", version: "12.0.0" },
      via: [via(3, "GHSA-dddd-eeee-ffff")],
    },
    chokidar: { fixAvailable: false, via: ["braces"] },
    odd: {
      fixAvailable: false,
      via: [{ source: 4, severity: "low", url: "https://example.com/x" }],
    },
  },
};

const finding = (pkg, advisory, fix = null) => ({
  package: pkg, advisory, severity: "high", fix,
});
const patchedFinding = (pkg, advisory, patched = null) => ({
  ...finding(pkg, advisory), patched,
});
const exception = (pkg, advisory, extra = {}) => ({
  package: pkg, advisory, why: "w", exposure: "e", plan: "p", ...extra,
});

describe("npmFindings", () => {
  it("lists each advisory once and skips chain-only packages", () => {
    assert.deepEqual(npmFindings(report), [
      finding("fast-uri", "GHSA-aaaa-bbbb-cccc", "available"),
      finding("braces", "GHSA-dddd-eeee-ffff", "postcss-cli@12.0.0"),
      { package: "odd", advisory: "npm-4", severity: "low", fix: null },
    ]);
  });
});

describe("usesFromWorkflow", () => {
  it("reads the version comment, else the ref, and skips local uses", () => {
    const text = [
      "      - uses: actions/checkout@abc123 # v5.1.0",
      "      - uses: owner/repo/sub@v2",
      "      - uses: ./local",
      "        uses: docker://alpine",
    ].join("\n");

    assert.deepEqual(usesFromWorkflow(text), [
      { repo: "actions/checkout", version: "5.1.0" },
      { repo: "owner/repo", version: "2" },
    ]);
  });
});

describe("actionFindings", () => {
  it("takes the patched version for the action's own package", () => {
    const advisories = [{
      "ghsa_id": "GHSA-1111-2222-3333",
      severity: "high",
      vulnerabilities: [
        { package: { name: "Owner/Repo" }, "first_patched_version": "46.0.1" },
      ],
    }];

    assert.deepEqual(actionFindings("owner/repo", advisories), [{
      ...finding("owner/repo", "GHSA-1111-2222-3333", "46.0.1"),
      patched: "46.0.1",
    }]);
  });

  it("takes a patched release line listed after an unpatched one", () => {
    const advisories = [{
      "ghsa_id": "GHSA-1111-2222-3333",
      severity: "high",
      vulnerabilities: [
        { package: { name: "owner/repo" }, "first_patched_version": null },
        { package: { name: "owner/repo" }, "first_patched_version": "2.0.1" },
      ],
    }];

    assert.equal(actionFindings("owner/repo", advisories)[0].patched,
      "2.0.1");
  });
});

describe("evaluate", () => {
  it("separates unresolved, excepted, re-raised and stale", () => {
    const findings = [
      patchedFinding("a", "GHSA-1"),
      patchedFinding("b", "GHSA-2"),
      patchedFinding("c", "GHSA-3", "3.0.1"),
      patchedFinding("d", "GHSA-4", "4.0.1"),
    ];
    const exceptions = [
      exception("b", "GHSA-2"),
      exception("c", "GHSA-3"),
      exception("d", "GHSA-4", { reraisedFor: "4.0.1" }),
      exception("gone", "GHSA-9"),
    ];
    const result = evaluate(findings, exceptions);

    assert.deepEqual(result.unresolved.map((f) => f.package), ["a"]);
    assert.deepEqual(result.reraised.map((f) => f.package), ["c"]);
    assert.deepEqual(result.excepted.map((f) => f.package), ["b", "d"]);
    assert.deepEqual(result.stale.map((e) => e.package), ["gone"]);
  });

  it("re-raises an acknowledged exception when a newer fix ships", () => {
    const result = evaluate([patchedFinding("d", "GHSA-4", "4.0.2")],
      [exception("d", "GHSA-4", { reraisedFor: "4.0.1" })]);

    assert.equal(result.reraised.length, 1);
  });

  it("ignores npm's fix hint while nothing is patched", () => {
    const hinted = { ...finding("e", "GHSA-5", "other@7.0.2"), patched: null };
    const result = evaluate([hinted], [exception("e", "GHSA-5")]);

    assert.equal(result.reraised.length, 0);
    assert.equal(result.excepted.length, 1);
  });
});

describe("incompleteExceptions", () => {
  it("names an exception missing any of the five fields", () => {
    const missing = { package: "a", advisory: "GHSA-1", why: "w", plan: "p" };

    assert.deepEqual(
      incompleteExceptions([exception("b", "GHSA-2"), missing]),
      ["a|GHSA-1"],
    );
  });
});

describe("collectFindings", () => {
  it("audits each lockfile directory and each distinct action", async () => {
    const dirs = [];
    const asked = [];
    const findings = await collectFindings({
      lockfiles: ["/x/y/package-lock.json"],
      workflows: ["- uses: o/r@s # v1.0.0", "- uses: o/r@s # v1.0.0"],
      audit: async (dir) => {
        dirs.push(dir);

        return report;
      },
      advisories: async (repo, version) => {
        asked.push(`${repo}@${version}`);

        return [];
      },
    });

    assert.deepEqual(dirs, ["/x/y"]);
    assert.deepEqual(asked, ["o/r@1.0.0"]);
    assert.equal(findings.length, 3);
  });

  it("looks up a patched version only for excepted findings, once each",
    async () => {
      const asked = [];
      const findings = await collectFindings({
        lockfiles: ["/a/package-lock.json", "/b/package-lock.json"],
        audit: async () => report,
        exceptions: [
          exception("braces", "GHSA-dddd-eeee-ffff"),
          exception("odd", "npm-4"),
        ],
        patched: async (pkg, advisory) => {
          asked.push(`${pkg} ${advisory}`);

          return "3.0.4";
        },
      });
      const patchedOf = (pkg) =>
        findings.find((f) => f.package === pkg).patched;

      assert.deepEqual(asked, ["braces GHSA-dddd-eeee-ffff"]);
      assert.equal(patchedOf("braces"), "3.0.4");
      assert.equal(patchedOf("fast-uri"), null);
      // No GHSA id to look up: npm's own fix stands in, here none.
      assert.equal(patchedOf("odd"), null);
    });
});

describe("patchedVersion", () => {
  const answer = (body, ok = true) => async (url) => {
    assert.match(url, /\/advisories\/GHSA-dddd-eeee-ffff$/);

    return { ok, status: ok ? 200 : 503, json: async () => body };
  };
  const vulnerable = (name, first) => ({
    vulnerabilities: [
      { package: { ecosystem: "npm", name: "other" },
        "first_patched_version": "9.9.9" },
      { package: { ecosystem: "npm", name },
        "first_patched_version": first },
    ],
  });

  it("is the package's first patched version, or null while none", async () => {
    assert.equal(await patchedVersion("braces", "GHSA-dddd-eeee-ffff",
      answer(vulnerable("braces", "3.0.4"))), "3.0.4");
    assert.equal(await patchedVersion("braces", "GHSA-dddd-eeee-ffff",
      answer(vulnerable("braces", null))), null);
  });

  it("re-raises when any release line is patched", async () => {
    const lines = {
      vulnerabilities: [
        { package: { ecosystem: "npm", name: "braces" },
          "first_patched_version": null },
        { package: { ecosystem: "npm", name: "braces" },
          "first_patched_version": "2.0.1" },
      ],
    };

    assert.equal(await patchedVersion("braces", "GHSA-dddd-eeee-ffff",
      answer(lines)), "2.0.1");
  });

  it("throws rather than guess", async () => {
    await assert.rejects(patchedVersion("braces", "GHSA-dddd-eeee-ffff",
      answer({}, false)), /HTTP 503/);
    await assert.rejects(patchedVersion("braces", "GHSA-dddd-eeee-ffff",
      answer(vulnerable("micromatch", "4.0.9"))), /does not name braces/);
  });
});

// An excepted advisory with no patched version, and npm hinting at a
// downgrade of another package, as braces stood on 2026-10-20.
const bracesReport = async () => ({
  vulnerabilities: {
    braces: {
      fixAvailable: { name: "@fullhuman/postcss-purgecss", version: "7.0.2" },
      via: [via(3, "GHSA-dddd-eeee-ffff")],
    },
  },
});
const bracesException = (extra) =>
  exception("braces", "GHSA-dddd-eeee-ffff", extra);

describe("main: an excepted package ships a fix", () => {
  const check = async (patched, extra) => {
    const log = mock.method(console, "log", () => {});

    try {
      const code = await main(["--details", "/x/package-lock.json"], {
        exceptions: [bracesException(extra)],
        audit: bracesReport,
        patched: async () => patched,
      });

      return {
        code,
        printed: log.mock.calls.map((c) => c.arguments[0]).join("\n"),
      };
    } finally {
      log.mock.restore();
    }
  };

  it("passes while no patched version exists", async () => {
    const { code, printed } = await check(null);

    assert.equal(code, 0);
    assert.match(printed, /excepted: 1/);
  });

  it("fails once one does, with no change to the exception", async () => {
    const { code, printed } = await check("3.0.4");

    assert.equal(code, 1);
    assert.match(printed, /exceptions to re-raise: 1/);
    assert.match(printed,
      /re-raise braces GHSA-dddd-eeee-ffff \(patched: 3\.0\.4\)/);
  });

  it("passes again only once James records reraisedFor", async () => {
    assert.equal((await check("3.0.4", { reraisedFor: "3.0.4" })).code, 0);
    assert.equal((await check("3.0.5", { reraisedFor: "3.0.4" })).code, 1);
  });

  it("fails when the advisory database cannot be asked", async () => {
    const log = mock.method(console, "log", () => {});

    try {
      await assert.rejects(main(["/x/package-lock.json"], {
        exceptions: [bracesException()],
        audit: bracesReport,
        patched: async () => {
          throw new Error("advisory GHSA-dddd-eeee-ffff: HTTP 503");
        },
      }), /HTTP 503/);
    } finally {
      log.mock.restore();
    }
  });
});

describe("main", () => {
  it("prints counts only inside GitHub Actions",
    async () => {
      const log = mock.method(console, "log", () => {});
      const before = process.env.GITHUB_ACTIONS;

      process.env.GITHUB_ACTIONS = "true";

      try {
        const code = await main([], { exceptions: [] });
        const printed = log.mock.calls.map((c) => c.arguments[0]).join("\n");

        assert.equal(code, 0);
        assert.match(printed, /unresolved: 0/);
      } finally {
        if (before === undefined) delete process.env.GITHUB_ACTIONS;
        else process.env.GITHUB_ACTIONS = before;
        log.mock.restore();
      }
    });
});

describe("deployedSha", () => {
  const sha = "a".repeat(40);

  it("reads the data-build attribute", () => {
    assert.equal(deployedSha(`<script data-build="${sha}"></script>`), sha);
  });

  it("is null when the page has no marker or an empty one", () => {
    assert.equal(deployedSha("<html></html>"), null);
    assert.equal(deployedSha('<script data-build=""></script>'), null);
  });
});

describe("prodAudit", () => {
  const sha = "b".repeat(40);
  const exposed = async () => ({
    vulnerabilities: {
      "secret-pkg": {
        fixAvailable: true,
        via: [via(1, "GHSA-zzzz-yyyy-xxxx")],
      },
    },
  });
  const clean = async () => ({ vulnerabilities: {} });

  const setup = (audit, more = {}) => {
    const pings = [];
    const urls = [];
    const fetchImpl = async (url, options) => {
      urls.push(url);

      if (options?.method === "POST") {
        pings.push({ url, body: options.body });

        return { ok: true };
      }

      return { ok: true, text: async () => `<script data-build="${sha}">` };
    };
    const log = mock.method(console, "log", () => {});
    const run = () => prodAudit({
      env: { PROD_AUDIT_PING_URL: "https://hc/ping/x" },
      fetchImpl, audit, exceptions: [], ...more,
    });

    return { pings, urls, log, run };
  };

  it("pings the check when clean", async () => {
    const { pings, log, run } = setup(clean);

    try {
      assert.equal(await run(), 0);
      assert.equal(pings[0].url, "https://hc/ping/x");
    } finally {
      log.mock.restore();
    }
  });

  it("audits the deployed commit and alerts privately on a finding",
    async () => {
      const { pings, urls, log, run } = setup(exposed);

      try {
        assert.equal(await run(), 1);
        assert.ok(urls.some((u) => u.includes(`/${sha}/package-lock.json`)));
        assert.equal(pings[0].url, "https://hc/ping/x/fail");
        assert.match(pings[0].body, /secret-pkg GHSA-zzzz-yyyy-xxxx/);

        const printed = log.mock.calls.map((c) => c.arguments[0]).join("\n");

        assert.doesNotMatch(printed, /secret-pkg|GHSA/);
      } finally {
        log.mock.restore();
      }
    });

  it("alerts once an excepted package ships a fix", async () => {
    const quiet = setup(bracesReport, {
      exceptions: [bracesException()], patched: async () => null,
    });
    const fixed = setup(bracesReport, {
      exceptions: [bracesException()], patched: async () => "3.0.4",
    });

    try {
      assert.equal(await quiet.run(), 0);
      assert.equal(quiet.pings[0].url, "https://hc/ping/x");
      assert.equal(await fixed.run(), 1);
      assert.equal(fixed.pings[0].url, "https://hc/ping/x/fail");
      assert.match(fixed.pings[0].body,
        /re-raise braces GHSA-dddd-eeee-ffff \(patched: 3\.0\.4\)/);
    } finally {
      quiet.log.mock.restore();
      fixed.log.mock.restore();
    }
  });

  it("fails loudly when no ping URL is set", async () => {
    const log = mock.method(console, "log", () => {});

    try {
      assert.equal(await prodAudit({ env: {}, exceptions: [] }), 1);
    } finally {
      log.mock.restore();
    }
  });
});

describe("alertBody", () => {
  it("names the ref and each finding", () => {
    const result = evaluate([finding("a", "GHSA-1")], []);

    assert.match(alertBody(result, "main"), /main\.\nunresolved a GHSA-1/);
  });
});
