// The vendors' recorded answers (test/fixtures/README.md): what a fake
// returns in place of a vendor, so the code that reads the vendor's
// JSON runs on the real thing. Never write a response by hand.

import { readFileSync } from "node:fs";

// The whole file: { _source, status, request, response }.
export const recorded = (service, name) => JSON.parse(readFileSync(
  new URL(`./fixtures/${service}/${name}.json`, import.meta.url), "utf8"
));

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
