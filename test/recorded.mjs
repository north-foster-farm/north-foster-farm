// The vendors' recorded answers (test/fixtures/README.md): what a fake
// returns in place of a vendor, so the code that reads the vendor's
// JSON runs on the real thing. Never write a response by hand.

import { isPlaceholder } from "../bin/fixtures/scrub";
import { recorded } from "../netlify/functions/lib/fake.mjs";

// The whole file: { _source, status, request, response }.
export { recorded };

// The recorded body, as a deep copy a test may change.
export const body = (service, name) => recorded(service, name).response;

// The recorded answer as a fetch Response, status and all.
export const reply = (service, name) => {
  const { status, response } = recorded(service, name);

  return new Response(JSON.stringify(response), {
    status,
    headers: { "Content-Type": "application/json" },
  });
};

// A recorded string that stands for any value: a placeholder the
// scrubber put there, a time, or a path with an id in it.
const NUMBERED = /[A-Z][A-Z0-9_]*_\d+/g;
const TIME = /^\d{4}-\d{2}-\d{2}T/;

// Where `got` (what our code sent) departs from `want` (what was
// recorded): one line per difference, none when they agree. A value
// that was scrubbed, or a time, matches any string; the keys, the
// constants and the shape must match exactly.
export const differences = (want, got, at = "") => {
  if (typeof want === "string") {
    if (typeof got !== "string") return [`${at}: not a string`];
    if (TIME.test(want) || isPlaceholder(want)) return [];
    if (want.search(NUMBERED) >= 0) {
      const pattern = new RegExp(`^${want
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(NUMBERED, "[^/]+")}$`);

      return pattern.test(got) ? [] : [`${at}: ${got} is not ${want}`];
    }

    return want === got ? [] : [`${at}: ${got} is not ${want}`];
  }
  if (Array.isArray(want)) {
    if (!Array.isArray(got) || got.length !== want.length) {
      return [`${at}: not ${want.length} items`];
    }

    return want.flatMap((item, i) => differences(item, got[i], `${at}[${i}]`));
  }
  if (want && typeof want === "object") {
    if (!got || typeof got !== "object") return [`${at}: not an object`];
    const keys = new Set([...Object.keys(want), ...Object.keys(got)]);

    return [...keys].flatMap((key) => (key in want && key in got
      ? differences(want[key], got[key], `${at}.${key}`)
      : [`${at}.${key}: ${key in want ? "not sent" : "sent, not recorded"}`]));
  }

  return want === got ? [] : [`${at}: ${got} is not ${want}`];
};

// A fetch that answers with the named recordings in turn, and notes in
// `problems` where what the code sent departs from what each was
// recorded with. `left()` names the recordings not yet asked for.
export const serve = (service, ...names) => {
  const queue = names.map((name) => ({ name, ...recorded(service, name) }));
  const problems = [];
  const impl = async (url, init) => {
    const next = queue.shift();
    const { pathname } = new URL(url);

    if (!next) {
      problems.push(`unexpected ${init.method} ${pathname}`);

      return new Response("{}", { status: 500 });
    }

    const sent = {
      method: init.method || "GET",
      path: pathname,
      body: init.body ? JSON.parse(init.body) : null,
    };
    const want = {
      method: next.request.method,
      path: next.request.path,
      body: next.request.body,
    };

    for (const d of differences(want, sent)) problems.push(`${next.name}${d}`);

    return new Response(JSON.stringify(next.response), {
      status: next.status,
    });
  };

  return { impl, problems, left: () => queue.map((q) => q.name) };
};
