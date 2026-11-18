// The Membership tab's layout (#602) and the account head on a phone
// (#601), measured in the browser. Each test proves rows of the test
// agent's criteria table. It runs on the production build, where
// PurgeCSS has had its say, so a class the build stripped shows here
// as a style that is missing. desktop measures every width James
// named; phone (Chromium) and iphone (WebKit) measure their own width
// and 320 px. Canned, so nothing is saved.

import { expect, test } from "./support/order.mjs";
import {
  CLOSED_ROUNDS, MEMBER_GROUP, ME, VIEW, groups, signIn,
} from "./support/membership.mjs";

// The widths each project measures: null is the project's own.
const widthsFor = (project) => (project === "desktop"
  ? [1280, 768, 390, 320] : [null, 320]);
const phoneWidthsFor = (project) => (project === "desktop"
  ? [390, 320] : [null, 320]);
const label = (w) => (w ? `${w} px` : "its own width");

const atWidth = async (page, width) => {
  if (width) await page.setViewportSize({ width, height: 800 });
};

const open = async (page, context, baseURL, options) => {
  await signIn(page, context, baseURL, options);
  await page.goto("/account/#membership");
  await expect(groups(page).own.locator("[data-mem-round]").first())
    .toBeVisible();
};

// Each round of a group block, measured: its column, its two lines,
// the date, the window and the pill.
const measureRounds = (block) => block.locator("[data-mem-round]")
  .evaluateAll((cols) => cols.map((col) => {
    const box = (el) => el.getBoundingClientRect();
    const style = (el) => getComputedStyle(el);
    const date = col.querySelector("[data-round='date']");
    const window = col.querySelector("[data-round='window']");
    const [when, status] = col.querySelectorAll("p");
    const pill = status.querySelector(".account-round-pill");
    const ps = style(pill);

    return {
      col: box(col).toJSON(),
      dateRects: date.getClientRects().length,
      windowRects: window.getClientRects().length,
      dateWeight: Number(style(date).fontWeight),
      windowWeight: Number(style(window).fontWeight),
      when: box(when).toJSON(),
      status: box(status).toJSON(),
      whenSize: parseFloat(style(when).fontSize),
      statusSize: parseFloat(style(status).fontSize),
      whenColor: style(when).color,
      statusColor: style(status).color,
      pill: box(pill).toJSON(),
      pillText: pill.textContent.trim(),
      // Drawn as a pill: a fill or an outline, and round corners.
      pillDrawn: (ps.backgroundColor !== "rgba(0, 0, 0, 0)"
        || parseFloat(ps.borderTopWidth) > 0 || ps.boxShadow !== "none")
        && parseFloat(ps.borderTopLeftRadius) > 0,
    };
  }));

