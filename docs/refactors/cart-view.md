# Splitting `cart/view.mjs`

The third design under #782 (quality gates in the build), read from
`next` at `32ab0944`. The rules common to every phase are in
[order-form.md](order-form.md#3-the-phases). What the view is for,
and why each of its rules exists, is in `docs/cart.md` 4.1 to 4.8.
This document changes none of that.

`assets/scripts/order/cart/view.mjs` is 1,188 lines, 750 of them
code: 36 exported names and no class. It is everything about the
cart that touches the viewport, the clock or the pane's own motion.
Nine functions run past 25 lines, and one, `moveParts`, is 97 lines
long. Unlike the other big files it is already a set of separate
functions with one caller, so the work is a split by concern and the
decomposition of those nine. It is also the code that has
regressed most often (`docs/cart.md` 1), which sets the order: the
safest moves first, `moveParts` alone and late.

## 1. The file today

### What it does

**Queries and units.** `COLUMN`, `SHORT`, `SHEET`, `toPx`, `restOf`,
and the private `reduced`, `rootFont`, `prop`, `setProp`.
Unit: `cart-view.test.mjs` (`toPx`, `restOf`).

**The keyboard.** `watchKeyboard`. One `visualViewport` listener
writes `--cart-kb`, `--cart-gap` and, while the keyboard is up,
`--cart-vis`; sets `data-keyboard`; brings the code field into view
once; tells the caller the inset.
Unit: `cart-keyboard-field.test.mjs`, `cart-scroll.test.mjs`
(`keyboardInset`, `visibleArea`).
e2e: `cart-keyboard`.

**Placement.** `watchPlacement`. On each frame the page moves it
writes `--cart-bar` and hands the caller the facts `state.mjs`
decides placement from.
Unit: `cart-state.test.mjs` (the decision).
e2e: `cart-float`, `cart-fold`, `order-topbar-scroll`.

**Whose scroll it is.** `OWN_MS`, `ownScroll`, `watchScroll`.
Unit: `cart-view.test.mjs` (`ownScroll`).
e2e: `cart-motion`, `cart-tip`.

**The panel's fold.** `animateFold`: the tablet's panel and the
column ease the pane's height.
e2e: `cart-fold`, `cart-float`.

**The sheet's motion.** `moveParts`, with `moveFrames`,
`fadeFrames`, `paneFrames`, `liftShift`, `pillFadeFrames`, `moves`,
`moving`, `MOVE_MS`, `MOVE_ID`, `FADE_IN`, `FADE_OUT`, and the
private `movers`, `sizeOf`, `chromeOf`, `pillOf`, `movePill`,
`outerHeight`.
Unit: `cart-view.test.mjs` (every pure one).
e2e: `cart-motion`, `cart-lines`, `cart-one`, `cart-float`.

**Words that change with a move.** `WORD_FRAMES`, `wordsAt`,
`swapWords`, `wordsOf`.
Unit: `cart-view.test.mjs`. e2e: `cart-motion`.

**The shared row.** `shutShare`.
Unit: `cart-code.test.mjs`. e2e: `cart-way`.

**The list.** `moreShown`, `watchList`, `revealLine`: the "more"
arrows, the edge fades, the glide to a hidden row.
Unit: `cart-view.test.mjs` (`moreShown`), `cart-scroll.test.mjs`
(`moreStop`).
e2e: `cart-lines`, `cart-motion`, `cart-a11y`.

**Cues.** `pulsePill`, `ringCart`, `showAdded`.
e2e: `cart-fold`, `cart-motion`, `order-page` (the ring).

**The first Add's lesson.** `teach`.
Unit: `cart-touch.test.mjs` (`strayed`, `touchKind`).
e2e: `cart-fold`.

**Focus kept clear of the pane.** `clearFocusUnder`.
Unit: `cart-scroll.test.mjs` (`clearBy`).
e2e: `cart-a11y`, `keyboard`, `checkout-go`.

### State

The module keeps none of its own. Each watcher holds its state in a
closure (the last inset, the measured heights, the last input's
time, the glide's frame, the lesson's touch). The rest is written
onto the elements themselves, as properties the next call reads:

- on the pane: `keyboardTick`, `currentEase`, `moveDone`,
  `ringTimer`, and `eases`, a count the specs read;
- on a control: `wantWords`, `wordEase`, `pulseTimer`;
- on a part: `shutting`; on the strip: `addedTimer`.

### DOM

It is handed every element it works on (the pane, the slot, the
list and its wrap, the pill, the strip) and finds a few inside them:
`[data-cart-anchor]`, `[data-cart-body]`, `[data-part='foot']`,
`[data-cart-scroll]`, `[data-cart-clear]`, `[data-cart-added]`,
`.order-cart-item`, `.order-cart-toggle`, `.order-cart-next`,
`[data-field='code']`, and by default `.order-topbar`.

It writes the custom properties `--cart-kb`, `--cart-gap`,
`--cart-vis` and `--cart-bar`, and reads `--cart-closed-h`. It sets
`data-keyboard`, `data-pulse`, `data-show`, `data-scroll`,
`data-top`, `data-more`, and the classes `is-ringed` and
`is-shutting`. During a move it sets and then removes inline
`display`, `overflow`, `flex`, `height`, `max-height`, `transform`
and `right`. It reads `data-placement` and `data-fold`, which
`cart.js` writes.

### Events and timers

Listens, always through a function that returns its own disposer:

- `visualViewport` and `window`: `resize`;
- `window`: `scroll` (passive);
- `document`, captured: `touchstart`, `touchmove`, `touchend`,
  `touchcancel`, `wheel`, `keydown`, `scroll`; and `focusin`;
- the pane: `transitionend`, the four pointer events;
- the list: `scroll`, and `touchstart` and `wheel` once per glide;
- two `ResizeObserver`s (the list, the document) and two
  `matchMedia` queries.

It dispatches nothing. Its animations all carry the id `cart-move`.

Clocks: 420 ms for a move and a fold; `OWN_MS` 150; the pulses 4,400,
520 and 2,600 ms; the ring 1,600; the "Added" strip 2,600; a glide of
160 to 420 ms; `SHIFT_MS` 1,000 and `TAB_MS` 100 for the focus watch.

### Imports and importers

It imports `lib/cart-scroll.mjs` and `lib/cart-touch.mjs`.

`cart/cart.js` is its one caller and imports 18 names. Three unit
tests import it: `cart-view.test.mjs`, `cart-code.test.mjs`,
`cart-keyboard-field.test.mjs`. Two e2e helpers lean on what it
leaves behind: `e2e/support/order.mjs` waits for animations with the
id `cart-move`, and `cart-float` and `cart-motion` read `pane.eases`.

## 2. The target

`view.mjs` stays, as the one door: a list of re-exports and nothing
else. `cart.js` and the three tests go on importing from it, so
neither `cart.js` nor a test's expectations change. The parts move
into `assets/scripts/order/cart/view/`.

Nothing here is smart. The view decides nothing about the cart: it
measures, tells the caller, and animates what the caller applied.
So the kinds are two: pure, and the DOM modules, each a watcher (it
listens and returns a disposer), a motion (it animates and returns a
promise) or a cue (it sets a mark and a timer).

### Modules

Sizes are code lines, estimated.

Pure:

```
view/queries.mjs     COLUMN, SHORT, SHEET                          6
view/units.mjs       toPx, restOf                                 15
view/frames.mjs      MOVE_MS, MOVE_EASE, MOVE_ID, FADE_IN,
                     FADE_OUT, moveFrames, fadeFrames,
                     paneFrames, liftShift, pillFadeFrames,
                     moves, WORD_FRAMES, wordsAt                 110
view/own-scroll.mjs  OWN_MS, ownScroll, scrollKey                 25
view/more.mjs        moreShown, glideSpan, glideAt                20
view/plan.mjs        movePlan, pillMoves, lifting, holds,
                     closedHeight, focusRoom                      60
```

DOM:

```
view/style.js        reduced, rootFont, prop, setProp             20
view/keyboard.js     watchKeyboard                    watcher     60
view/placement.js    watchPlacement                   watcher     95
view/scroll.js       watchScroll                      watcher     70
view/fold.js         animateFold                      motion      35
view/measure.js      movers, sizeOf, chromeOf, pillOf,
                     outerHeight                                  60
view/pill.js         movePill                         motion      35
view/words.js        swapWords, wordsOf               motion      45
view/move.js         moveParts, moving                motion     150
view/share.js        shutShare                        motion      25
view/list.js         watchList, revealLine            watcher     95
view/cues.js         pulsePill, ringCart, showAdded   cue         40
view/teach.js        teach                            watcher     70
view/focus.js        clearFocusUnder                  watcher     60
view.mjs             the re-exports                               25
```

Twenty new modules and about 1,100 lines for today's 750.

### How state moves

It does not change. `cart.js` owns the state (`state.mjs`), calls a
watcher once and keeps its disposer, and is called back with facts
(`look`, `onInset`, `onMove`, `onShut`). To change what shows it
calls a motion with an `apply` function, and the motion reads the
DOM before and after `apply` and eases between the two.

Inside `move.js` the one long function becomes five steps in the
same order, each its own function:

```
read     sizes, the pill, the pane's box and chrome, before
take     cancel the running eases, finish the last move
apply    the caller's change
plan     read again; movePlan, liftShift, paneFrames  (pure)
start    hold the parts as they were, start every ease in
         this frame, keep the body at its end
finish   undo the holds when every ease has ended
```

The order of reads and writes in those steps is the design of
`docs/cart.md`. It is kept exactly.

### What stays as it is

`view.mjs`'s 36 exports, by name; `cart.js`; `state.mjs`;
`lib/cart-scroll.mjs` and `lib/cart-touch.mjs`; the properties left
on elements; every clock.

## 3. The phases

The rules are those of
[order-form.md](order-form.md#3-the-phases). `bin/nff e2e` selects
the 95 specs mapped to `assets/scripts/order/**`. The eleven that
pin the cart are `cart-a11y`, `cart-badge`, `cart-float`,
`cart-fold`, `cart-keyboard`, `cart-lines`, `cart-money`,
`cart-motion`, `cart-one`, `cart-tip` and `cart-way`. They are read
first after every phase here.

The 39 tests of `test/cart-view.test.mjs` already pin the pure
functions. They stay green through every phase, unedited. Criteria
are given only for functions the split draws out anew.

### Phase 1: the pure parts

Moves the queries, `toPx`, `restOf`, the keyframe functions and
their constants, `ownScroll`, `moreShown`, `WORD_FRAMES` and
`wordsAt` to `view/queries.mjs`, `view/units.mjs`,
`view/frames.mjs`, `view/own-scroll.mjs` and `view/more.mjs`.
`view.mjs` re-exports them and uses them.

No criteria tests: `cart-view.test.mjs` is the test, through
`view.mjs`.

Stay green: `cart-view.test.mjs`, `cart-code.test.mjs`,
`cart-keyboard-field.test.mjs`.
e2e: the eleven cart specs.

### Phase 2: the watchers of the viewport

Moves `watchKeyboard`, `watchPlacement` and `watchScroll` to
`view/keyboard.js`, `view/placement.js` and `view/scroll.js`, and
`reduced`, `rootFont`, `prop`, `setProp` to `view/style.js`.

Criteria:

1. `closedHeight` is the pane's height as last measured floating and
   closed, and the stylesheet's `--cart-closed-h` in pixels until
   one has been measured.
2. `scrollKey` is true for the arrow keys, Page Up, Page Down, Home,
   End and Space, false in a field that takes text, and false for
   Space on a button or a link.

Stay green: `cart-keyboard-field.test.mjs`, `cart-scroll.test.mjs`,
`cart-state.test.mjs`.
e2e: `cart-keyboard`, `cart-float`, `cart-fold`, `cart-motion`,
`cart-tip`, `order-topbar-scroll`.

### Phase 3: the list, the cues, the lesson, the focus

Moves `watchList` and `revealLine` to `view/list.js`; `pulsePill`,
`ringCart` and `showAdded` to `view/cues.js`; `teach` to
`view/teach.js`; `clearFocusUnder` to `view/focus.js`; `shutShare`
to `view/share.js`; `animateFold` to `view/fold.js`.

Criteria:

1. `glideSpan` is 160 ms plus 0.8 ms for each pixel, and never over
   420.
2. `glideAt` is the start at 0, the end at 1, and eases out between
   them on a cubic curve.
3. `focusRoom` gives the pane's top as the floor while the floating
   pane covers the foot, and the screen's foot otherwise, with the
   top bar's foot as the ceiling.

Stay green: `cart-code.test.mjs`, `cart-touch.test.mjs`,
`cart-scroll.test.mjs`.
e2e: `cart-lines`, `cart-a11y`, `cart-fold`, `cart-way`,
`cart-motion`, `keyboard`, `checkout-go`, `order-page`.

### Phase 4: the sheet's motion

Moves `movers`, `sizeOf`, `chromeOf`, `pillOf` and `outerHeight` to
`view/measure.js`; `movePill` to `view/pill.js`; `swapWords` and
`wordsOf` to `view/words.js`; `moveParts` and `moving` to
`view/move.js`, as the five steps above. Alone in its phase, since
it is the function with the most history.

Criteria (`plan.mjs`):

1. `movePlan` keeps the parts that are still in the page and whose
   size changes by half a pixel or more, and drops the rest.
2. Each kept part holds its inner scroller at the larger of its two
   heights.
3. `pillMoves` is true when Clear cart comes or goes, and when it
   stays but its place changes.
4. `lifting` is true only for a pane that floats after the change
   and did not before.
5. `holds` is false under the keyboard, false once the body has been
   scrolled from where the hold left it and is not at its end, and
   true otherwise.

Stay green: `cart-view.test.mjs`.
e2e: `cart-motion`, `cart-lines`, `cart-one`, `cart-float`,
`cart-fold`, `cart-keyboard`.

### Phase 5: the door

`view.mjs` is the re-exports alone, and comes off the legacy lists
of #782 (quality gates in the build).

No criteria tests.
e2e: the eleven cart specs.

## 4. What must not change

- **The 36 exports of `view.mjs`,** by name and behavior.
- **What the specs read:** the animation id `cart-move`, the count
  `pane.eases`, the attributes `data-pulse`, `data-show`,
  `data-scroll`, `data-top`, `data-more`, the classes `is-ringed`
  and `is-shutting`.
- **What the stylesheet reads:** `--cart-kb`, `--cart-gap`,
  `--cart-vis` (set only while the keyboard is up), `--cart-bar`,
  `data-keyboard` (held for two frames after the keyboard goes).
- **The properties on elements.** They are how a newer call finds
  an older one's work: `moveDone`, `currentEase`, `wordEase`,
  `wantWords`, `shutting`, and the timers.
- **One frame, one order.** In `moveParts`: sizes read before the
  old eases are canceled, `apply` after, sizes read again, the cap
  lifted before the second read on a lift-off, every ease started in
  the same frame on one timing object.
- **No layout written back.** The view writes no height, floor or
  cap for the stylesheet to read (`docs/cart.md` 4.1).
- **Every clock,** and `behavior: "instant"` on the focus scroll.
- **Listener options:** captured and passive where they are now.
  A passive listener made active, or a capture dropped, changes what
  counts as the person's own scroll.
- **Reduced motion:** each motion applies the change and resolves at
  once.

The risk is `moveParts`. Its unit tests cover the keyframes, and
the frame-by-frame behavior is covered only by `cart-motion`, which
runs in Actions. Phase 4 is therefore one function's worth of
change, with nothing else in the commit.

## 5. Where the stall valve is needed

- **`view.mjs`, phases 1 to 4.** Edited while still over the
  limits: one entry on #791 (the rule exceptions log) for the
  series, as ruled for `order-form.js`.
- **`moveParts`' five steps.** Each is meant to fit 25 lines. If
  `start` cannot (it sets the holds, starts the eases and begins the
  body's hold in one frame), splitting it further would separate
  writes that belong to one frame. That one function is the likely
  exception, logged on #791 with a comment naming the rule.
- **`cart.js` is not edited** in this series, by design.

## 6. Found while reading

None of these is fixed inside a move.

- `toPx` has two branches, for `rem` and for `em`, that do the same
  thing. An `em` is read as a `rem`.
- `animateFold` and `watchList` write 420 ms and the move's curve as
  literals beside `MOVE_MS` and `MOVE_EASE`.
- `COLUMN` and `SHORT` are exported and nothing imports them.
- `teach` returns `{ keep, cancel: keep }`: one function under two
  names.
