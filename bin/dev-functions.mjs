#!/usr/bin/env node
// `npm run start:functions`: `netlify dev`, with development's made-up
// pickup schedule (bin/dev-schedule.mjs) unless .env or the shell has
// one, so `cp .env.development.sample .env` is all a clone needs.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnv } from "../netlify/functions/lib/env.mjs";
import { devSchedule } from "./dev-schedule.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

loadEnv(join(root, ".env"));
if (!process.env.PICKUP_SCHEDULE) process.env.PICKUP_SCHEDULE = devSchedule();

spawn("npx", ["netlify", "dev", ...process.argv.slice(2)], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
}).on("close", (code) => process.exit(code ?? 1));
