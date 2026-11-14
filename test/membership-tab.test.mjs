// The Membership tab on the account page (#577): /api/me decides
// whether it shows, and a failed /api/membership stays inside its
// pane. scripts/account/lib/membership-tab.mjs against stand-ins.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  showMembership,
} from "../assets/scripts/account/lib/membership-tab.mjs";

// Just what the loading helper touches: data-load, aria-busy and the
// Try again link (partials/skeleton/status.html).
const region = () => {
  const attrs = {};
  const link = { onclick: null };

  return {
    nodeType: 1,
    dataset: {},
    link,
    attrs,
    setAttribute: (name, value) => { attrs[name] = value; },
    removeAttribute: (name) => { delete attrs[name]; },
    querySelectorAll: () => [link],
  };
};

// The page's side of it, recorded.
const page = (inGroup, ...answers) => {
  const seen = {
    region: region(), requests: 0, rendered: [], revealed: 0, removed: 0,
  };

  seen.run = () => showMembership({
    inGroup,
    region: seen.region,
    request: () => {
      const next = answers[seen.requests];

      seen.requests += 1;

      return typeof next === "function" ? next() : next;
    },
    render: (view) => { seen.rendered.push(view); },
    reveal: () => { seen.revealed += 1; },
    remove: () => { seen.removed += 1; },
  });

  return seen;
};

const VIEW = { member: null, hosts: [{ key: "vff" }] };

describe("the Membership tab (#577)", () => {
  it("shows the tab and fills the pane for a member or host", async () => {
    const p = page(true, { ok: true, status: 200, data: VIEW });

    assert.deepEqual(await p.run(), VIEW);
    assert.equal(p.revealed, 1);
    assert.equal(p.removed, 0);
    assert.deepEqual(p.rendered, [VIEW]);
    assert.equal(p.region.dataset.load, undefined);
    assert.equal(p.region.attrs["aria-busy"], undefined);
  });

  it("keeps the tab and says so in the pane when the request fails",
    async () => {
      // The static 404 the bug served, then a lost connection.
      for (const answer of [
        { ok: false, status: 404, data: {} },
        () => Promise.reject(new TypeError("Failed to fetch")),
      ]) {
        const p = page(true, answer);

        assert.equal(await p.run(), null);
        assert.equal(p.revealed, 1);
        assert.equal(p.removed, 0);
        assert.deepEqual(p.rendered, []);
        assert.equal(p.region.dataset.load, "failed");
        assert.equal(typeof p.region.link.onclick, "function");
      }
    });

  it("asks again from Try again, and fills the pane once it answers",
    async () => {
      const p = page(true, { ok: false, status: 500, data: {} },
        { ok: true, status: 200, data: VIEW });

      await p.run();
      assert.equal(p.region.dataset.load, "failed");

      let prevented = false;

      p.region.link.onclick({ preventDefault: () => { prevented = true; } });
      // Let the retry's request and render run.
      await new Promise((resolve) => { setImmediate(resolve); });
      assert.equal(prevented, true);
      assert.equal(p.requests, 2);
      assert.deepEqual(p.rendered, [VIEW]);
      assert.equal(p.region.dataset.load, undefined);
      assert.equal(p.revealed, 1);
    });

  it("takes the tab and pane away for someone in no group, unasked",
    async () => {
      const p = page(false);

      assert.equal(await p.run(), null);
      assert.equal(p.removed, 1);
      assert.equal(p.revealed, 0);
      assert.equal(p.requests, 0);
      assert.equal(p.region.dataset.load, undefined);
    });

  it("gives the pane its own failure message and Try again", () => {
    const html = readFileSync(
      new URL("../layouts/account/single.html", import.meta.url), "utf8"
    );
    const pane = html.slice(html.indexOf('id="acct-membership"'));
    const at = pane.indexOf('<div id="mem-region">');
    const status = pane.indexOf('partial "skeleton/status.html" '
      + "(dict \"failed\" \"We couldn't load your group.\")");

    assert.ok(at > 0 && status > at, "the pane's region and its message");
    assert.ok(status < pane.indexOf("</section>"), "inside the pane");
  });
});