test.describe("a round on the Membership tab (#602)", () => {
  // Criterion 6.
  test("sets the date bold and the window regular", async ({
    page, context, baseURL,
  }) => {
    await open(page, context, baseURL);

    for (const r of await measureRounds(groups(page).own)) {
      expect(r.dateWeight).toBeGreaterThanOrEqual(700);
      expect(r.windowWeight).toBeLessThanOrEqual(500);
    }
  });

  // Criterion 9.
  test("puts the second line under the first, smaller and gray", async ({
    page, context, baseURL,
  }) => {
    await open(page, context, baseURL);

    for (const r of await measureRounds(groups(page).own)) {
      expect(r.status.top).toBeGreaterThanOrEqual(r.when.bottom - 0.5);
      expect(r.statusSize).toBeLessThan(r.whenSize);
      expect(r.statusColor).not.toBe(r.whenColor);
    }
  });

  for (const width of [1280, 768, 390, 320, null]) {
    // Criteria 7, 10, 13 and 34.
    test(`keeps the date and window whole, the pill first, at ${
      label(width)}`, async ({ page, context, baseURL }, info) => {
      const widths = widthsFor(info.project.name);

      test.skip(!widths.includes(width), "another project's width");
      await atWidth(page, width);
      await open(page, context, baseURL, {
        view: { ...VIEW, member: { ...VIEW.member, rounds: CLOSED_ROUNDS } },
      });

      const rounds = await measureRounds(groups(page).own);

      expect(rounds.map((r) => r.pillText)).toEqual(["Closed", "Open",
        "Next"]);
      for (const r of rounds) {
        expect(r.dateRects, `${r.pillText}: the date whole`).toBe(1);
        expect(r.windowRects, `${r.pillText}: the window whole`).toBe(1);
        // The pill opens the second line, at its left, never the right.
        expect(Math.abs(r.pill.left - r.status.left)).toBeLessThan(1);
        expect(r.pill.top - r.status.top).toBeLessThan(8);
        expect(r.pillDrawn, `${r.pillText}: drawn as a pill`).toBe(true);
        // The pill and its sentence wrap inside the column.
        expect(r.status.right).toBeLessThanOrEqual(r.col.right + 0.5);
        expect(r.when.right).toBeLessThanOrEqual(r.col.right + 0.5);
      }
    });
  }

  // Criterion 8: given less room than the line needs, it breaks at the
  // dot, the dot staying with the date, and nowhere else.
  test("breaks the first line at the dot when it must wrap", async ({
    page, context, baseURL,
  }) => {
    await open(page, context, baseURL);

    const m = await groups(page).own.locator("[data-mem-round]").evaluateAll(
      (cols) => cols.map((col) => {
        const date = col.querySelector("[data-round='date']");
        const window = col.querySelector("[data-round='window']");
        const when = col.querySelector("p");

        // Room for the date and its dot, not for the window as well.
        when.style.width = `${date.getBoundingClientRect().width + 24}px`;

        const walk = document.createTreeWalker(when, NodeFilter.SHOW_TEXT);
        let dot = null;

        for (let n = walk.nextNode(); n && !dot; n = walk.nextNode()) {
          const i = n.data.indexOf("·");

          if (i >= 0) {
            const range = document.createRange();

            range.setStart(n, i);
            range.setEnd(n, i + 1);
            dot = range.getBoundingClientRect();
          }
        }

        const d = date.getBoundingClientRect();
        const w = window.getBoundingClientRect();

        return {
          dateRects: date.getClientRects().length,
          windowRects: window.getClientRects().length,
          wrapped: w.top >= d.bottom - 1,
          dotWithDate: !!dot && Math.abs(dot.top - d.top) < 4,
        };
      })
    );

    for (const r of m) {
      expect(r).toEqual({ dateRects: 1, windowRects: 1, wrapped: true,
        dotWithDate: true });
    }
  });

  // Criterion 14 (James's review, 2026-11-18): side by side from lg,
  // 992 px.
  for (const width of [992, 1280]) {
    test(`sets two rounds side by side at ${width} px`, async ({
      page, context, baseURL,
    }, info) => {
      test.skip(info.project.name !== "desktop", "desktop widths only");
      await atWidth(page, width);
      await open(page, context, baseURL);

      const [a, b] = await measureRounds(groups(page).own);

      expect(Math.abs(a.col.top - b.col.top)).toBeLessThan(1);
      expect(b.col.left).toBeGreaterThanOrEqual(a.col.right - 1);
    });
  }

  // Criterion 15 (James's review, 2026-11-18): "The rounds should sit
  // in a single column on med screens", so stacked below 992 px, 768
  // px included.
  for (const width of [768, 390, 320, null]) {
    test(`stacks the rounds at ${label(width)}`, async ({
      page, context, baseURL,
    }, info) => {
      const widths = info.project.name === "desktop"
        ? [768, 390, 320] : [null, 320];

      test.skip(!widths.includes(width), "another project's width");
      await atWidth(page, width);
      await open(page, context, baseURL);

      const [a, b] = await measureRounds(groups(page).own);

      expect(Math.abs(a.col.left - b.col.left)).toBeLessThan(1);
      expect(b.col.top).toBeGreaterThanOrEqual(a.col.bottom - 0.5);
    });
  }

  // Criterion 16: the hosted group has the open round alone.
  test("sets one round alone at the left", async ({
    page, context, baseURL,
  }) => {
    await open(page, context, baseURL);

    const { hosted } = groups(page);
    const m = await hosted.evaluate((block) => {
      const cols = block.querySelectorAll("[data-mem-round]");
      const heading = Array.from(block.querySelectorAll("h3"))
        .find((h) => h.textContent.trim() === "Pickups");
      const when = cols[0].querySelector("p");

      return {
        count: cols.length,
        left: when.getBoundingClientRect().left
          - heading.getBoundingClientRect().left,
        // Its lines, not the column's gutter.
        inside: Math.max(...Array.from(cols[0].children,
          (el) => el.getBoundingClientRect().right))
          <= block.getBoundingClientRect().right + 0.5,
      };
    });

    expect(m.count).toBe(1);
    expect(Math.abs(m.left)).toBeLessThan(1);
    expect(m.inside).toBe(true);
  });
});

