#!/usr/bin/env node
// `npm run start:functions`: `netlify dev`, with development's made-up
// pickup schedule (bin/dev-schedule.mjs) unless .env or the shell has
// one, so `cp .env.development.sample .env` is all a clone needs.
//
// Several can run at once, one per worktree (#276): each gets its own
// Hugo port (HUGO_PORT, else any free port the system gives),
// passed to bin/dev and to `netlify dev --target-port`. Give each its
// own `--port`. Netlify and Hugo run in a process group of their own,
// and stopping this script stops the whole group, freeing both ports.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnv } from "../netlify/functions/lib/env.mjs";
import { devSchedule } from "./dev-schedule.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

loadEnv(join(root, ".env"));
if (!process.env.PICKUP_SCHEDULE) process.env.PICKUP_SCHEDULE = devSchedule();

// Resolves to a port the system has free on 127.0.0.1, where Hugo
// listens. Never 1313: two servers started together would both find
// it free, and the second Hugo would fail to bind.
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const hugoPort = process.env.HUGO_PORT || String(await freePort());
process.env.HUGO_PORT = hugoPort;

const targetGiven = args.some((arg) => arg.startsWith("--target-port"));
const netlifyArgs = ["dev", "--cwd", root, ...args];
if (!targetGiven) netlifyArgs.push("--target-port", hugoPort);

console.log(`start:functions: Hugo on port ${hugoPort}`);

// Netlify takes the nearest `.git` directory above it as the project
// root, which for a worktree inside a checkout (.claude/worktrees/) is
// that checkout, and reads its netlify.toml. `--cwd` makes it use this
// worktree instead, but it ignores `--cwd` when it names the directory
// it runs in, so it runs from bin/.
const child = spawn("npx", ["netlify", ...netlifyArgs], {
  cwd: join(root, "bin"),
  detached: true,
  env: process.env,
  stdio: ["ignore", "inherit", "inherit"],
});

// Signals the child's whole process group: netlify, bin/dev and Hugo.
// False once the group is gone.
function signalGroup(signal) {
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return false;
  }
}

let stopping = false;

// Stops the group, gently and then by force, and exits with `code`.
function stop(code) {
  if (stopping) return;
  stopping = true;
  signalGroup("SIGTERM");
  const started = Date.now();
  const timer = setInterval(() => {
    if (!signalGroup(0)) {
      clearInterval(timer);
      process.exit(code);
    }
    if (Date.now() - started > 5000) signalGroup("SIGKILL");
  }, 100);
}

const exitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
for (const [signal, code] of Object.entries(exitCodes)) {
  process.on(signal, () => stop(code));
}

child.on("close", (code) => stop(code ?? 1));
