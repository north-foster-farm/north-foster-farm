// The criteria test for criterion 7 of #615: `bin/nff e2e` sends the
// pages it chose (or was given) as e2e.yml's `pages` input, through its
// one place for dispatch inputs, and still refuses to send pages
// without a spec. Written from the criteria before the change. The
// implementer may change how it runs, never what it expects
// (~/.claude/CLAUDE.md, "Tests and implementation come from different
// agents"). Criteria 1 to 6 and 8 are in
// test/e2e-pages-input.criteria.mjs.
//
// Held out of `npm test`, which runs test/**/*.test.mjs, until three
// things are true: #613 has landed (bin/e2e/dispatch.mjs and
// test/fixtures/github/e2e-dispatch.json), e2e.yml takes `pages`, and
// test/fixtures/github/e2e-dispatch-pages.json is recorded (below). Run
// it on purpose with
//   node --import ./test/setup.mjs --test test/e2e-dispatch-pages.criteria.mjs
// and turn it on by renaming it to test/e2e-dispatch-pages.test.mjs.
//
// The contract, beyond #613's (test/e2e-dispatch.test.mjs):
//
// - bin/e2e/dispatch.mjs exports dispatchInputs(choice) -> the
//   dispatch's `inputs`, the one place they are made. For a choice with
//   pages it holds `pages`: the pages joined by single spaces, as
//   `specs` holds the specs. For a choice with none, `pages` is left
//   out or empty.
// - e2eCommand sends exactly dispatchInputs(choice) as `inputs`.
//
// The recording. GitHub's dispatch answer does not depend on the
// inputs, but the request does: e2e-dispatch-pages.json is a real
// dispatch that sets `pages`, made once e2e.yml on the implementer's
// branch takes it, so the body the command sends is checked against
// one GitHub accepted. Record it (the coordinator, by #496's rule) with
// a body file holding
//   {"ref":"<the implementer's branch>","inputs":{"specs":"not-a-spec",
//    "pages":"/about/"},"return_run_details":true}
// and
//   gh api -X POST repos/north-foster-farm/north-foster-farm/actions/
//     workflows/e2e.yml/dispatches --input <body file>
// The plan job refuses `not-a-spec`, so the run costs nothing. Save
// { "_source": "...", "dispatch": { "request": { "method", "path",
// "body" }, "response": <GitHub's answer> } } in the shape of
// e2e-dispatch.json's `dispatch`. The run's later answers come from
// #613's recording, e2e-dispatch.json; the fake puts its run's id into
// the dispatch answer, as #613's test does.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { dispatchInputs, e2eCommand } from "../bin/e2e/dispatch.mjs";

const fixture = (name) => JSON.parse(readFileSync(
  new URL(`fixtures/github/${name}`, import.meta.url), "utf8"));
const F = fixture("e2e-dispatch.json");
const P = fixture("e2e-dispatch-pages.json");

const KEYBOARD = "e2e/keyboard.spec.mjs";
const TABLE = {
  shared: ["layouts/_default/**", "e2e/support/**"],
  entries: [
    {
      paths: ["layouts/account/**"],
      specs: ["e2e/account.spec.mjs", KEYBOARD],
      pages: ["/account/"],
    },
    {
      paths: ["content/about/**"],
      specs: [KEYBOARD],
      pages: ["/about/"],
    },
    { paths: ["layouts/contact/**"], specs: [], pages: ["/contact/"] },
    { paths: ["content/faq/**"], specs: ["e2e/faq.spec.mjs"] },
    { paths: ["docs/**"], specs: [] },
  ],
};

const words = (text) => String(text ?? "").split(/\s+/).filter(Boolean);

// GitHub, answering with the recordings: the pages dispatch names the
// run, which is queued at the first look and passed after.
const world = ({ changed = [] } = {}) => {
  const run = F.runPassed;
  const calls = [];
  const lines = [];
  let looks = 0;

  const api = async (path, { method = "GET", body } = {}) => {
    calls.push({ path, method, body });
    if (method === "POST"
      && /\/actions\/workflows\/e2e\.yml\/dispatches$/.test(path)) {
      return { ...P.dispatch.response, workflow_run_id: run.id,
        run_url: run.url, html_url: run.html_url };
    }
    if (method !== "GET") throw new Error(`unrecorded ${method} ${path}`);
    if (new RegExp(`/actions/runs/${run.id}(\\?|$)`).test(path)) {
      looks += 1;

      return looks === 1 ? { ...F.runQueued, id: run.id, url: run.url,
        html_url: run.html_url } : run;
    }
    if (new RegExp(`/actions/runs/${run.id}/jobs(\\?|$)`).test(path)) {
      return F.jobsPassed;
    }
    throw new Error(`unrecorded GET ${path}`);
  };

  return {
    io: { flags: {}, out: (line) => lines.push(String(line)) },
    deps: {
      api,
      table: TABLE,
      branch: async () => "lane/pages-input",
      changed: async () => changed,
      wait: async () => {},
    },
    printed: () => lines.join("\n"),
    dispatches: () => calls.filter((c) => c.method === "POST"),
  };
};

