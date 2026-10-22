// The busy button (layouts/partials/busy-button.html), on every button
// that sends a request (#299): while its request runs it fades
// to an egg spinner and a busy word, at the same width or, when fitted,
// at the busy word's.

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
  // A screen reader hears the busy word, and that it is working (#299).
  await expect(button).toHaveAttribute("aria-busy", "true");
  await expect(button).toHaveAccessibleName(busyWord);
  await page.waitForTimeout(400);
  await expect(busy).toHaveText(busyWord);
  await expect(busy).toHaveCSS("opacity", "1");
  await expect(busy).toHaveAttribute("aria-hidden", "false");
  await expect(busy.locator("svg.egg-spinner")).toBeVisible();
  await expect(button.locator(".busy-button-idle"))
    .toHaveCSS("opacity", "0");
  expect((await button.boundingBox()).width, "width while busy")
    .toBeCloseTo(width, 0);
};

export const expectIdle = async (button, { width }) => {
  await expect(button).toHaveAttribute("data-busy", "false");
  await expect(button).toHaveAttribute("aria-disabled", "false");
  await expect(button).not.toHaveAttribute("aria-busy");
  expect((await button.boundingBox()).width, "width after")
    .toBeCloseTo(width, 0);
};
