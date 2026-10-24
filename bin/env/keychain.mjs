// Where bin/nff gets NETLIFY_AUTH_TOKEN (#267): the macOS Keychain,
// once, and no env file. A personal access token carries every
// permission its owner has on Netlify, so it lives in one place that
// is locked and not copied around. Stored by James with
//
//   security add-generic-password -a nff -s nff-netlify-auth-token -U -w
//
// which asks for the value instead of taking it on the command line,
// so it reaches neither the shell's history nor `ps`. Development runs
// on fakes and never looks. Nothing here prints the token.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SERVICE = "nff-netlify-auth-token";
export const ACCOUNT = "nff";
export const STORE_COMMAND =
  `security add-generic-password -a ${ACCOUNT} -s ${SERVICE} -U -w`;

// `security` exits 44 when the item isn't there.
const NOT_FOUND = 44;

const ask = (file, args) => execFileSync(file, args, {
  encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
});

// The token, from the Keychain. -> the string. Throws an Error that
// says plainly what is missing and the one line that fixes it.
export const keychainToken = ({
  run = ask, platform = process.platform,
} = {}) => {
  if (platform !== "darwin") {
    throw new Error("NETLIFY_AUTH_TOKEN is read from the macOS Keychain, " +
      "and this isn't a Mac.");
  }

  let value;

  try {
    value = run("security", ["find-generic-password", "-a", ACCOUNT,
      "-s", SERVICE, "-w"]);
  } catch (error) {
    if (error && error.status === NOT_FOUND) {
      throw new Error(`The Keychain has no "${SERVICE}" item, so there is ` +
        `no Netlify token. Store it once (it asks for the value):\n  ${
          STORE_COMMAND}`, { cause: error });
    }

    throw new Error(`The Keychain would not give up "${SERVICE}" ` +
      `(security exited ${error && error.status}). Unlock it, or allow ` +
      "access when it asks.", { cause: error });
  }

  const token = String(value).trim();

  if (!token) {
    throw new Error(`The Keychain item "${SERVICE}" is empty. Store the ` +
      `token again:\n  ${STORE_COMMAND}`);
  }

  return token;
};

const ASSIGNS = /^\s*(export\s+)?NETLIFY_AUTH_TOKEN\s*=/m;

// Every .env file and sample in `root` that sets NETLIFY_AUTH_TOKEN.
// -> problem lines, names only. The token has one home.
export const tokenInFiles = (root, {
  list = readdirSync, read = readFileSync,
} = {}) => list(root)
  .filter((name) => /^\.env(\..+)?$/.test(name))
  .filter((name) => ASSIGNS.test(String(read(join(root, name), "utf8"))))
  .sort()
  .map((name) => `${name}: sets NETLIFY_AUTH_TOKEN, which lives only in ` +
    "the Keychain.");
