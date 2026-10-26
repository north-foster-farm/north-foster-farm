import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  STAY, forgetEverything, unfinished,
} from "../assets/scripts/staging/reset.js";

// Just enough of Storage and document.cookie for the reset.
const bag = (entries = {}) => {
  const map = new Map(Object.entries(entries));

  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
};

const jar = (cookies) => {
  const held = new Map(Object.entries(cookies));

  return {
    held,
    get cookie() {
      return [...held].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    set cookie(line) {
      const [pair, ...attrs] = line.split(";").map((s) => s.trim());
      const [name, value] = pair.split("=");

      if (attrs.includes("Max-Age=0")) held.delete(name);
      else held.set(name, value);
    },
  };
};

// Everything the site is known to keep in a browser, one of each kind.
const seed = () => ({
  local: bag({
    "nff-order-draft": "{}",
    "nff-order-pending": "{}",
    "nff-edit-4821": "{}",
    "nff-delivery-note": "1",
    "nff-venmo": "1",
    "nff-news": "joined",
    "nff:autoplay": "off",
    "nff-me": "{}",
    "staging.open": "1",
  }),
  session: bag({ "nff-me": "{}", "staging.hidden": "1" }),
  cookies: jar({ "nff_signed_in": "17", other: "x" }),
});

describe("Reset to first visit (#267)", () => {
  it("leaves the browser as a first visit finds it", async () => {
    const { local, session, cookies } = seed();
    let signedOut = 0;

    await forgetEverything({
      local: () => local, session: () => session, jar: cookies,
      signOut: async () => { signedOut += 1; },
    });

    assert.equal(signedOut, 1, "ends the server session");
    assert.deepEqual([...local.map.keys()].sort(), [...STAY].sort());
    assert.equal(session.map.size, 0);
    assert.equal(cookies.held.size, 0);
  });

  it("keeps only the toolbar's open state", async () => {
    const { local, session, cookies } = seed();

    await forgetEverything({
      local: () => local, session: () => session, jar: cookies,
      signOut: async () => {},
    });
    assert.equal(local.getItem("staging.open"), "1");
  });

  it("still clears the browser when the sign-out fails", async () => {
    const { local, session, cookies } = seed();

    await forgetEverything({
      local: () => local, session: () => session, jar: cookies,
      signOut: async () => { throw new Error("offline"); },
    });
    assert.equal(local.map.has("nff-venmo"), false);
    assert.equal(cookies.held.size, 0);
  });

  it("empties this session's emails on the server (#350)", async () => {
    const { local, session, cookies } = seed();
    let cleared = 0;

    const done = await forgetEverything({
      local: () => local, session: () => session, jar: cookies,
      signOut: async () => {},
      clearMail: async () => { cleared += 1; },
    });

    assert.equal(cleared, 1);
    assert.deepEqual(done, { signedOut: true, mailCleared: true });
  });

  it("says what the server did not do (#350)", async () => {
    const { local, session, cookies } = seed();

    const done = await forgetEverything({
      local: () => local, session: () => session, jar: cookies,
      signOut: async () => { throw new Error("POST: 403"); },
      clearMail: async () => { throw new Error("DELETE: 401"); },
    });

    assert.deepEqual(done, { signedOut: false, mailCleared: false });
    assert.equal(local.map.has("nff-order-draft"), false);
  });

  it("resets the page's forms so a reload restores no cart (#350)",
    async () => {
      const { local, session, cookies } = seed();
      const reset = [];
      const forms = [1, 2].map((n) => ({ reset: () => reset.push(n) }));

      await forgetEverything({
        local: () => local, session: () => session, jar: cookies,
        forms: () => forms, signOut: async () => {}, clearMail: async () => {},
      });
      assert.deepEqual(reset, [1, 2]);
    });

  it("reports a refused sign-out and mail clear (#350)", async () => {
    const { local, session, cookies } = seed();
    const real = globalThis.fetch;
    const calls = [];

    // Fetch resolves on a 403, as the real one does; only ok says no.
    globalThis.fetch = async (path, init) => {
      calls.push(`${init.method} ${path}`);

      return { ok: false, status: 403 };
    };
    try {
      const done = await forgetEverything({
        local: () => local, session: () => session, jar: cookies,
      });

      assert.deepEqual(done, { signedOut: false, mailCleared: false });
      assert.deepEqual(calls, [
        "POST /api/auth/signout", "DELETE /api/staging/outbox",
      ]);
      assert.equal(local.map.has("nff-order-draft"), false);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("reports both steps done on a 200 (#350)", async () => {
    const { local, session, cookies } = seed();
    const real = globalThis.fetch;

    globalThis.fetch = async () => ({ ok: true, status: 200 });
    try {
      assert.deepEqual(await forgetEverything({
        local: () => local, session: () => session, jar: cookies,
      }), { signedOut: true, mailCleared: true });
    } finally {
      globalThis.fetch = real;
    }
  });

  it("names every step the server left undone (#350)", () => {
    assert.equal(unfinished({ signedOut: true, mailCleared: true }), "");
    assert.equal(
      unfinished({ signedOut: false, mailCleared: true }),
      "The browser is reset, but the server did not end the sign-in."
    );
    assert.equal(
      unfinished({ signedOut: true, mailCleared: false }),
      "The browser is reset, but the server did not empty this " +
        "session's emails."
    );
    assert.equal(
      unfinished({ signedOut: false, mailCleared: false }),
      "The browser is reset, but the server did not end the sign-in or " +
        "empty this session's emails."
    );
  });

  it("survives storage that throws", async () => {
    const { cookies } = seed();

    await forgetEverything({
      local: () => { throw new Error("blocked"); },
      session: () => { throw new Error("blocked"); },
      jar: cookies,
      signOut: async () => {},
    });
    assert.equal(cookies.held.size, 0);
  });
});

// The reset clears whole storages, so it cannot miss a key. What could
// break it is a site script keeping its state under a name the toolbar
// keeps, or somewhere the reset does not look.
describe("what the site keeps in the browser", () => {
  const scripts = (dir) => readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? scripts(join(dir, e.name))
      : e.name.endsWith(".js") ? [join(dir, e.name)] : []));
  const site = scripts("assets/scripts")
    .filter((f) => !f.startsWith(join("assets", "scripts", "staging")));

  it("never uses a key under the toolbar's own names", () => {
    for (const file of site) {
      const source = readFileSync(file, "utf8");

      for (const key of STAY) {
        assert.ok(!source.includes(`"${key}"`), `${file} uses ${key}`);
      }
    }
  });

  it("keeps nothing in IndexedDB, caches or a service worker", () => {
    for (const file of site) {
      const source = readFileSync(file, "utf8");

      assert.doesNotMatch(source, /indexedDB|caches\.|serviceWorker/,
        `${file} stores state the reset does not clear`);
    }
  });
});
