// The access gate in front of every non-production deploy
// (docs/staging.md). These run without the suite's machine cookie, as a
// stranger arrives. Nothing here sends mail: the address asked for is
// not on the allowlist.

import { expect, test } from "@playwright/test";

const stranger = { cookies: [], origins: [] };

test.describe("the access gate", () => {
  test.use({ storageState: stranger });

  test("stops an anonymous visit with the sign-in page", async ({ page }) => {
    const res = await page.goto("/");

    expect(res.status()).toBe(401);
    expect(res.headers()["x-robots-tag"]).toContain("noindex");
    await expect(page.getByRole("button", { name: "Send the link" }))
      .toBeVisible();
    await expect(page.locator("body")).not.toContainText("Order");
  });

  test("stops a script too, with no page", async ({ request }) => {
    for (const [method, path] of [["get", "/api/me"],
      ["post", "/api/orders"], ["get", "/api/staging/outbox"],
      ["get", "/api/staging/info"], ["get", "/api/health"]]) {
      const res = await request[method](path);

      expect(res.status(), `${method} ${path}`).toBe(401);
      expect(res.headers()["x-robots-tag"]).toContain("noindex");
    }
  });

  test("answers an unlisted address as it would a listed one",
    async ({ page }) => {
      await page.goto("/");
      await page.getByLabel("Email address")
        .fill(`qa-gate-${Date.now().toString(36)}@example.com`);
      await page.getByRole("button", { name: "Send the link" }).click();
      await expect(page.getByRole("heading", { name: "Check your email" }))
        .toBeVisible();
    });

  test("leaves the webhooks to their own signatures", async ({ request }) => {
    for (const path of ["/api/square/webhook", "/api/paypal/webhook"]) {
      const res = await request.post(path, { data: "{}" });

      expect(res.status(), path).toBe(401);
      expect(await res.json(), path).toEqual({ error: "Bad signature." });
    }
  });

  test("keeps the jobs route closed without the token", async ({ request }) => {
    const res = await request.post("/api/staging/jobs/run", { data: {} });

    expect(res.status()).toBe(401);
    expect(await res.text()).toBe("Sign in required.\n");
  });
});
