# Duplication ceilings

`npm run lint:copies` runs jscpd once per area, each with its own
config here, and fails when an area's share of duplicated lines rises
above its ceiling (#782, step 8). Each ceiling is the area's figure on
2026-11-22, rounded up to two places, except tests, lowered to its
figure on 2026-11-23 when #908's shared test helpers cut it. A
ceiling only falls: when a change removes duplicates, lower it to the
new figure in the same change.

| Config           | Measured | Ceiling |
| ---------------- | -------- | ------- |
| `source.json`    | 0.767%   | 0.77%   |
| `tests.json`     | 3.740%   | 3.75%   |
| `styles.json`    | 0.790%   | 0.80%   |
| `templates.json` | 1.188%   | 1.19%   |

Source is the JavaScript in assets/scripts, netlify, bin and plugins;
tests, the JavaScript in test and e2e; styles, the SCSS and CSS in
assets/styles; templates, the HTML in layouts.

Paths in a config are relative to this folder. jscpd skips what
`.gitignore` names.

The tests area leaves out `*.criteria.mjs`: criteria tests held out of
runs until their implementation lands. They are verbatim moves of a
running test's helpers, so they duplicate it by design, and each is
renamed to `.test.mjs`, and counted, when it runs.

`test/quality-ceilings.test.mjs` checks the gate with two tests (#991).
The first holds that the gate works: in every area, a seed sized to
the gap between the measured figure and the ceiling always fails
jscpd, however many clean lines the area has gained. The second holds
that the ceiling stays honest: no ceiling sits more than 0.5 of a
point above its area's measured figure. When the second fails, a test
agent lowers that ceiling to the figure rounded up to two places, in a
pull request of its own or in the one that tripped it.

Both seed files and run every area several times, so they run as
`npm run test:analysis`, the last step of `npm run lint` (CI's Lint
step), with `test/quality-analysis.test.mjs`, and not in the pre-commit
hook, which runs `lint:code` and so still enforces the ceilings.
