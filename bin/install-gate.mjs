#!/usr/bin/env node
// Puts the access gate's edge function into netlify/edge-functions/
// for a build of a non-production context. Production's build command
// never runs this, so its deploy has no edge function at all: the gate
// is compiled out there, and the function itself passes anything
// that is not a guarded context (lib/gate-edge.mjs) besides.
//
//   node bin/install-gate.mjs     reads Netlify's build-time CONTEXT
//
// It refuses any context but the two the gate guards, so a mistaken
// call in a production build stops the build.

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { gateActive } from "../netlify/functions/lib/gate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const context = process.env.CONTEXT || "";

if (!gateActive(context)) {
  console.error(
    `The access gate is for branch deploys and previews, not "${context}".`
  );
  process.exit(1);
}

mkdirSync(join(root, "netlify/edge-functions"), { recursive: true });
copyFileSync(
  join(root, "netlify/gate-edge/gate.mjs"),
  join(root, "netlify/edge-functions/gate.mjs"),
);
console.log(`Access gate installed for ${context}.`);
