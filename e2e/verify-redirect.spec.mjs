// What the sign-in link answers, read off the wire: the redirect says
// where to go and nothing more. An emailed change link must reach the
// account page with its token in the fragment only, so it never shows
// in a request line a server could log (#345, #449). A staging run once
// ended on /account/?token=... with nothing in the code adding it, and
// this finds which layer does.
import { test, expect } from "@playwright/test";

test.describe("the sign-in link's redirect", () => {
  test("an unknown token is sent to the sign-in page without it",
    async ({ request }) => {
      const res = await request.get(
        "/api/auth/verify?token=not-a-real-token", { maxRedirects: 0 }
      );

      expect(res.status()).toBe(302);
      expect(res.headers().location).toMatch(/^\/login\/\?error=unknown$/);
    });
});
