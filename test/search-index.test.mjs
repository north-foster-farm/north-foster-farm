// Criteria tests for #402 (Header search: a plain site search in place
// of the palette), the boxes of its "Done when" list that are about
// data, one test each, named for its box. Held out of every run by its
// name until the change lands: renamed to search-index.test.mjs, it
// runs in `npm test`. The page half of box 2 (the index loads only
// when search is first opened or focused) is in
// e2e/site-search.criteria.mjs, under the same box's name.
//
// Builds the site once, as test/not-found.test.mjs does, and reads the
// built index. Where Hugo is not installed (CI's test job) it skips.
//
// The seam, what the tests rely on:
// - Hugo writes `search.json` at the root of the build. It is a list
//   of entries, or an object holding that list as `entries`.
// - Every entry has `kind`, `title` and `url`. The kinds are
//   "product" (one per catalog item but an archived one, with its
//   `sku`), "section" (a `##` or `###` heading of a page, its `url`
//   the page and the heading's anchor), "page", "town" (a delivery
//   town, its name and every ZIP in the entry), "fact" (a quick
//   answer: the phone number, the email address, the drop site) and
//   "news" (a post). An entry's other strings (group, keywords,
//   snippet, words) are free: the tests read the entry as a whole.
// - A url is a site path ("/delivery-policy/#refunds") or a full URL;
//   the tests compare its path and anchor.
// - The synonyms and keywords live in one data file, `data/search.*`
//   (YAML, TOML or JSON), and nowhere in `assets/scripts/search/`.
// - `assets/scripts/search/match.js` exports `index(entries)`, which
//   takes the built entries as they are, and `search(indexed, query)`,
//   which returns the matching entries best first: a flat list of
//   entries, or a list of groups, each holding its entries as
//   `entries`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdtempSync, readdirSync, readFileSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const root = join(import.meta.dirname, "..");
const hasHugo = spawnSync("hugo", ["version"]).status === 0;
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");
const json = (...parts) => JSON.parse(read(...parts));

const CATALOG = json("data", "catalog.json");
const DELIVERY = json("data", "delivery.json");
const COMPANY = json("data", "company.json");

const KINDS = ["product", "section", "page", "town", "fact", "news"];

// The pages whose headings become sections (the proposal, section 1).
// The order page's sections come from its template, not its Markdown,
// so they are left to the likely queries below.
const SECTION_PAGES = ["about", "accessibility", "delivery-policy",
  "privacy"];
const PAGES = ["/order/", "/about/", "/contact/", "/delivery-policy/",
  "/privacy/", "/accessibility/", "/account/"];

// -> "/delivery-policy/#refunds" for any url an entry may hold.
const where = (url) => {
  const u = new URL(String(url), "https://nff.example/");

  return `${u.pathname}${u.hash}`;
};
const text = (entry) => JSON.stringify(entry).toLowerCase();

// The `##` and `###` headings of a page's Markdown, as built: each
// one's anchor, read from the built page so Hugo's own ids are used.
// A heading's text from its built HTML: tags stripped until none is
// left, then entities decoded once, `&amp;` last, so that none is
// decoded twice.
const plainText = (html) => {
  let text = html;
  let was;

  do {
    was = text;
    text = text.replace(/<[^>]*>/g, "");
  } while (text !== was);

  return text.replace(/&rsquo;|&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, "&").trim();
};

