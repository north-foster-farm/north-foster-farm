# Splitting `staging/library.js`

The seventh and last design under #782 (quality gates in the
build), read from `next` at `81cfbc49`. The rules common to every
phase are in [order-form.md](order-form.md#3-the-phases).

`assets/scripts/staging/library.js` is the email library in the
staging toolbar: every email the site sends, listed and searchable,
with James's Approve and Rewrite on each. It is 635 lines, 489 of
them code, and 466 of those are one function. `mountLibrary` is a
closure of some thirty inner functions around eight variables and
about forty elements. One unit test covers one function, `tally`.
No e2e spec opens the library at all.

No customer ever sees it. It runs on the staging deploy alone, for
whoever has passed the gate, and the review buttons are James's.
That lowers the stakes of a slip and raises the cost of finding
one: a break here is found by James, mid-review.

## 1. The file today

### What it does

**The shelf.** `haystack`, `matches`, `badge`, `drawShelf`,
`drawSent`, `drawSummary`, `load`, and the exported `tally`. The
emails by audience, filtered by the search's words and an approval
filter. Under them, for James alone, every email the deploy has
sent.
Unit: `staging-ui.test.mjs` (`tally`).

**Text with tokens.** `token`, `fill`, `partsOf`, `tokensOf`,
`outOfToken`. An email's subject and text are lists of parts, plain
text and sample values. A sample value shows as a token that can be
moved or deleted and not edited.

**The reader.** `read`, `drawReader`, `drawView`, `drawReview`,
`saved`, and the module's `framed` and `day`. The chosen email as
HTML in a frame, as plain text, or as James's rewrite.

**Review.** `send`, the Approve, Withdraw and Drop buttons,
`openEditor`, `closeEditor`, `noteDropped`, and the editor's
submit and Cancel.
Unit: `staging.test.mjs` and `staging-sessions.test.mjs` cover the
server's side (`lib/review.mjs`).

**Opening and closing.** `open`, `close`, `fromHash`, Escape, the
`hashchange` listener, the back button, Copy link.

### State

Eight variables in the closure: `emails`, `sent`, `current` (the
open email), `view` (`html`, `text` or `rewrite`), `approval` (the
filter), `loading` (the one request for the list), `editing`, and
`opener` (what had the focus before the library opened).

### DOM

All inside the toolbar (`layouts/partials/staging-toolbar.html`),
found by `data-staging-*`: the box, the shelf and its empty line,
the search, the filters, the summary and the count, the reader with
its name, when, subject, approval, note and attachments, the frame,
the text view, the rewrite view, the view buttons, the review bar
with its four buttons, its status and its error, the editor with
its two editable fields, and two templates
(`[data-staging-item]`, `[data-staging-token]`).

Outside the toolbar it sets the class `staging-library-open` on the
root element.

### Events, timers, requests

Listens: `click` on the shelf, the filters, the view buttons, the
review buttons, Back, Copy link and Close; `input` on the search
and the editor; `keydown` in the subject (Enter does nothing) and
on the document (Escape); `submit` on the editor; `selectionchange`
on the document; `hashchange` on the window.

It dispatches nothing. It uses two of the browser's own dialogs:
`confirm` before a rewrite is dropped, and `prompt` to show a link
the clipboard refused.

Timer: "Copied" for 1,200 ms.

Requests, all through the `api` it is given:
`GET /api/staging/emails`, `GET /api/staging/sent`,
`GET /api/staging/emails/<id>` (with `?format=text` for the text),
`PUT` and `DELETE /api/staging/emails/<id>/approval`,
`PUT` and `DELETE /api/staging/emails/<id>/rewrite`. A sent email
opens `/api/staging/outbox/<id>` in a new tab.

It rewrites the URL's hash: `#email=<id>` for an open email,
`#emails` for the shelf, nothing once closed.

### Imports and importers

It imports `utils/busy-button.js`.

`staging/main.js` is the one importer of `mountLibrary`. It passes
the root, the `api`, `onOpen`, and two permissions, `canReview` and
`canSeeSent`, and uses the two functions that come back,
`fromHash` and `counted`. `test/staging-ui.test.mjs` imports
`tally`.

## 2. The target

`library.js` stays, exporting `mountLibrary` and `tally` as now, so
neither `staging/main.js` nor the test changes. The work moves into
`assets/scripts/staging/library/`.

### Modules

Sizes are code lines, estimated.

Pure:

```
library/search.mjs   wordsOf, haystack, matches, sentMatches,
                     grouped, tally, summaryLine                   70
library/parts.mjs    ANCHOR, partsOf, tokensOf, leftOut, oneLine,
                     rewriteParts                                  70
library/review.mjs   buttonsFor, statusLine, viewFor, emailPath,
                     reviewPath, linkTo, hashTarget, framed        80
library/state.mjs    initial, loaded, opened, saved                40
```

Dumb:

```
library/elements.js     elementsOf(root)                           45
library/shelf-view.js   drawShelf, drawSent, drawSummary, badge   100
library/tokens.js       token, fill, keepCaretOut                  60
library/reader-view.js  drawHead, drawFiles, drawReview,
                        drawPanes                                 100
```

Smart:

```
library/shelf.js    Shelf: load, the search, the filters, a tag    80
library/reader.js   Reader: read, the views, Back, Copy link      100
library/review.js   Review: approve, withdraw, drop, send          60
library/editor.js   Editor: open, close, the left-out line,
                    save, cancel                                   90
library.js          mountLibrary: open, close, the hash, Escape    90
```

Twelve new modules and about 1,000 lines for today's 489.

`partsOf` reads only `childNodes`, `nodeType`, `nodeName`, `data`
and `dataset` of what it is given. Written against those five
fields, with no browser global, it is pure: a unit test hands it
plain objects.

### How state moves

```
#emails, #email=<id>, the toolbar's button
  -> library.js   open(id)
       shelf.load()        state = loaded(state, emails, sent)
       reader.read(id)     state = opened(state, id)

the search, a filter, a tag
  -> shelf.js     drawShelf(grouped(state.emails, filter))

Approve, Withdraw, Drop, Save
  -> review.js / editor.js   api(reviewPath(id, kind), ...)
       state = saved(state, answer.email)
       drawSummary, drawShelf, drawReader
```

- **One record:** `emails`, `sent`, `current`, `view`, `approval`,
  `editing`. `mountLibrary` holds it and hands each part a getter
  and a setter. A setter draws nothing, and the part that changed
  the record redraws what it changed, as now.
- **`loading` stays in `Shelf`,** and `opener` in the root.
- **The permissions are asked each time,** as now: `canReview()`
  and `canSeeSent()` are functions, since the toolbar learns them
  after it mounts.

### What stays as it is

`mountLibrary`'s options and what it returns; `tally` as an export
of `library.js`; `staging/main.js`; the server's review API. No new
package.

## 3. The phases

The rules are those of
[order-form.md](order-form.md#3-the-phases), with two differences.

`assets/scripts/staging/**` is shared in `e2e/dispatch.json`, since
the toolbar's script loads on every page of the staging deploy. So
`bin/nff e2e` selects every spec for any change here. The run after
each phase is the whole suite, under the one-an-hour cap.

That run proves little about the library, which only
`e2e-staging.yml` can reach, on the staging deploy. So the unit
tests carry this series, and James's own look on staging closes it
(section 5).

### Phase 0: pin the library on staging

Tests only, from the test agent: one spec, in the staging run and
in `e2e/dispatch.json`. It needs a gate session, which the staging
run has. The review steps need a session that may review, which is
James's alone. Where the run cannot have one, criteria 6 to 8 are
left to the unit tests of phases 2 and 4.

1. `#emails` on any page opens the library with the search focused
   and the emails listed by audience, each group with its count.
2. Words typed in the search narrow the list to emails that hold
   every word, in the name, subject, text or tags.
3. A tag pressed becomes the search. An approval filter narrows the
   list to that approval.
4. A row opens its email, sets `#email=<id>`, and shows the HTML.
   Text shows the plain text.
5. Escape closes the library, clears the hash, and puts the focus
   back where it was.
6. Approve marks the email approved everywhere it shows, with no
   reload.
7. Rewrite opens the subject and text with the sample values as
   tokens. Deleting one names it under "Left out".
8. Saving shows the rewrite, and Drop, once confirmed, brings the
   current wording back.

### Phase 1: the search and the tally

Moves `haystack`, `matches`, the word-splitting, the grouping and
`tally` to `library/search.mjs`; `drawShelf`, `drawSent`,
`drawSummary` and `badge` to `library/shelf-view.js`; the element
lookups to `library/elements.js`. `library.js` re-exports `tally`.

Criteria (`search.mjs`):

1. `wordsOf` lower-cases the query and splits it on spaces, with no
   empty word.
2. `matches` is true when every word is in the email's id, name,
   when, subject, text, approval, approval label, audience or tags.
3. With an approval filter set it is also false for any other
   approval.
4. `sentMatches` looks in a sent email's subject and addresses.
5. `grouped` gives the three audiences in order, each with its
   matching emails, and leaves out an audience with none.
6. The sent group is left out with an approval filter set, and for
   a session that may not see sent mail.
7. `summaryLine` counts the emails and those to approve, and those
   rewritten only when there are some.

Stay green: `staging-ui.test.mjs`.
e2e: `staging-toolbar`, and phase 0's spec.

### Phase 2: parts and tokens

Moves `partsOf`, `tokensOf` and the left-out sum to
`library/parts.mjs`; `token`, `fill` and `outOfToken` to
`library/tokens.js`.

Criteria (`parts.mjs`):

1. `partsOf` joins neighboring text into one part and keeps each
   token as its own.
2. It drops the anchors around tokens.
3. A `BR` is a newline, and a `DIV` or `P` after the first part
   starts a new line.
4. It leaves out a text part that ends up empty.
5. `tokensOf` lists the tokens in order.
6. `leftOut` lists each token the original has and the rewrite
   lacks, once.
7. `oneLine` turns a newline in the subject, with the space around
   it, into one space, and leaves tokens alone.
8. `rewriteParts` is "Subject: ", the subject's parts, a blank
   line, and the text's parts.

e2e: phase 0's spec.

### Phase 3: the reader

Moves `read`, `drawReader`, `drawView`, Back and Copy link to
`library/reader.js` and `library/reader-view.js`; the paths, the
link and `framed` to `library/review.mjs`; the record to
`library/state.mjs`.

Criteria (`review.mjs`, `state.mjs`):

1. `viewFor` keeps the chosen view, and falls back to HTML when the
   rewrite view is chosen for an email with no rewrite.
2. `emailPath` is the email's path, with `?format=text` for the
   text view, the id encoded.
3. `linkTo` is the site's origin and `/#email=` with the id
   encoded.
4. `framed` adds a base target of a new tab to the email's head.
5. `hashTarget` opens an email for `#email=<id>`, the shelf for
   `#emails`, and nothing for any other hash.
6. `opened` sets the current email by id, or none for an id the
   list lacks, and chooses the rewrite view for a rewritten email.
7. `saved` replaces the email with the same id in the list and as
   the current one.

e2e: phase 0's spec.

### Phase 4: review and the editor

Moves `send`, the three review buttons and `drawReview` to
`library/review.js`; `openEditor`, `closeEditor`, `noteDropped`,
the submit and Cancel to `library/editor.js`.

Criteria (`review.mjs`):

1. `buttonsFor` hides the bar from a session that may not review,
   for an email the code approved, and for one that failed to
   build.
2. It offers Approve only for an email to approve, Rewrite for one
   to approve or rewritten, Withdraw for one James approved, and
   Drop for a rewritten one.
3. It hides all four while the editor is open.
4. Rewrite reads "Edit the rewrite" for a rewritten email.
5. `statusLine` says when James approved or rewrote it, and nothing
   otherwise.
6. `reviewPath` is the email's path and the kind, the id encoded.

e2e: phase 0's spec.

### Phase 5: the root

`library.js` is `mountLibrary` with `open`, `close`, the hash and
Escape, within the limits, and comes off the legacy lists of #782
(quality gates in the build).

No criteria tests.
e2e: the whole suite, and phase 0's spec on staging.

## 4. What must not change

- **`mountLibrary`'s options and its two returned functions,** and
  `tally` exported from `library.js`.
- **The links:** `#emails` and `#email=<id>`, which are handed to
  James in pull requests and comments.
- **The requests:** paths, methods and bodies, the `version` sent
  with an approval and a rewrite above all. The server refuses a
  stale one.
- **Tokens cannot be edited.** The editor is `plaintext-only` where
  the browser has it and plain `contentEditable` otherwise. The
  anchors keep the caret out of a token. Enter does nothing in the
  subject.
- **Who sees what:** the review bar for a session that may review,
  the sent mail for one that may see it, asked at the moment of
  drawing.
- **Focus:** into the search or the reader on open, back to the
  opener on close.
- **An email's HTML goes into the frame and nowhere else.** Every
  other value is written as text.
- **The two dialogs,** and their words.

## 5. Where the stall valve is needed, and what needs James

- **`library.js`, phases 1 to 4:** one entry on #791 (the rule
  exceptions log) for the series.
- **James's look on staging,** once, after phase 5 reaches it:
  open an email from a link, approve one, rewrite one and drop the
  rewrite. Nothing else can prove the review path with his session.
  It is asked for on that pull request, as numbered steps.
- **Nothing else.** `staging/main.js` is not edited.

## 6. Found while reading

None of these is fixed inside a move.

- No spec opens the library, and its one unit test covers `tally`.
- `drawShelf` and `drawSent` each split the search into words.
- The `selectionchange` listener runs for the life of the page,
  library open or shut. It returns at once unless the editor is
  open.
- `LABELS` holds one entry.