test.describe("the group on the Membership tab (#602)", () => {
  // Criteria 1 and 2.
  test("the group's name is the account email's size, bold, the address "
    + "one small gray line", async ({ page, context, baseURL }) => {
    await open(page, context, baseURL);

    const m = await groups(page).own.evaluate((block) => {
      const style = (el) => getComputedStyle(el);
      const name = block.querySelector("h2");
      const address = block.querySelector("[data-mem='address']");
      const email = document.getElementById("account-email");
      const a = address.getBoundingClientRect();

      return {
        nameSize: parseFloat(style(name).fontSize),
        emailSize: parseFloat(style(email).fontSize),
        rootSize: parseFloat(style(document.documentElement).fontSize),
        nameWeight: Number(style(name).fontWeight),
        addressSize: parseFloat(style(address).fontSize),
        bodySize: parseFloat(style(document.body).fontSize),
        addressLines: Math.round(a.height
          / parseFloat(style(address).lineHeight)),
        under: a.top >= name.getBoundingClientRect().bottom - 0.5,
        nameColor: style(name).color,
        addressColor: style(address).color,
      };
    });

    expect(m.nameSize).toBe(m.emailSize);
    expect(m.nameSize).toBe(1.25 * m.rootSize);
    expect(m.nameWeight).toBeGreaterThanOrEqual(700);
    expect(m.addressLines).toBe(1);
    expect(m.under).toBe(true);
    expect(m.addressSize).toBeLessThan(m.bodySize);
    expect(m.addressColor).not.toBe(m.nameColor);
  });

  // Criterion 31: the space above each section heading, from the
  // lowest thing drawn before it to the heading, the same in the
  // member's group as in the host's.
  test("gives every section heading the host's space above it", async ({
    page, context, baseURL,
  }) => {
    await open(page, context, baseURL);

    const gaps = await page.locator("#mem-groups").evaluate((root) => {
      const shown = (el) => el.getClientRects().length > 0
        && getComputedStyle(el).visibility !== "hidden";
      const lowest = (el) => Math.max(el.getBoundingClientRect().bottom,
        ...Array.from(el.querySelectorAll("*")).filter(shown)
          .map((d) => d.getBoundingClientRect().bottom));
      const before = (el) => {
        for (let n = el; n && n !== root; n = n.parentElement) {
          for (let s = n.previousElementSibling; s;
            s = s.previousElementSibling) {
            if (shown(s)) return s;
          }
        }

        return null;
      };

      return Array.from(root.querySelectorAll("[data-mem-group]"),
        (block) => Array.from(block.querySelectorAll("h3"))
          .filter(shown)
          .map((h) => {
            // The heading's section, and what shows before it.
            const section = h.closest("section");
            const prev = before(section);

            return {
              heading: h.textContent.trim(),
              gap: h.getBoundingClientRect().top - lowest(prev),
            };
          }));
    });

    const [own, hosted] = gaps;
    const host = hosted.find((g) => g.heading === "Invite members").gap;

    expect(own.map((g) => g.heading)).toEqual(["Pickups",
      "Membership QR code", "Leave the group"]);
    // #579: never flush under what came before.
    expect(host).toBeGreaterThan(8);
    for (const g of [...own, ...hosted]) {
      expect(Math.abs(g.gap - host), g.heading).toBeLessThan(1);
    }
  });

  // Criteria 25 and 26.
  test("veils the QR code in white and centers Coming soon on it", async ({
    page, context, baseURL,
  }) => {
    await open(page, context, baseURL);

    const code = groups(page).own.getByRole("region",
      { name: "Membership QR code" });
    const img = code.getByRole("img");

    await expect(img).toBeVisible();
    await img.scrollIntoViewIfNeeded();

    const m = await img.evaluate((image) => {
      const r = image.getBoundingClientRect();
      const white = (bg) => {
        const c = bg.match(/rgba?\(([^)]+)\)/);
        const [red, green, blue, alpha = "1"] = c ? c[1].split(",")
          .map((x) => x.trim()) : [];

        return c && red === "255" && green === "255" && blue === "255"
          ? Number(alpha) : 0;
      };
      // How much white an element lays over the code: its own fill, or
      // its ::before or ::after's, times its opacity.
      const veil = (el) => Math.max(...[null, "::before", "::after"]
        .map((p) => {
          const s = getComputedStyle(el, p);

          if (p && s.content === "none") return 0;

          return white(s.backgroundColor) * Number(s.opacity);
        }));
      // At a point of the code, the most white over it: from what is
      // stacked above the image there, or, for a veil that lets the
      // pointer through, the image's own box's ::before or ::after.
      const over = ([x, y]) => {
        const stack = document.elementsFromPoint(x, y);
        const above = stack.slice(0, stack.indexOf(image));

        return Math.max(0, ...above.map(veil),
          stack[0] === image ? veil(image.parentElement) : 0);
      };
      const corners = [[r.left + 4, r.top + 4], [r.right - 4, r.top + 4],
        [r.left + 4, r.bottom - 4], [r.right - 4, r.bottom - 4]];
      const badge = Array.from(image.parentElement.querySelectorAll("*"))
        .find((el) => el.textContent.trim() === "Coming soon"
          && el.children.length === 0);
      const b = badge.getBoundingClientRect();
      const center = document.elementFromPoint((r.left + r.right) / 2,
        (r.top + r.bottom) / 2);

      return {
        veils: corners.map(over),
        dx: (b.left + b.right) / 2 - (r.left + r.right) / 2,
        dy: (b.top + b.bottom) / 2 - (r.top + r.bottom) / 2,
        badgeOnTop: !!center && (center === badge || badge.contains(center)
          || center.contains(badge)),
      };
    });

    // Something covers the whole code, white and see-through.
    for (const v of m.veils) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
    expect(Math.abs(m.dx)).toBeLessThan(1.5);
    expect(Math.abs(m.dy)).toBeLessThan(1.5);
    expect(m.badgeOnTop).toBe(true);
  });
});

