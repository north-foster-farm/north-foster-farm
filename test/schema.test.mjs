import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { checkGraph, checkHtml } from "../bin/schema/check.mjs";

// The built graphs of the home page, a news post and /order/, as
// layouts/partials/head/schema.html wrote them on 2026-09-28.
const fixture = (name) => JSON.parse(readFileSync(
  new URL(`fixtures/schema/${name}.json`, import.meta.url), "utf8"));
const rules = (data) => checkGraph(data).map((f) => f.rule);
const node = (data, type) => data["@graph"].find((n) => n["@type"] === type);
const page = (data) =>
  `<head><script type="application/ld+json">${JSON.stringify(data)}`
  + "</script></head>";

describe("the schema check", () => {
  for (const name of ["home", "post", "order"]) {
    it(`passes the built ${name} page`, () => {
      assert.deepEqual(checkGraph(fixture(name)), []);
    });
  }

  it("wants one schema.org graph", () => {
    assert.deepEqual(rules({ "@context": "https://schema.org" }), ["S2"]);
    assert.deepEqual(checkHtml("<head></head>").map((f) => f.rule), ["S1"]);
    assert.deepEqual(checkHtml(
      '<script type="application/ld+json">{</script>').map((f) => f.rule),
    ["S1"]);
  });

  it("skips a redirect page", () => {
    assert.deepEqual(
      checkHtml('<meta http-equiv="refresh" content="0; url=/">'), []);
  });

  it("finds an unknown type, a missing @id and a repeated one", () => {
    const data = fixture("order");
    data["@graph"].push({ "@type": "Thing", "@id": "x" });
    delete node(data, "WebSite")["@id"];
    data["@graph"].push({ ...node(data, "WebPage") });
    // Both copies of the page point at the site, which lost its @id.
    assert.deepEqual(rules(data), ["S3", "S3", "S3", "S4", "S4"]);
  });

  it("finds a reference to a node not in the graph", () => {
    const data = fixture("post");
    node(data, "BlogPosting").author = { "@id": "https://x/#someone" };
    assert.deepEqual(rules(data), ["S4"]);
  });

  it("wants absolute https URLs", () => {
    const data = fixture("post");
    node(data, "BlogPosting").image = "/images/linus.jpg";
    node(data, "BreadcrumbList").itemListElement[0].item = "http://x/";
    assert.deepEqual(rules(data), ["S5", "S5"]);
  });

  it("wants each type's properties and a whole address", () => {
    const data = fixture("home");
    const farm = node(data, "LocalBusiness");
    delete farm.logo;
    delete farm.address.postalCode;
    farm.geo.latitude = "41.8";
    delete node(data, "Event").location.name;
    assert.deepEqual(rules(data), ["S6", "S6", "S6", "S6"]);
  });

  it("wants dates with an offset, in order", () => {
    const data = fixture("home");
    const event = node(data, "Event");
    event.startDate = "2026-10-18";
    assert.deepEqual(rules(data), ["S6"]);
    event.startDate = "2026-10-18T15:00:00-04:00";
    assert.deepEqual(rules(data), ["S6"]);
  });

  it("wants a headline Google will show whole", () => {
    const data = fixture("post");
    node(data, "BlogPosting").headline = "x".repeat(111);
    assert.deepEqual(rules(data), ["S6"]);
  });

  it("wants breadcrumbs counted from 1, linked but the last", () => {
    const data = fixture("post");
    const items = node(data, "BreadcrumbList").itemListElement;
    items[0].position = 0;
    delete items[1].item;
    assert.deepEqual(rules(data), ["S7", "S7"]);
  });

  it("wants a BlogPosting on a post and the address on the home page", () => {
    const post = fixture("post");
    post["@graph"] = post["@graph"].filter(
      (n) => n["@type"] !== "BlogPosting");
    assert.deepEqual(
      checkHtml(page(post), "news/a-post/index.html").map((f) => f.rule),
      ["S8"]);
    assert.deepEqual(checkHtml(page(post), "news/page/2/index.html"), []);
    assert.deepEqual(
      checkHtml(page(fixture("order")), "index.html").map((f) => f.rule),
      ["S8"]);
    assert.deepEqual(checkHtml(page(fixture("home")), "index.html"), []);
  });
});
