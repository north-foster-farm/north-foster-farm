// Criteria tests for #898 (Site search: move the results panel outside
// the main navigation), its two (test) boxes, one test each, read off
// the built site. The markup holds every state the panel can show: the
// listbox the script fills with results, and the "Nothing matches"
// block with its links, hidden until needed. The running page's
// states are e2e/search-panel-nav.criteria.mjs. Boxes 3 and 4 are the
// existing e2e/site-search.spec.mjs and e2e/footer.spec.mjs, which
// stay unchanged. Where Hugo is not installed (CI's test job) this is
// skipped. Held out of npm test by its name until the change lands:
// renamed to search-panel-nav.test.mjs.
//
// The seam: the panel's results are the element the field's
// aria-controls names, the "Nothing matches" block is the element
// marked data-find-none, and the field is the combobox input
// #site-find-input (layouts/partials/search/field.html).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const root = join(import.meta.dirname, "..");
const hasHugo = spawnSync("hugo", ["version"]).status === 0;

// Pages with the header, the order page's own among them.
const PAGES = ["index.html", "about/index.html", "order/index.html"];
const POLICY = /\shref="[^"]*\/delivery-policy\/"/;

// Every <nav> element's span in the HTML, with its opening tag. Navs
// may nest, so each closing tag ends the innermost one open.
const navs = (html) => {
  const found = [];
  const open = [];

  for (const m of html.matchAll(/<nav\b[^>]*>|<\/nav\s*>/gi)) {
    if (m[0][1] === "/") {
      const start = open.pop();

      if (start) {
        found.push({
          tag: start.tag, from: start.at, to: m.index + m[0].length,
        });
      }
    } else {
      open.push({ tag: m[0], at: m.index });
    }
  }
  assert.equal(open.length, 0, "every <nav> is closed");

  return found;
};

const isMain = (nav) => /\baria-label="Main"/.test(nav.tag);
const inside = (spans, at) => spans.some((s) => at > s.from && at < s.to);

// The span of the element whose opening tag matches `re`, to its
// matching close.
const element = (html, re) => {
  const m = html.match(re);

  assert.ok(m, `found ${re}`);

  const name = m[0].match(/^<([a-z]+)/i)[1];
  const tags = new RegExp(`<${name}\\b[^>]*>|</${name}\\s*>`, "gi");
  let depth = 0;

  tags.lastIndex = m.index;
  for (let t = tags.exec(html); t; t = tags.exec(html)) {
    depth += t[0][1] === "/" ? -1 : 1;
    if (depth === 0) {
      return {
        tag: m[0], from: m.index, to: t.index + t[0].length,
        html: html.slice(m.index, t.index + t[0].length),
      };
    }
  }
  return assert.fail(`${re} is closed`);
};

describe("#898 search panel outside the main navigation",
  { skip: !hasHugo }, () => {
    let dir;
    const pages = {};

    before(() => {
      dir = mkdtempSync(join(tmpdir(), "nff-search-nav-"));

      const run = spawnSync("hugo", ["--gc", "--logLevel", "warn",
        "--environment", "production", "-d", dir], {
        cwd: root, encoding: "utf8",
      });

      assert.equal(run.status, 0, run.stderr);
      for (const page of PAGES) {
        pages[page] = readFileSync(join(dir, page), "utf8");
      }
    });

    after(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("No link to the delivery policy is inside nav[aria-label=\"Main\"], "
      + "with the search panel closed, showing results, or showing "
      + "\"Nothing matches\"", () => {
      for (const [page, html] of Object.entries(pages)) {
        const main = navs(html).filter(isMain);

        assert.ok(main.length > 0, `${page}: has the main navigation`);
        for (const nav of main) {
          assert.equal(POLICY.test(html.slice(nav.from, nav.to)), false,
            `${page}: a delivery policy link in the main navigation`);
        }
      }
    });

    it("The search panel's results and its \"Nothing matches\" links are "
      + "outside every nav landmark, and the field still names the list "
      + "it controls (aria-controls, the listbox role)", () => {
      for (const [page, html] of Object.entries(pages)) {
        const all = navs(html);
        const field = html.match(/<input\s[^>]*\bid="site-find-input"[^>]*>/i);

        assert.ok(field, `${page}: has the search field`);

        const controls = field[0].match(/\saria-controls="([^"]+)"/)?.[1];

        assert.ok(controls, `${page}: the field names the list it controls`);

        const list = element(html,
          new RegExp(`<[a-z]+\\s[^>]*\\bid="${controls}"[^>]*>`, "i"));
        const none = element(html, /<[a-z]+\s[^>]*\bdata-find-none\b[^>]*>/i);

        assert.equal(inside(all, list.from), false,
          `${page}: the results are inside a nav`);
        assert.equal(inside(all, none.from), false,
          `${page}: "Nothing matches" is inside a nav`);
        assert.ok(none.html.match(/<a\s/g)?.length >= 3,
          `${page}: "Nothing matches" offers its links`);
        assert.match(list.tag, /\srole="listbox"/,
          `${page}: the results are a listbox`);
        assert.match(field[0], /\srole="combobox"/,
          `${page}: the field is a combobox`);
      }
    });
  });