// #601, criteria 36 to 38: at 390 px and below the head is one column,
// the avatar and the email address on top, the group's name and the
// credit as their own row under them, and the address keeps 60% of
// the head at least, on one line.
test.describe("the account head of a long-named group's member (#601)",
  () => {
    for (const width of [390, 320, null]) {
      test(`stacks in one column at ${label(width)}`, async ({
        page, context, baseURL,
      }, info) => {
        test.skip(!phoneWidthsFor(info.project.name).includes(width),
          "another project's width");
        await atWidth(page, width);
        await signIn(page, context, baseURL, {
          me: { ...ME, customer: { ...ME.customer,
            email: "member@example.com" } },
        });
        await page.goto("/account/#membership");

        await expect(page.locator("#account-email"))
          .toHaveText("member@example.com");
        await expect(page.locator("#account-member"))
          .toContainText(MEMBER_GROUP);
        await expect(page.locator("#account-member"))
          .toContainText("Credit");

        const m = await page.locator("#account-app .account-head").evaluate(
          (head) => {
            const box = (el) => el.getBoundingClientRect();
            const email = head.querySelector("#account-email");
            const avatar = head.querySelector("#account-avatar");
            const group = head.querySelector("[data-member-group]");
            const credit = head.querySelector("[data-member-credit]");
            const top = Math.max(box(email).bottom, box(avatar).bottom);

            return {
              share: box(email).width / box(head).width,
              emailLines: Math.round(box(email).height
                / parseFloat(getComputedStyle(email).lineHeight)),
              groupUnder: box(group).top >= top - 0.5,
              creditUnder: box(credit).top >= top - 0.5,
              inside: Math.max(box(group).right, box(credit).right)
                <= box(head).right + 0.5,
            };
          }
        );

        expect(m.share).toBeGreaterThanOrEqual(0.6);
        expect(m.emailLines).toBe(1);
        expect(m.groupUnder).toBe(true);
        expect(m.creditUnder).toBe(true);
        expect(m.inside).toBe(true);
      });
    }

    // Criterion 37a (coordinator, 2026-11-18, from #601): an address
    // too long for one line breaks only before the @ or before a dot,
    // never inside a word, and stays inside the head.
    const LONG = ["first.last@example.co.uk",
      "jonathan.appleseed@farmmail.com"];

    for (const width of [320, 360, 390]) {
      for (const email of LONG) {
        test(`breaks a ${email.length}-character address only before `
          + `the @ or a dot at ${width} px`, async ({
          page, context, baseURL,
        }) => {
          await atWidth(page, width);
          await signIn(page, context, baseURL, {
            me: { ...ME, customer: { ...ME.customer, email } },
          });
          await page.goto("/account/#membership");
          await expect(page.locator("#account-email")).toHaveText(email);

          const m = await page.locator("#account-app .account-head")
            .evaluate((head) => {
              const el = head.querySelector("#account-email");
              const walk = document.createTreeWalker(el,
                NodeFilter.SHOW_TEXT);
              const chars = [];

              for (let n = walk.nextNode(); n; n = walk.nextNode()) {
                for (let i = 0; i < n.data.length; i += 1) {
                  const range = document.createRange();

                  range.setStart(n, i);
                  range.setEnd(n, i + 1);

                  const r = range.getBoundingClientRect();

                  if (r.width > 0) {
                    chars.push({ c: n.data[i], top: r.top, right: r.right });
                  }
                }
              }

              // The character that starts each line after the first.
              const starts = chars.filter((ch, i) => i > 0
                && ch.top > chars[i - 1].top + 2).map((ch) => ch.c);

              return {
                starts,
                inside: Math.max(...chars.map((ch) => ch.right))
                  <= head.getBoundingClientRect().right + 0.5,
              };
            });

          for (const c of m.starts) expect(["@", "."]).toContain(c);
          expect(m.inside).toBe(true);
        });
      }
    }
  });
