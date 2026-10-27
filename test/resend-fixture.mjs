// Resend's contacts API for the tests, an audience kept in memory
// whose every answer is built from the coordinator's recordings in
// test/fixtures/resend/contacts-*.json (#496, 2026-10-27; each file's
// _source says how they were made). The status, keys and shape are
// Resend's. Only the email, id and names change per test.
//
// What the recordings show of Resend that a guess would get wrong: a
// contact made answers 201, the list carries has_more, and deleting a
// contact that isn't there answers 200 with deleted true, not 404.
// Renaming one that isn't there is a 404.

import { readFileSync } from "node:fs";

/* eslint-disable camelcase -- Resend names contact fields its way */

const NAMES = [
  "create", "list", "update", "update-missing", "delete", "delete-missing",
];
const RECORDED = Object.fromEntries(NAMES.map((name) => [name, JSON.parse(
  readFileSync(new URL(`./fixtures/resend/contacts-${name}.json`,
    import.meta.url), "utf8"),
)]));

// One recording's status and a copy of its answer.
export const recording = (name) => ({
  status: RECORDED[name].status,
  body: structuredClone(RECORDED[name].response),
});

// A contact as the list answers it. `seed` is an address, or the
// fields a test sets: email, first_name, last_name, unsubscribed.
export const contactFor = (seed, id) => ({
  ...recording("list").body.data[0],
  first_name: "", last_name: "", unsubscribed: false,
  ...(typeof seed === "string" ? { email: seed } : seed),
  id,
});

const answer = ({ status, body }) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});

// The audience holding `seeds`. `fail` names a method that answers
// Resend's 500, which can't be recorded on demand: that answer is an
// injected error, its shape Resend's documented error body. `more`
// sets has_more on the list, as for an audience larger than one page.
// -> { contacts, calls, fetchImpl }, `calls` one { method, url,
// pathname, body } for each request.
export const resendFake = (seeds = [], { fail = null, more = false } = {}) => {
  const contacts = seeds.map((seed, i) => contactFor(seed, `c${i}`));
  const calls = [];
  let made = contacts.length;

  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    const { pathname } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    const email = decodeURIComponent(pathname.split("/contacts/")[1] || "");
    const i = contacts.findIndex((c) => c.email === email);

    calls.push({ method, url: String(url), pathname, body });
    if (fail && method === fail) {
      // Injected, not recorded.
      return answer({ status: 500, body: {
        statusCode: 500, name: "internal_server_error",
        message: `Could not reach ${pathname}`,
      } });
    }
    if (method === "GET") {
      const list = recording("list");

      list.body.has_more = more;
      list.body.data = contacts.map((c) => ({ ...c }));

      return answer(list);
    }
    if (method === "POST") {
      const created = recording("create");
      const id = `c${made++}`;

      contacts.push(contactFor(body, id));
      created.body.id = id;

      return answer(created);
    }
    if (method === "PATCH") {
      if (i < 0) return answer(recording("update-missing"));

      const updated = recording("update");

      Object.assign(contacts[i], body);
      updated.body.id = contacts[i].id;

      return answer(updated);
    }

    const deleted = recording(i < 0 ? "delete-missing" : "delete");

    if (i >= 0) contacts.splice(i, 1);
    deleted.body.contact = email;

    return answer(deleted);
  };

  return { contacts, calls, fetchImpl };
};
