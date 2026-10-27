// The gate's pages (#294), each a whole document with its styles
// inline. They are served before anyone is signed in, by the edge as
// well as the gate's function, so they can load nothing: not the
// site's stylesheet, fonts or scripts, and nothing from elsewhere. The
// logo is inline (lib/gate-logo.mjs), Aller regular and bold ride
// along as data: URIs (lib/gate-fonts.mjs, which the site's CSP allows
// in font-src), and the styles below copy the site's own, read from
// its build: the header row and its green
// stripe, Bootstrap's field, and the brand button in every state
// (_global.scss, _variables.scss). In dark mode they take the footer
// band's colors (mixins/_dark_band.scss), the site's one dark surface.
// No toolbar, script or sign-in link is ever on these pages.

import gate from "../../../data/gate.json" with { type: "json" };
import { company } from "./company.mjs";
import { bold, regular } from "./gate-fonts.mjs";
import { mark, wordmark } from "./gate-logo.mjs";

const LINK_MINUTES = gate.linkMinutes;

const escape = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

// The words on the pages are James's (#294).
export const COPY = {
  heading: "Staging",
  production: `Production: ${gate.production.label}`,
  ask: "Enter your email address. If you're allowed to access the site, " +
    "you'll receive a link. Click it to sign in.",
  sent: "Use the link to sign in. The link is single use and expires " +
    `after ${LINK_MINUTES} minutes.`,
  again: "Use a different address",
  invalid: "That link has expired or was already used. Try again.",
  send: "Send the link",
  label: "Email address",
};

const face = (weight, data) => `
  @font-face {
    font-family: Aller; font-style: normal; font-weight: ${weight};
    src: url(data:font/woff2;base64,${data}) format("woff2");
  }`;

const STYLE = `${face(400, regular)}${face(700, bold)}
  :root {
    color-scheme: light dark;
    --bg: #fff;
    --text: #161a1e;
    --heading: #161a1e;
    --muted: rgba(22, 26, 30, .75);
    --link: #186243;
    --no: #5e0404;
    --field-bg: #fff;
    --field-text: #161a1e;
    --field-border: #bababa;
    --field-focus-border: #8cb1a1;
    --field-focus-ring: 0 0 0 .25rem rgba(24, 98, 67, .25);
    --btn-color: #fff;
    --btn-bg: #186243;
    --btn-border: #186243;
    --btn-hover-bg: #15573b;
    --btn-hover-border: #15573b;
    --btn-active-bg: #134f36;
    --btn-active-border: #124a32;
    --btn-focus-ring: 0 0 0 .25rem rgba(59, 122, 95, .5);
    --link-focus: #186243;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1217;
      --text: #c9cfcc;
      --heading: #f1f3f2;
      --muted: #c9cfcc;
      --link: #f1f3f2;
      --no: #f2a3a0;
      --field-bg: #2c302e;
      --field-text: #f1f3f2;
      --field-border: #757c78;
      --field-focus-border: #9fd1b0;
      --field-focus-ring: 0 0 0 2px #0f1217, 0 0 0 5px #9fd1b0;
      --btn-color: #27553b;
      --btn-bg: #fff;
      --btn-border: #fff;
      --btn-hover-bg: #e3e9e6;
      --btn-hover-border: #e3e9e6;
      --btn-active-bg: #e3e9e6;
      --btn-active-border: #e3e9e6;
      --btn-focus-ring: 0 0 0 2px #0f1217, 0 0 0 5px #9fd1b0;
      --link-focus: #9fd1b0;
    }
  }
  *, *::before, *::after { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    display: flex; flex-direction: column; min-height: 100vh;
    min-height: 100dvh; margin: 0;
    font-family: Aller, system-ui, -apple-system, "Segoe UI", Roboto,
      "Helvetica Neue", "Noto Sans", "Liberation Sans", Arial, sans-serif;
    font-size: 1rem; line-height: 1.63; color: var(--text);
    background: var(--bg);
  }
  .site-header { background: #fff; }
  .site-row {
    display: flex; align-items: center; justify-content: center;
    min-height: 3.5rem; padding: 0 16px;
  }
  .site-brand {
    display: flex; align-items: center; gap: .625rem; border-radius: 4px;
  }
  .site-brand svg { display: block; flex: none; width: auto; }
  .site-brand .black { fill: #186243; transition: opacity .07s ease; }
  .site-brand:hover .black { opacity: .75; }
  .site-mark svg { height: 2.5rem; }
  .site-wordmark { display: none; }
  .site-wordmark svg { height: 1rem; }
  .site-stripe { height: 4px; background: #186243; }
  @media (min-width: 576px) { .site-wordmark { display: block; } }
  @media (min-width: 768px) { .site-row { min-height: 3.75rem; } }
  @media (min-width: 992px) {
    .site-row { min-height: 4rem; }
    .site-brand { gap: .75rem; }
    .site-mark svg { height: 3rem; }
    .site-wordmark svg { height: 1.25rem; }
  }
  main {
    display: flex; flex: 1; align-items: center; justify-content: center;
    padding: 2.5rem 16px 4rem;
  }
  .gate { width: 100%; max-width: 26rem; }
  h1 {
    margin: 0; font-size: 1.6rem; font-weight: 700; line-height: 1.2;
    color: var(--heading);
  }
  .production { margin: .25rem 0 1.25rem; font-size: .875rem; }
  .production a { color: var(--muted); text-underline-offset: .18em; }
  .production a:hover { color: var(--link); }
  p { margin: 0 0 1rem; }
  .no { margin: 0 0 1rem; font-size: .875rem; color: var(--no); }
  label { display: inline-block; margin-bottom: .5rem; }
  input[type=email] {
    display: block; width: 100%; padding: .4rem .75rem; font: inherit;
    font-size: 1rem; line-height: 1.63; color: var(--field-text);
    background: var(--field-bg); border: 1px solid var(--field-border);
    border-radius: 4px; appearance: none;
    transition: border-color .15s ease-in-out, box-shadow .15s ease-in-out;
  }
  input[type=email]:focus {
    border-color: var(--field-focus-border); outline: 0;
    box-shadow: var(--field-focus-ring);
  }
  .btn {
    display: inline-block; margin-top: 1rem; padding: .4rem .75rem;
    font-family: Aller, sans-serif; font-size: 1rem; font-weight: 700;
    line-height: 1.63; letter-spacing: -.01em; color: var(--btn-color);
    text-align: center; text-decoration: none; vertical-align: middle;
    cursor: pointer; user-select: none; background: var(--btn-bg);
    border: 1px solid var(--btn-border); border-radius: 4px;
    transition: color .16s ease-out, background-color .16s ease-out,
      border-color .16s ease-out, box-shadow .16s ease-out,
      transform .16s ease-out;
  }
  .btn:focus-visible {
    color: var(--btn-color); background: var(--btn-hover-bg);
    border-color: var(--btn-hover-border); outline: 0;
    box-shadow: var(--btn-focus-ring);
  }
  .btn:not(.btn-link):hover {
    color: var(--btn-color); background: var(--btn-hover-bg);
    border-color: var(--btn-hover-border); transform: translateY(-2px);
    box-shadow: 0 8px 18px -8px rgba(7, 6, 6, .38);
  }
  .btn:not(.btn-link):active {
    color: var(--btn-color); background: var(--btn-active-bg);
    border-color: var(--btn-active-border); transform: translateY(-1px);
    box-shadow: 0 4px 8px -5px rgba(7, 6, 6, .34);
  }
  .btn:not(.btn-link):active:focus-visible {
    box-shadow: var(--btn-focus-ring);
  }
  a:not(.btn):focus-visible {
    border-radius: .125rem; outline: 2px solid var(--link-focus);
    outline-offset: 3px;
  }
  .site-brand:focus-visible { outline-offset: 4px; }
  .hp { position: absolute; left: -10000px; }
  @media (prefers-reduced-motion: reduce) {
    .btn, .btn:hover, .btn:active { transform: none !important; }
    .btn, input[type=email], .site-brand .black { transition: none; }
  }
`;