const headings = (out, page) => {
  const md = read("content", `${page}.md`);
  const titles = [...md.matchAll(/^#{2,3} +(.+?)(?: +\{#[^}]+\})? *$/gm)]
    .map(([, title]) => title.trim());
  const html = readFileSync(join(out, page, "index.html"), "utf8");
  const built = [...html.matchAll(
    /<h[23] id="([^"]+)"[^>]*>([\s\S]*?)<\/h[23]>/g)]
    .map(([, id, inner]) => ({
      id, title: plainText(inner),
    }));

  return titles.map((title) => {
    const found = built.find((h) => h.title === title);

    assert.ok(found, `${page}: the heading "${title}" is built with an id`);

    return { title, at: `/${page}/#${found.id}` };
  });
};

// -> the flat list of entries search() returned.
const flat = (results) => results.flatMap((r) => (
  r && Array.isArray(r.entries) ? r.entries : [r]));

describe("#402 site search: the index and the matcher", {
  timeout: 180_000, skip: !hasHugo && "Hugo is not installed here",
}, () => {
  let out;
  let entries;
  let find;

  before(async () => {
    out = mkdtempSync(join(tmpdir(), "nff-search-"));
    const run = spawnSync("hugo", ["--gc", "--quiet", "--environment",
      "production", "-d", out], {
      cwd: root, encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });

    assert.equal(run.status, 0, run.stderr);

    const file = join(out, "search.json");

    if (existsSync(file)) {
      const body = JSON.parse(readFileSync(file, "utf8"));

      entries = Array.isArray(body) ? body : body.entries;
    }

    const match = await import("../assets/scripts/search/match.js");

    find = (query) => {
      assert.ok(Array.isArray(entries), "the build writes search.json");

      return flat(match.search(match.index(entries), query));
    };
  });
  after(() => {
    if (out) rmSync(out, { recursive: true, force: true });
  });

  it("box 2: Hugo writes /search.json at build time with products, "
    + "page sections, pages, delivery towns, quick facts and news, its "
    + "synonyms and keywords read from one data file", () => {
    assert.ok(existsSync(join(out, "search.json")),
      "the build writes search.json at its root");
    assert.ok(Array.isArray(entries), "search.json holds a list of entries");

    for (const entry of entries) {
      assert.ok(KINDS.includes(entry.kind), `a known kind: ${text(entry)}`);
      assert.ok(entry.title && entry.url, `a title and a url: ${text(entry)}`);
    }

    const of = (kind) => entries.filter((e) => e.kind === kind);

    // Products: every item but an archived one, each to the order page.
    const items = CATALOG.groups.flatMap((g) => g.items)
      .filter((item) => item.restock !== "archived");

    for (const item of items) {
      const entry = of("product").find((e) => e.sku === item.sku);

      assert.ok(entry, `a product entry for ${item.sku}`);
      assert.match(where(entry.url), /^\/order\//, `${item.sku} -> /order/`);
    }
    assert.equal(of("product").length, items.length,
      "no product entry for an archived item");

    // Page sections: every ## and ### heading of the pages named.
    for (const page of SECTION_PAGES) {
      for (const { title, at } of headings(out, page)) {
        assert.ok(of("section").some((e) => where(e.url) === at),
          `a section entry for ${page} › ${title} (${at})`);
      }
    }

    // Pages, and none for the 404 page.
    for (const path of PAGES) {
      assert.ok(of("page").some((e) => where(e.url) === path),
        `a page entry for ${path}`);
    }
    assert.ok(!entries.some((e) => /404/.test(where(e.url))),
      "no entry for the 404 page");

    // Delivery towns, each with every ZIP.
    for (const { town, zips } of DELIVERY.area.states
      .flatMap((s) => s.towns)) {
      const entry = of("town").find((e) => text(e).includes(
        town.toLowerCase()));

      assert.ok(entry, `a town entry for ${town}`);
      for (const zip of zips) {
        assert.ok(text(entry).includes(zip), `${town}'s entry has ${zip}`);
      }
    }

    // Quick facts from data.
    assert.ok(of("fact").some((e) => text(e).includes(
      COMPANY.phone.display.toLowerCase())), "a fact with the phone number");
    assert.ok(of("fact").some((e) => text(e).includes(
      COMPANY.email.toLowerCase())), "a fact with the email address");

    // News: every built post.
    const posts = readdirSync(join(out, "news"), { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "page"
        && existsSync(join(out, "news", d.name, "index.html")))
      .map((d) => `/news/${d.name}/`);

    assert.ok(posts.length > 0, "the build has news posts");
    for (const path of posts) {
      assert.ok(of("news").some((e) => where(e.url) === path),
        `a news entry for ${path}`);
    }

    // One data file holds the synonyms and keywords; the scripts hold
    // none. "drumstick" is a synonym (no catalog name uses it) and
    // "hours" a page keyword (no page uses it).
    const data = readdirSync(join(root, "data"))
      .filter((f) => /^search\.(ya?ml|toml|json)$/.test(f));

    assert.equal(data.length, 1, "one data/search.* file");

    const source = read("data", data[0]).toLowerCase();
    const scripts = readdirSync(join(root, "assets", "scripts", "search"))
      .map((f) => read("assets", "scripts", "search", f).toLowerCase())
      .join("\n");

    for (const word of ["drumstick", "hours"]) {
      assert.ok(source.includes(word), `${data[0]} holds "${word}"`);
      assert.ok(!scripts.includes(word),
        `no script in assets/scripts/search holds "${word}"`);
    }
    assert.ok(of("product").filter((e) => e.sku.startsWith("NFF-CHK-DRM"))
      .every((e) => text(e).includes("drumstick")),
    "the drumsticks' entries carry the synonym from data");
    assert.ok(entries.some((e) => e.kind !== "product"
      && text(e).includes("hours")), "a page entry carries \"hours\"");
  });

  it("box 6: the likely queries are answered: eggs, wings, pickup, "
    + "delivery, a delivery town or its ZIP, refund, cancel, hours, "
    + "where, contact, phone and order status", () => {
    const top = (query, n) => find(query).slice(0, n);
    const reaches = (query, n, paths) => {
      const got = top(query, n).map((e) => where(e.url));

      assert.ok(paths.some((p) => got.includes(p)),
        `"${query}": one of ${paths.join(", ")} in the top ${n}; got `
        + `${got.join(", ") || "nothing"}`);
    };
    const skus = (query, n) => top(query, n).filter((e) => e.kind
      === "product").map((e) => e.sku);

    // Products.
    assert.equal(skus("eggs", 1)[0], "NFF-CHK-EGG-LG",
      "\"eggs\": Eggs, Large first");
    const wings = CATALOG.groups.find((g) => g.key === "wings").items
      .map((i) => i.sku);

    assert.deepEqual(skus("wings", wings.length).sort(), [...wings].sort(),
      "\"wings\": every Wings item first");

    // Pickup and delivery.
    reaches("pickup", 5, ["/delivery-policy/#on-farm-pickup"]);
    reaches("pickup", 5, ["/delivery-policy/#pickup-days"]);
    reaches("delivery", 6, ["/delivery-policy/#when-we-deliver"]);
    reaches("delivery", 6, ["/delivery-policy/#delivery-area"]);

    // A town and a ZIP: an answer that goes to the delivery area.
    for (const query of ["Coventry", "02816", "Foster", "02825"]) {
      assert.ok(top(query, 3).some((e) => e.kind === "town"
        && where(e.url) === "/delivery-policy/#delivery-area"),
      `"${query}": its town, to the delivery area, in the top 3`);
    }

    // Policies.
    reaches("refund", 3, ["/delivery-policy/#refunds"]);
    reaches("cancel", 3, ["/delivery-policy/#changing-or-canceling-an-order"]);

    // Where and when.
    const place = ["/about/#where-to-find-us",
      "/delivery-policy/#on-farm-pickup", "/contact/"];

    reaches("hours", 3, place);
    reaches("where", 3, place);

    // Contact.
    reaches("contact", 3, ["/contact/"]);
    assert.ok(top("phone", 3).some((e) => text(e).includes(
      COMPANY.phone.display.toLowerCase())),
    "\"phone\": the phone number in the top 3");

    // Order status: there is no status page; the account is the way.
    reaches("order status", 3, ["/account/"]);
  });

  it("box 8: a one-letter typo in a word of five or more letters still "
    + "matches (\"delivary\", \"chiken\")", () => {
    const delivery = find("delivery").slice(0, 3).map((e) => where(e.url));
    const typo = find("delivary").slice(0, 3).map((e) => where(e.url));

    assert.ok(delivery.length > 0, "\"delivery\" matches");
    assert.deepEqual(typo, delivery,
      "\"delivary\" leads with what \"delivery\" leads with");

    const chicken = find("chiken").slice(0, 5);

    assert.ok(chicken.length > 0, "\"chiken\" matches");
    assert.ok(chicken.every((e) => e.kind === "product"),
      "\"chiken\" leads with products");
    assert.ok(chicken.some((e) => text(e).includes("chicken")),
      "\"chiken\" finds chicken");
  });
});
