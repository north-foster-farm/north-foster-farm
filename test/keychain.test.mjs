import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ACCOUNT, SERVICE, STORE_COMMAND, keychainToken, tokenInFiles,
} from "../bin/env/keychain.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "nfp_fake-keychain-token-9876";

// A stand-in for `security`: records its arguments, answers or fails.
const stub = (answer) => {
  const calls = [];
  const run = (file, args) => {
    calls.push([file, ...args]);
    if (answer instanceof Error) throw answer;

    return answer;
  };

  return { run, calls };
};
const exit = (status) => Object.assign(new Error("Command failed"), { status });

describe("the Netlify token in the Keychain", () => {
  it("asks `security` for the one item and trims the answer", () => {
    const { run, calls } = stub(`${SECRET}\n`);

    assert.equal(keychainToken({ run, platform: "darwin" }), SECRET);
    assert.deepEqual(calls, [["security", "find-generic-password",
      "-a", ACCOUNT, "-s", SERVICE, "-w"]]);
  });

  it("says plainly that the item is missing, and how to store it", () => {
    const { run } = stub(exit(44));

    assert.throws(() => keychainToken({ run, platform: "darwin" }),
      (error) => {
        assert.match(error.message, /no "nff-netlify-auth-token" item/);
        assert.ok(error.message.includes(STORE_COMMAND));

        return true;
      });
  });

  it("stores the token by prompt, never on the command line", () => {
    assert.match(STORE_COMMAND, /^security add-generic-password /);
    assert.match(STORE_COMMAND, / -w$/);
    assert.ok(!/ -w \S/.test(STORE_COMMAND));
  });

  it("reports a locked or refused Keychain without any value", () => {
    const { run } = stub(exit(51));

    assert.throws(() => keychainToken({ run, platform: "darwin" }),
      /would not give up .* exited 51/);
  });

  it("refuses an empty item and any platform but a Mac", () => {
    assert.throws(() => keychainToken({ run: stub("  \n").run,
      platform: "darwin" }), /is empty/);
    assert.throws(() => keychainToken({ run: stub(SECRET).run,
      platform: "linux" }), /isn't a Mac/);
  });

  it("never puts the token in an error", () => {
    for (const answer of [exit(44), exit(1), ""]) {
      try {
        keychainToken({ run: stub(answer).run, platform: "darwin" });
      } catch (error) {
        assert.ok(!error.message.includes(SECRET));
      }
    }
  });
});

describe("no env file holds the Netlify token", () => {
  it("names each file that sets it, and nothing else", () => {
    const files = {
      ".env": "SITE_URL=x\n",
      ".env.staging": "NETLIFY_AUTH_TOKEN=abc\n",
      ".env.production.sample": "# NETLIFY_AUTH_TOKEN\nNETLIFY_SITE_ID=1\n",
      ".env.sample": "  export NETLIFY_AUTH_TOKEN = abc\n",
      "notes.md": "NETLIFY_AUTH_TOKEN=abc\n",
    };
    const found = tokenInFiles("/r", {
      list: () => Object.keys(files),
      read: (path) => files[path.slice(3)],
    });

    assert.deepEqual(found, [
      ".env.sample: sets NETLIFY_AUTH_TOKEN, which lives only in the " +
        "Keychain.",
      ".env.staging: sets NETLIFY_AUTH_TOKEN, which lives only in the " +
        "Keychain.",
    ]);
    assert.ok(!found.join().includes("abc"));
  });

  it("holds for this repository's samples", () => {
    assert.deepEqual(tokenInFiles(root), []);
  });

  it("holds for the code: nothing reads the token from a file", () => {
    for (const name of ["nff"]) {
      const text = readFileSync(join(root, "bin", name), "utf8");

      assert.ok(!/values\.get\("NETLIFY_AUTH_TOKEN"\)/.test(text));
    }
    assert.ok(readdirSync(join(root, "bin")).includes("env"));
  });
});
