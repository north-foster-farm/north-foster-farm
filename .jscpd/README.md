# Duplication ceilings

`npm run lint:copies` runs jscpd once per area, each with its own
config here, and fails when an area's share of duplicated lines rises
above its ceiling (#782, step 8). Each ceiling is the area's figure on
2026-11-22, rounded up to two places. A ceiling only falls: when a
change removes duplicates, lower it to the new figure in the same
change.

| Config           | Measured | Ceiling |
| ---------------- | -------- | ------- |
| `source.json`    | 0.767%   | 0.77%   |
| `tests.json`     | 3.846%   | 3.85%   |
| `styles.json`    | 0.790%   | 0.80%   |
| `templates.json` | 1.357%   | 1.36%   |

Source is the JavaScript in assets/scripts, netlify, bin and plugins;
tests, the JavaScript in test and e2e; styles, the SCSS and CSS in
assets/styles; templates, the HTML in layouts.

Paths in a config are relative to this folder. jscpd skips what
`.gitignore` names.

The tests area leaves out `*.criteria.mjs`: criteria tests held out of
runs until their implementation lands. They are verbatim moves of a
running test's helpers, so they duplicate it by design, and each is
renamed to `.test.mjs`, and counted, when it runs.

`test/quality-analysis.test.mjs` checks the gate. It seeds files and
runs every area several times, so it runs as `npm run test:analysis`,
the last step of `npm run lint` (CI's Lint step), and not in the
pre-commit hook, which runs `lint:code` and so still enforces the
ceilings.