const sent = async (args, { changed } = {}) => {
  const w = world({ changed });
  const code = await e2eCommand(args, w.io, w.deps);

  return { code, w, posts: w.dispatches() };
};

describe("bin/nff e2e: the pages input (#615)", () => {
  it("7. bin/nff e2e sends the pages it chose (or was given) as the pages "
    + "input, through its one place for dispatch inputs, and still "
    + "refuses to send pages without a spec", async () => {
    const recorded = P.dispatch.request.body;

    assert.ok(recorded.inputs.pages, "the recording set pages");

    // The one place: pages joined as specs are.
    const inputs = dispatchInputs({ all: false, specs: [KEYBOARD],
      pages: ["/about/", "/"], reasons: [] });

    assert.deepEqual(words(inputs.specs), [KEYBOARD]);
    assert.equal(inputs.pages, "/about/ /");
    assert.equal(dispatchInputs({ all: false, specs: [KEYBOARD], pages: [],
      reasons: [] }).pages ?? "", "", "no pages, no pages input");

    // Given by hand: the spec and the page, in a body of the shape
    // GitHub accepted.
    const given = await sent([KEYBOARD, "/about/"]);

    assert.equal(given.code, 0, given.w.printed());
    assert.equal(given.posts.length, 1);
    const body = given.posts[0].body;

    assert.deepEqual(Object.keys(body).sort(), Object.keys(recorded).sort());
    assert.equal(body.return_run_details, recorded.return_run_details);
    assert.deepEqual(Object.keys(body.inputs).sort(),
      Object.keys(recorded.inputs).sort(), "the input names GitHub took");
    assert.deepEqual(words(body.inputs.specs), [KEYBOARD]);
    assert.deepEqual(words(body.inputs.pages), ["/about/"]);
    assert.deepEqual(body.inputs, dispatchInputs({ all: false,
      specs: [KEYBOARD], pages: ["/about/"], reasons: [] }),
    "sent through dispatchInputs");
    assert.doesNotMatch(given.w.printed(), /printed only|takes no pages/i,
      "it no longer says pages are not sent");

    // Chosen from the table.
    const chosen = await sent([], { changed: ["content/about/index.md"] });

    assert.equal(chosen.posts.length, 1, chosen.w.printed());
    assert.deepEqual(words(chosen.posts[0].body.inputs.specs), [KEYBOARD]);
    assert.deepEqual(words(chosen.posts[0].body.inputs.pages), ["/about/"]);

    // Specs and no pages: no pages input.
    const plain = await sent([], { changed: ["content/faq/q.md"] });

    assert.equal(plain.posts.length, 1, plain.w.printed());
    assert.deepEqual(words(plain.posts[0].body.inputs.specs),
      ["e2e/faq.spec.mjs"]);
    assert.equal(plain.posts[0].body.inputs.pages ?? "", "");

    // Pages without a spec: nothing sent, by hand or from the table.
    const bare = await sent(["/about/"]);

    assert.equal(bare.posts.length, 0, "a page alone is not dispatched");
    assert.notEqual(bare.code, 0, "named pages without a spec fail");
    assert.match(bare.w.printed(), /spec/i, "it says a spec is needed");

    const tableOnly = await sent([], { changed: ["layouts/contact/a.html"] });

    assert.equal(tableOnly.posts.length, 0,
      "a choice of pages and no specs is not dispatched");
  });

  it("7. a choice of everything sends no pages and leaves its specs as "
    + "they were", () => {
    const specs = ["e2e/a.spec.mjs", "e2e/b.spec.mjs"];
    const narrow = dispatchInputs({ all: false, specs, pages: ["/x/"],
      reasons: [] });
    const everything = dispatchInputs({ all: true, specs, pages: ["/x/"],
      reasons: [] });

    assert.ok(!everything.pages, "every spec runs every page");
    assert.equal(everything.specs, "e2e/a.spec.mjs e2e/b.spec.mjs");
    assert.equal(everything.specs, narrow.specs);
  });
});
