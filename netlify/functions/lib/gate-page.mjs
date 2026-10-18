// The gate's two pages, each a whole document with its styles inline:
// a gated visitor has no stylesheet of the site's to lean on, and the
// page must read on a phone (16 px type, so iOS does not zoom a field).

import gate from "../../../data/gate.json" with { type: "json" };

const LINK_MINUTES = gate.linkMinutes;

const escape = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

const shell = (title, body) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escape(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: #fbf7ee;
    color: #1d1c1b; }
  main { max-width: 26rem; margin: 0 auto; padding: 4rem 16px; }
  h1 { font-size: 1.5rem; line-height: 1.2; margin: 0 0 1rem; }
  p { margin: 0 0 1rem; }
  label { display: block; font-weight: 600; margin-bottom: .25rem; }
  input[type=email] { box-sizing: border-box; width: 100%; font: inherit;
    padding: .75rem; border: 2px solid #6b6258; border-radius: .5rem;
    background: #fff; color: #1d1c1b; }
  button { font: inherit; font-weight: 600; width: 100%; margin-top: 1rem;
    padding: .875rem; border: 0; border-radius: .5rem; background: #2f5d3a;
    color: #fff; cursor: pointer; }
  .note { color: #5a534b; font-size: .9375rem; }
  .hp { position: absolute; left: -10000px; }
  @media (prefers-color-scheme: dark) {
    body { background: #1d1c1b; color: #f3eee3; }
    input[type=email] { background: #2a2826; color: #f3eee3;
      border-color: #a39a8d; }
    .note { color: #b9b0a2; }
  }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;

// `message` is one line of ours (never a visitor's text).
export const signInPage = ({ next = "/", message = "" } = {}) => shell(
  "Staging sign-in",
  `<h1>This site is not public yet</h1>
<p>Enter your email address. If authorized, you will receive a link.
Click it to sign in.</p>
${message ? `<p role="alert"><strong>${escape(message)}</strong></p>` : ""}
<form method="post" action="/api/gate/request">
  <label for="email">Email address</label>
  <input id="email" name="email" type="email" inputmode="email"
    autocomplete="email" autocapitalize="off" required>
  <input class="hp" name="website" tabindex="-1" autocomplete="off"
    aria-hidden="true">
  <input type="hidden" name="next" value="${escape(next)}">
  <button type="submit">Send the link</button>
</form>`
);

// The same page for every address, on the list or not.
export const checkEmailPage = () => shell(
  "Use the link you received to sign in",
  `<h1>Use the link you received to sign in</h1>
<p>If authorized, you will receive a single-use link to sign in. The link
expires after ${LINK_MINUTES} minutes.</p>
<p class="note"><a href="/api/gate/signin">Use a different address</a></p>`
);

// What a script or a pinger gets in place of the page.
export const blockedText = "Sign in required.\n";
