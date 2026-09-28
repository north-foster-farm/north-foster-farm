// The site's llms.txt links the delivery policy as Markdown, in place of a
// paraphrase (Q21a, #192), and that file is the policy itself.
import { test, expect } from "@playwright/test";

test.describe("llms.txt and the Markdown policy (Q21a)", () => {
  test("llms.txt links the policy's Markdown", async ({ request }) => {
    const text = await (await request.get("/llms.txt")).text();

    expect(text).toMatch(
      /\[Delivery policy\]\(\S+\/delivery-policy\/index\.md\)/
    );
    // The paraphrase is gone: its cooler and weather terms live only in
    // the policy now.
    expect(text).not.toMatch(/leave a cooler/i);
    expect(text).not.toMatch(/doorbell/i);
    expect(text).not.toMatch(/weather or the like/i);
  });

  test("the Markdown policy is the page's text, data filled in",
    async ({ request }) => {
      const res = await request.get("/delivery-policy/index.md");

      expect(res.ok()).toBe(true);
      const text = await res.text();

      expect(text.startsWith("# Delivery policy\n")).toBe(true);
      for (const heading of ["When we deliver", "What it costs",
        "How you pay", "On delivery day", "Delivery area",
        "Pickup and the drop site", "Changing or cancelling an order",
        "Refunds"]) {
        expect(text, heading).toContain(`\n## ${heading}\n`);
      }
      // Shortcodes are filled in; none is left raw, and no HTML leaks.
      expect(text).not.toContain("{{");
      expect(text).not.toMatch(/<(div|table|a|span|svg)[\s>]/);
      expect(text).toMatch(/\| Town \| ZIP codes \|/);
      expect(text).toMatch(/\| Foster \| 02825 \|/);
    });
});
