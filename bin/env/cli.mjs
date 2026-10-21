// The Netlify CLI, run with the Keychain's token (#267). The token
// goes to the child in its environment only: never argv, where `ps`
// shows it, and never the CLI's own login file, which holds the same
// access in plain text (`netlify logout` removes that file's token).
// Nothing here prints the token.

import { spawn as nodeSpawn } from "node:child_process";

// The Netlify CLI at one version, for every script that runs it. A
// bare `npx netlify` runs whatever is installed, or fetches the newest
// release from the registry and runs it with a production token in its
// environment (#283). Change the version here, after its 7 days.
export const NETLIFY_CLI_VERSION = "26.1.0";
export const NETLIFY_NPX = [
  "--yes", `--package=netlify-cli@${NETLIFY_CLI_VERSION}`, "netlify",
];

// Run `netlify <args>` as the user's own terminal command would:
// stdio passes straight through. -> the exit code.
export const runNetlify = (args, token, { spawn = nodeSpawn } = {}) => (
  new Promise((resolve, reject) => {
    const child = spawn("npx", [...NETLIFY_NPX, ...args], {
      stdio: "inherit",
      env: { ...process.env, NETLIFY_AUTH_TOKEN: token },
    });

    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  })
);
