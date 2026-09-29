// AR-25 (#145): the gingham egg replaces the NF monogram. Every icon the
// head, the manifest and browserconfig.xml name answers with the art in
// static/favicons/, as do the root paths browsers ask for on their own.
// The look at 16px in a tab stays with a person. docs/qa-launch.md,
// "The autumn refresh".

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "./support/order.mjs";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "static",
  "favicons");
const local = (name) => readFileSync(join(dir, name));

const TYPES = {
  ico: /^image\/(x-icon|vnd\.microsoft\.icon)/,
  png: /^image\/png/,
  svg: /^image\/svg\+xml/,
  webmanifest: /^application\/manifest\+json/,
  xml: /xml/,
};
const type = (name) => TYPES[name.split(".").pop()];

// A PNG's width and height, from its IHDR chunk.
const pngSize = (buf) => `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;

const fetchIcon = async (request, url) => {
  const res = await request.get(url);

  expect(res.status(), url).toBe(200);

  return { body: await res.body(), type: res.headers()["content-type"] };
};

test.describe("favicon (#145)", () => {
  test("every file in static/favicons/ is served as built", async ({
    request,
  }) => {
    for (const name of readdirSync(dir)) {
      const got = await fetchIcon(request, `/favicons/${name}?v=2`);

      expect(got.type, name).toMatch(type(name));
      expect(got.body.equals(local(name)), `${name} is the new art`)
        .toBe(true);
    }
  });

  // The hrefs are relative (relativeURLs), so a page below the root is
  // read too.
  for (const path of ["/", "/order/"]) {
    test(`${path} names the set in its head, and each link answers`,
      async ({ page, request }) => {
        await page.goto(path);

        const links = await page.evaluate(() => [
          ...document.querySelectorAll("link[rel~='icon'], "
            + "link[rel='apple-touch-icon'], link[rel='manifest'], "
            + "link[rel='mask-icon']"),
        ].map((el) => ({
          rel: el.getAttribute("rel"),
          href: el.href,
          path: new URL(el.href).pathname,
          sizes: el.getAttribute("sizes"),
          color: el.getAttribute("color"),
        })));
        const meta = (name) => page
          .locator(`meta[name='${name}']`).getAttribute("content");

        expect(links.map((l) => l.path).sort()).toEqual([
          "/favicons/apple-touch-icon.png",
          "/favicons/favicon-16x16.png",
          "/favicons/favicon-32x32.png",
          "/favicons/favicon.ico",
          "/favicons/favicon.svg",
          "/favicons/safari-pinned-tab.svg",
          "/favicons/site.webmanifest",
        ]);
        expect(links.find((l) => l.rel === "mask-icon").color).toBe("#1e7b54");
        expect(await meta("msapplication-TileColor")).toBe("#1e7b54");

        for (const link of links) {
          const name = link.path.replace("/favicons/", "");
          const got = await fetchIcon(request, link.href);

          expect(got.type, name).toMatch(type(name));
          if (link.sizes && name.endsWith(".png")) {
            expect(pngSize(got.body), name).toBe(link.sizes);
          }
        }

        const config = await meta("msapplication-config");
        const xml = (await fetchIcon(request, config)).body.toString();
        const tile = xml.match(/square150x150logo src="([^"]+)"/)[1];

        expect(xml).toContain("<TileColor>#1e7b54</TileColor>");
        // Windows draws its tiles at 1.8 times, so this one is 270px.
        expect((await fetchIcon(request, tile)).body
          .equals(local("mstile-150x150.png"))).toBe(true);
      });
  }

  test("the manifest lists its icons where they are, one maskable", async ({
    request,
  }) => {
    const res = await request.get("/favicons/site.webmanifest?v=2");

    expect(res.headers()["content-type"])
      .toMatch(/^application\/manifest\+json/);

    const { icons } = await res.json();

    expect(icons.filter((i) => i.purpose === "maskable")).toHaveLength(1);
    for (const icon of icons) {
      const got = await fetchIcon(request, icon.src);

      expect(got.type, icon.src).toMatch(TYPES.png);
      expect(pngSize(got.body), icon.src).toBe(icon.sizes);
    }
  });

  test("the root paths browsers guess answer with the set", async ({
    request,
  }) => {
    const ROOT = {
      "/favicon.ico": "favicon.ico",
      "/apple-touch-icon.png": "apple-touch-icon.png",
      "/apple-touch-icon-precomposed.png": "apple-touch-icon.png",
    };

    for (const [path, name] of Object.entries(ROOT)) {
      const got = await fetchIcon(request, path);

      expect(got.body.equals(local(name)), path).toBe(true);
    }
  });

  test("the pinned-tab icon is one color", async ({ request }) => {
    const svg = (await fetchIcon(request, "/favicons/safari-pinned-tab.svg"))
      .body.toString();
    const colors = new Set(svg.match(/#[0-9a-f]{3,6}\b|rgb\([^)]*\)/gi));

    // Black draws the shape; white only cuts the ring in its mask.
    expect([...colors].sort()).toEqual(["#000", "#fff"]);
  });
});
