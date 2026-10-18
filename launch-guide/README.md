# Launch guide data

James follows a local page, `launch-guide.html`, from now until after launch. On load it fetches `launch-guide/guide.json` from this branch (raw.githubusercontent.com). If the file's `revision` is higher than the copy built into the page, the page switches to it. Everything James types is saved in his browser only.

**Agents change data only.** Add, update and remove entries in `guide.json` (steps, review items, revisions, tags), and nothing else. Never edit `launch-guide.html` here or the copy on James's Mac: the page is built from a source the voice assistant keeps, and a hand edit would be overwritten without anyone noticing. If the page itself needs a change, ask on #267.

**This branch never holds values.** No secrets, no customer or personal data: only steps, review items and variable names. It is not merged anywhere.

## When you change something James reviews

Find the item in `reviews` (by `id`) and **append** a revision. Never edit or remove earlier revisions; the page shows them as history, beside James's feedback on each.

```json
{
  "rev": 2,
  "date": "2026-10-17",
  "changed": "What changed and why, in one or two sentences, answering his feedback.",
  "summary": "What to look at now (Markdown subset: **bold**, `code`, [links](https://...), lists).",
  "look": [{ "label": "Order page on staging", "url": "https://staging--north-foster-farm.netlify.app/order/" }],
  "text": "Verbatim copy, if the item is wording.",
  "recommendation": "Optional."
}
```

Then **increase the top-level `revision` by 1** and commit to this branch with a message naming the item: `guide: R-W17 rev 2`. James presses **Check for updates**, or reloads the page.

## Steps and env variables

- **A step that waits on agents** has a `blocked` note. When the work lands, delete the `blocked` key, or reword it.
- **A variable marked `planned`** is left out of the env files. When the code that reads it lands, remove `planned` and use the variable names the code uses.
- **Step, field and review ids are permanent.** James's saved progress is keyed on them, so never rename or reuse one.
- **New review items** go in `reviews`, with `section` set to one of `rv-look`, `rv-copy` or `rv-decide`.
- **Every step and review item carries two tags**, which James filters on (he often has only his phone):
  - `device`: `phone` (best on the iPhone), `any` (phone or laptop) or `laptop` (needs the Mac: Terminal, a secret value, a desktop browser or dev tools, or sending a Resend broadcast).
  - `type`: `look` (look and review), `decide`, `account` (setup in a web console), `terminal` (command line), `live` (live test) or `claude` (tell Claude).
  - Set both on anything you add. When unsure, use `laptop`: hiding a phone-friendly item costs less than sending James to a step he can't finish.

The guide is built from Python sources the voice assistant keeps. Small edits to `guide.json` directly are fine. For larger changes, ask the voice assistant on #244.
