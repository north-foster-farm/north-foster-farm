// The busy button (layouts/partials/busy-button.html), shared by the
// news sign-up and the contact form: while its request runs it fades
// to an egg spinner and a busy word, at the same width.

import { expect } from "@playwright/test";

// Holds every request matching `url` until `release()` is called, then
// answers with `status` and `body`. -> { release, calls() }
export const holdRequests = async (page, url, {
  status = 200, body = {},
} = {}) => {
  let calls = 0;
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });

  await page.route(url, async (route) => {
    calls += 1;
    await held;
    await route.fulfill({
      status, contentType: "application/json", body: JSON.stringify(body),
    });
  });

  return { release, calls: () => calls };
};

// Checks the button while busy: `busyWord` beside the spinner, faded
// in over the idle label, at `width`.
export const expectBusy = async (page, button, { busyWord, width }) => {
  const busy = button.locator(".busy-button-busy");

  await expect(button).toHaveAttribute("data-busy", "true");
  await expect(button).toHaveAttribute("aria-disabled", "true");
  await page.waitForTimeout(400);
  await expect(busy).toHaveText(busyWord);
  await expect(busy).toHaveCSS("opacity", "1");
  await expect(busy).toHaveAttribute("aria-hidden", "false");
  await expect(busy.locator("svg.egg-spinner")).toBeVisible();
  await expect(button.locator(".busy-button-idle"))
    .toHaveCSS("opacity", "0");
  expect((await button.boundingBox()).width, "width while busy")
    .toBe(width);
};

export const expectIdle = async (button, { width }) => {
  await expect(button).toHaveAttribute("data-busy", "false");
  await expect(button).toHaveAttribute("aria-disabled", "false");
  expect((await button.boundingBox()).width, "width after").toBe(width);
};
