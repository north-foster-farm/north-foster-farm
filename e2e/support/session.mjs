// Signing in as a test customer without waiting on the emailed link:
// the deploy's back office mints the same link, unsent.

import { expect } from "@playwright/test";

import { followLink } from "./request-error.mjs";
import { nff } from "./staging.mjs";

// Leaves the page on the account, signed in as `email`.
export const signIn = async (page, email) => {
  await followLink(page, await nff(["login", email]));
  await expect(page).toHaveURL(/\/account\/?/);
};
