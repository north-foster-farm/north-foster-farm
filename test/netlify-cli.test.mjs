import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { runNetlify } from "../bin/env/cli.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "nfp_fake-cli-token-4321";

describe("the Netlify CLI run by bin/nff", () => {
  it("hands the token over in the environment, never argv", async () => {
    const seen = [];
    const spawn = (file, argv, options) => {
      seen.push({ file, argv, options });

      const child = new EventEmitter();

      setImmediate(() => child.emit("close", 0));

      return child;
    };

    const code = await runNetlify(["env:list", "--context", "production"],
      SECRET, { spawn });

    assert.equal(code, 0);
    assert.equal(seen[0].options.env.NETLIFY_AUTH_TOKEN, SECRET);
    assert.equal(seen[0].options.stdio, "inherit");
    assert.deepEqual(seen[0].argv,
      ["netlify", "env:list", "--context", "production"]);
    assert.ok(!JSON.stringify([seen[0].file, seen[0].argv])
      .includes(SECRET));
  });

  it("passes the CLI's exit code back", async () => {
    const spawn = () => {
      const child = new EventEmitter();

      setImmediate(() => child.emit("close", 3));

      return child;
    };

    assert.equal(await runNetlify(["api"], SECRET, { spawn }), 3);
  });

  // The whole of bin/nff, with `security` and `npx` stubbed on PATH:
  // no Netlify login file is read and nothing real is called.
  it("works with only the Keychain, and prints no token", {
    skip: process.platform !== "darwin",
  }, () => {
    const dir = mkdtempSync(join(tmpdir(), "nff-cli-"));
    const log = join(dir, "log");

    try {
      writeFileSync(join(dir, "security"),
        `#!/bin/sh\necho ${SECRET}\n`);
      writeFileSync(join(dir, "npx"), `#!/bin/sh
echo "args: $*" >> "${log}"
[ "$NETLIFY_AUTH_TOKEN" = "${SECRET}" ] && echo "token set: yes" >> "${log}"
exit 7
`);
      chmodSync(join(dir, "security"), 0o755);
      chmodSync(join(dir, "npx"), 0o755);

      const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };

      delete env.NETLIFY_AUTH_TOKEN;

      const r = spawnSync("node", [join(root, "bin/nff"), "netlify",
        "env:list", "--context", "production"], { env, encoding: "utf8" });
      const written = readFileSync(log, "utf8");

      assert.equal(r.status, 7);
      assert.match(written, /args: netlify env:list --context production/);
      assert.match(written, /token set: yes/);
      assert.ok(!written.includes(`args: ${SECRET}`));
      assert.ok(!`${r.stdout}${r.stderr}`.includes(SECRET));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
