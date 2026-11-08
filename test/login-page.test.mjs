// The sign-in page's button starts disabled in the markup and the
// login script enables it once its submit handler is wired, so a press
// before the script runs can't submit the form natively and put the
// email address in the URL as a GET query (#521).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url),
  "utf8");

describe("the sign-in page's submit guard", () => {
  it("draws the button disabled", () => {
    const call = read("layouts/login/single.html")
      .match(/partial "busy-button\.html"[^}]*"login-submit"[^}]*/);

    assert.ok(call, "the busy-button call for #login-submit");
    assert.match(call[0], /"disabled" true/);
  });

  it("enables it after the submit handler is attached", () => {
    const script = read("assets/scripts/login/main.js");
    const wired = script.indexOf('form.addEventListener("submit"');
    const enabled = script.indexOf("submit.disabled = false");

    assert.ok(wired > -1, "the submit handler");
    assert.ok(enabled > wired, "enabled after the handler");
  });
});
