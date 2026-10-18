// The Netlify CLI, run with the Keychain's token (#267). The token
// goes to the child in its environment only: never argv, where `ps`
// shows it, and never the CLI's own login file, which holds the same
// access in plain text (`netlify logout` removes that file's token).
// Nothing here prints the token.

import { spawn as nodeSpawn } from "node:child_process";

// Run `netlify <args>` as the user's own terminal command would:
// stdio passes straight through. -> the exit code.
export const runNetlify = (args, token, { spawn = nodeSpawn } = {}) => (
  new Promise((resolve, reject) => {
    const child = spawn("npx", ["netlify", ...args], {
      stdio: "inherit",
      env: { ...process.env, NETLIFY_AUTH_TOKEN: token },
    });

    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  })
);