const header = `<header class="site-header">
<div class="site-row">
<a class="site-brand" href="/" aria-label="${escape(company.name)}, home">
<span class="site-mark" aria-hidden="true">${mark}</span>
<span class="site-wordmark" aria-hidden="true">${wordmark}</span>
</a>
</div>
<div class="site-stripe"></div>
</header>`;

const shell = (title, body) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escape(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${header}
<main>
<div class="gate">
<h1>${COPY.heading}</h1>
<p class="production"><a href="${escape(gate.production.url)}">${
  escape(COPY.production)}</a></p>
${body}
</div>
</main>
</body>
</html>
`;

// `message` is one line of ours (never a visitor's text). It is said
// at once (role="alert") and tied to the field it is about, and the
// field takes focus so trying again starts there.
export const signInPage = ({ next = "/", message = "" } = {}) => shell(
  "Staging sign-in",
  `<p>${escape(COPY.ask)}</p>
${message
    ? `<p class="no" id="gate-message" role="alert">${escape(message)}</p>`
    : ""}
<form method="post" action="/api/gate/request">
  <label for="email">${COPY.label}</label>
  <input id="email" name="email" type="email" inputmode="email"
    autocomplete="email" autocapitalize="off" spellcheck="false" required${
  message ? ` aria-describedby="gate-message" autofocus` : ""}>
  <input class="hp" name="website" tabindex="-1" autocomplete="off"
    aria-hidden="true">
  <input type="hidden" name="next" value="${escape(next)}">
  <button class="btn" type="submit">${COPY.send}</button>
</form>`
);

// The same page for every address, on the list or not.
export const checkEmailPage = () => shell(
  "Use the link to sign in",
  `<p>${escape(COPY.sent)}</p>
<a class="btn" href="/api/gate/signin">${COPY.again}</a>`
);

// The sign-in page for a link that was spent or ran out.
export const invalidLinkPage = () => signInPage({ message: COPY.invalid });

// What a script or a pinger gets in place of the page.
export const blockedText = "Sign in required.\n";
