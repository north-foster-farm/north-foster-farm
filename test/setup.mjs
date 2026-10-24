// Loaded before every test file (package.json: node --import). On
// 2026-09-22 the suite, run by the Netlify build with the production
// variables in the environment, sent the fixtures' order notices
// through Resend on every deploy. Nothing under test may reach a real
// service, so two rules hold here for every run, local or in CI:
//
// - The environment is an allowlist. Every variable not named below is
//   dropped before a module can read it, so a key added tomorrow is
//   stripped without anyone remembering to list it.
// - The network is closed. fetch, net, tls and DNS lookups throw for
//   any host but this machine, and a file in which anything was
//   blocked fails, so a test that would reach a service never passes.

import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";

const KEEP = new Set([
  "PATH", "HOME", "TMPDIR", "TZ", "LANG", "TERM", "CI", "NO_COLOR",
  "FORCE_COLOR",
]);

// Node's test runner talks to its workers through these.
const NODE_OWN = /^NODE_(TEST_|V8_COVERAGE$|CHANNEL_|UNIQUE_ID$)/;

for (const name of Object.keys(process.env)) {
  if (!KEEP.has(name) && !NODE_OWN.test(name)) delete process.env[name];
}

process.env.MAIL_DRIVER = "log";
process.env.SQUARE_ENV = "sandbox";

// The farm's pickup schedule (W11d): the fixture's, never the
// deploy's, which changes with the calendar.
const { SCHEDULE } = await import("./schedule-fixture.mjs");

process.env.PICKUP_SCHEDULE = SCHEDULE;

const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "[::1]", ""]);

class NetworkBlocked extends Error {
  constructor(host) {
    super(`A test reached the network: ${host}`);
    this.name = "NetworkBlocked";
  }
}

// Every blocked call, by host. Code that swallows its errors (the
// health ping, the log flush) would hide a block from the test that
// caused it, so the file fails at the end instead. A test that blocks
// on purpose takes its own entries back out (test/setup.test.mjs).
const blockedHosts = [];

globalThis[Symbol.for("nff.test.blocked")] = blockedHosts;

const guard = (host) => {
  const name = String(host ?? "").toLowerCase();

  if (!LOCAL.has(name)) {
    blockedHosts.push(name);
    throw new NetworkBlocked(name);
  }
};

if (process.env.NODE_TEST_CONTEXT) {
  const { after } = await import("node:test");

  after(() => {
    if (blockedHosts.length) {
      throw new Error(`Tests reached the network: ${blockedHosts}`);
    }
  });
}

const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));

  guard(url.hostname);

  return realFetch(input, init);
};

// Socket#connect takes (options), (port, host) or (path), and net
// itself passes an already-normalized [options, callback] array.
const hostOf = (args) => {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];

  if (first && typeof first === "object") {
    return first.path ? "localhost" : first.host ?? "localhost";
  }
  if (typeof first === "string" && Number.isNaN(Number(first))) {
    return "localhost";
  }

  return typeof args[1] === "string" ? args[1] : "localhost";
};

const connect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function (...args) {
  guard(hostOf(args));

  return connect.apply(this, args);
};

const tlsConnect = tls.connect;

tls.connect = (...args) => {
  const options = args.find((arg) => arg && typeof arg === "object");

  if (!options?.socket) guard(hostOf(args));

  return tlsConnect(...args);
};

const lookup = dns.lookup;

dns.lookup = (host, ...rest) => {
  guard(host);

  return lookup(host, ...rest);
};

const lookupPromise = dns.promises.lookup;

dns.promises.lookup = (host, ...rest) => {
  guard(host);

  return lookupPromise(host, ...rest);
};
