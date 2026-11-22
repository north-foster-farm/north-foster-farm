# Splitting `cart/cart.js`

The fourth design under #782 (quality gates in the build), read from
`next` at `32ab0944`. The rules common to every phase are in
[order-form.md](order-form.md#3-the-phases). The cart's own design,
its boundaries and its state rules, is `docs/cart.md`. This document
changes none of it, and comes after
[cart-view.md](cart-view.md), which splits the module this one
drives.

`assets/scripts/order/cart/cart.js` is one class, `Cart`: 1,097
lines, 723 of them code, in 40 methods. Six run past 25 lines
(`wire` 77, `render` about 70, `wireShare` 41, `wireClear` 35, the
constructor, `apply`). It owns everything inside `#order-cart` and
the page's two readouts of the count and the total. Its view state
is already a pure module with 43 unit tests (`state.mjs`), and its
timing rules are two more (`confirm.mjs`, `code-note.mjs`). What is
left in the class is wiring and drawing, held together by the order
in which one render does things.

## 1. The file today

### What it does

**State on the page.** `constructor`, `apply`, `setShare`. Writes
`state.mjs`'s record to the pane's attributes, the pill's word and
the row's two `aria-expanded`.
Unit: `cart-state.test.mjs`.
e2e: `cart-fold`, `cart-float`, `cart-a11y`.

**Folding.** `motion`, `fold`, `open`, `close`, `toggle`, `busy`,
`scrolled`, and in `wire` the four watchers from `view.mjs`, the
sheet's media query and the finger on the pane.
Unit: `cart-state.test.mjs` (`place`, `scrolled`, `rendered`).
e2e: `cart-fold`, `cart-float`, `cart-motion`, `cart-keyboard`,
`cart-tip`.

**Escape.** The `keydown` handler in `wire`: an open tooltip first,
then Clear cart's question, then the shared row, then the fold.
e2e: `cart-keyboard`, `cart-a11y`, `cart-tip`.

**Proceed to checkout.** `wireCheckout`, `explain`, `shutWhy`,
`setWhy`, and the choice of reason in `render`.
e2e: `checkout-go`, `stock-failure`.

**Clear cart.** `wireClear`.
Unit: `cart-confirm.test.mjs` (`twoStep`).
e2e: `cart-lines`.

**The shared row and the code.** `wireShare`, `shutRow`, `shutCode`,
`wireCodeNote`, `codeResult`, `codeValue`, `setCodeValue`.
Unit: `cart-code.test.mjs`, `share-away.test.mjs`.
e2e: `cart-way`, `group-code`, `delivery-pass`, `cart-fold`.

**Badges and tooltips.** `wireBadges`, `allTips`, `shutTips`,
`renderBadges`, `setMoney`, `setPerks`.
e2e: `cart-tip`, `tooltip-center`, `cart-money`, `perk-label`,
`perk-revision`, `info-align`.

**Drawing.** `render`, `renderItems`, `dropRows`, `renderSums`,
`renderEdit`, `renderWays`, `markPassed`.
Unit: `summary.test.mjs` (what it is given),
`remove-icon.test.mjs` (which reads this file's source for the
remove button's label).
e2e: `cart-lines`, `cart-money`, `cart-one`, `remove-icon`,
`cart-way`, `edit-order`, `cart-badge`, `order-topbar-scroll`.

**An Add.** `added`, `keepOpen`, and the module's `firstAdd`.
e2e: `cart-fold`, `cart-motion`, `cart-a11y`.

**The joke.** `startJoke`, `stopJoke`.
e2e: `pricing`.

**Coming to the cart.** `show`.
e2e: `order-page`, `cart-badge`.

### State

- **The view state:** `state`, a record from `state.mjs`.
- **What the last render left:** `lastCount`, `lastTotal`,
  `itemsKey`, `lit`, `summary`, `renders`, `passed`.
- **The scroll rule:** `scrollFrom`, `easing`, `fingerDown`.
- **Proceed's reason:** `why`, `shownWhy`.
- **Running things:** `joke`, `teaching`, `tips`, `perkTips`,
  `whyTip`, `clearing`, `note`.
- **Watchers:** `placement`, `keyboard`, `lines`, `focusClear`,
  `scrolls`, `sheet`.
- **Elements:** `root`, `form`, `slot`, `heading`, `list`, `pill`,
  `checkout`; the callbacks in `on`.
- **Outside the instance:** the module's `addedBefore`, and the
  session's `nff-cart-first-add`.

Twelve fields are first set outside the constructor.

### DOM

Everything in `layouts/partials/order/cart.html`, by its `data-`
hooks: the parts (`[data-part]`), the lines and their two templates
(`[data-cart-group]`, `[data-cart-line]`, `[data-remove]`), the sums
(`[data-total]`, `[data-total-row]`, `[data-edit-money]`), the
badges (`[data-badge]`, `[data-tip]`, `[data-cart-perks]`), the
shared row (`[data-cart-share]`, `[data-way]`, `[data-way-toggle]`,
`[data-code-toggle]`, `[data-code-apply]`, `[data-code-note]`,
`[data-field='code']`), the foot (`[data-cart-toggle]`,
`[data-cart-word]`, `[data-checkout]`, `[data-nudge]`), Clear cart,
the "Added" strip and the live region.

Outside the pane it writes the form's `[data-total-bar-count]`,
`[data-total-bar-total]` and `[data-to-cart]`, and
`form.dataset.cartPassed`. It reads `#order-cart-heading`.

### Events and timers

Listens on the pane: `click`, `keydown`, `focusin`, `pointerdown`,
`show.bs.tooltip`. On the document: `click` (twice), `keydown`
(twice), `pointerdown`, `focusin`, `pointerup`, `pointercancel`. On
its own buttons and the code field. On the sheet's media query.

It dispatches nothing. It reaches the form only through its six
callbacks.

Timers: 60 ms before a line is said again in the live region; the
joke's one-second interval; `TEACH_DWELL` 3,500 ms; and those inside
`confirm.mjs` and `code-note.mjs`.

### Imports and importers

`order-form.js` is the one importer (`Cart`, `JOKE_CODE`).

It imports Bootstrap's `Tooltip`; `celebrate.js`; five libraries
from `order/lib/`; its neighbors `code-note.mjs`, `confirm.mjs`,
`perk-label.js`, `state.mjs`, `tip.js`; and 18 names from
`view.mjs`.

The contract with the form is written down (`docs/cart.md` 4.1):
the constructor's options and ten methods, `render`, `added`,
`setMoney`, `setPerks`, `codeResult`, `codeValue`, `setCodeValue`,
`startJoke`, `stopJoke`, `show`.

## 2. The target

`cart.js` stays, with `Cart`, its constructor and its ten methods
as they are. The form is not edited. The class becomes the root
that builds the parts, orders one render, and passes the form's
calls on.

### Modules

Sizes are code lines, estimated. All sit in
`assets/scripts/order/cart/`.

Pure:

```
why.mjs        WHY_EMPTY, WHY_CHECKING, WHY_DOWN, whyOf            25
escape.mjs     escapeStep                                          20
joke.mjs       JOKE_CODE, JOKE_PER_MINUTE, jokeLabel, jokeAmount   20
plan.mjs       changed, readoutLabels, editMoney, wayButtons,
               passedBy, tierKeys, deliveryTip, pillWord           90
```

`state.mjs`, `confirm.mjs` and `code-note.mjs` stay as they are.

Dumb:

```
dom.js         qs, all, pulse, say, reduced                        20
lines-view.js  drawItems, dropRows                                 50
sums-view.js   drawReadouts, drawSums, drawEdit, drawWays,
               drawNudge                                          110
joke-row.js    startJoke, stopJoke                                 35
```

Smart:

```
first-add.js   firstAdd                                            20
badges.js      Badges: the tooltips, draw, setMoney, setPerks     120
checkout.js    CheckoutButton: the tooltip, explain, setWhy        70
clear.js       ClearCart: the two presses                          50
share-row.js   ShareRow: the two toggles, a pick, away, Apply,
               the note, shutRow, shutCode                        130
fold.js        Fold: apply, motion, fold, busy, scrolled, the
               watchers                                           170
added.js       Added: the live line, the lesson, the strip         60
cart.js        Cart: build, the Escape order, render, show, the
               form's ten methods                                 200
```

Fifteen new modules and about 1,200 lines for today's 723.

`dom.js` repeats three helpers the order form's design also draws
out (`order/form/dom.js`). The two series do not depend on each
other, so each has its own until both have landed.

### How state moves

```
form.render(summary, facts)
  -> Cart.render
       drawReadouts                       sums-view.js
       checkout.setWhy(whyOf(...))        why.mjs
       next = state.rendered(...)         state.mjs
       changed(next, state, ...) ?        plan.mjs
         yes: fold.motion(apply + draw)   fold.js -> view.mjs
              then, if still the latest render:
              dropRows, placement.refresh, lines.sync, badges.draw
         no:  draw, refresh, sync, badges.draw

a press, a key, a scroll
  -> the part that owns it
       fold.fold(state.<transition>(state))
```

- **`Fold` owns the view state.** It holds the record, applies it,
  runs every change of size through the view's motion, and counts
  the eases. Every other part asks it (`fold.open()`,
  `fold.setShare()`, `fold.state`), and none writes an attribute of
  the pane's.
- **Parts talk through the root.** The Escape order needs four of
  them. `escapeStep` decides which acts, and the root calls it.
- **One render, one order.** Readouts, the reason, the plan, the
  motion, and the badges last. The root keeps that order in one
  function of calls.

### What stays as it is

The constructor's options and the ten methods; `JOKE_CODE` and
`TEACH_DWELL` as exports of `cart.js`; `state.mjs`, `confirm.mjs`,
`code-note.mjs`, `perk-label.js`, `tip.js`; `view.mjs`'s surface;
`order-form.js`.

## 3. The phases

The rules are those of
[order-form.md](order-form.md#3-the-phases). The eleven cart specs
named in [cart-view.md](cart-view.md#3-the-phases) are read first
after every phase. This series starts after the last phase of
`view.mjs`'s, so the two never edit the cart's folder at once.

### Phase 1: the small decisions

Moves the reasons Proceed cannot go on to `why.mjs`, the joke's
numbers to `joke.mjs` and its row to `joke-row.js`, `firstAdd` to
`first-add.js`, and `qs`, `all`, `pulse`, `say`, `reduced` to
`dom.js`. `cart.js` still exports `JOKE_CODE`.

Criteria:

1. `whyOf` for an empty cart is the empty reason.
2. For a cart with items while stock is unknown it is the locked
   reason, in the checking words, or the unavailable words when
   stock could not be checked.
3. For a delivery under the minimum it is the minimum reason, with
   the summary's own tip.
4. Otherwise it is null. Empty comes before locked, and locked
   before the minimum.
5. `jokeAmount` is the whole cents earned at the joke's rate for
   the time passed, and 0 at the start.
6. `jokeLabel` names the code and its rate a minute.

Stay green: `cart-state.test.mjs`, `validate.test.mjs`.
e2e: `checkout-go`, `stock-failure`, `pricing`, `cart-fold`.

### Phase 2: drawing

Moves `renderItems` and `dropRows` to `lines-view.js`; `renderSums`,
`renderEdit`, `renderWays`, the readouts and the nudge to
`sums-view.js`; their decisions to `plan.mjs`.

The test agent moves the source check in
`test/remove-icon.test.mjs` from `cart.js` to `lines-view.js`. That
changes an expectation, so it is in the test agent's patch.

Criteria (`plan.mjs`):

1. `changed` is true when the fold or the emptiness changes, when
   the lines differ from those drawn, and when the nudge comes or
   goes. Otherwise it is false.
2. `readoutLabels` gives the bars' link "N items, total $X. Go to
   the cart." and the pill "N items, total $X. Show or hide the
   cart."
3. `editMoney` gives what is paid, the kept fee with its day, and
   "You pay" or "We refund" with the difference, never negative.
4. `wayButtons` presses the way the page holds, disables a way that
   cannot be picked, and names the button by that way, by the
   form's name for a way the switch lacks, or "Pickup or delivery".
5. `passedBy` is true only for a settled cart on a screen that is
   not short, whose foot has come within 60 px of the screen's top.
6. `tierKeys` lists the badge keys of the day's bulk tiers.
7. `deliveryTip` puts the day's minimum into the delivery badge's
   tip.

Stay green: `summary.test.mjs`, `remove-icon.test.mjs`,
`minimum-tip.test.mjs`.
e2e: `cart-lines`, `cart-money`, `cart-one`, `remove-icon`,
`cart-way`, `edit-order`, `cart-badge`, `order-topbar-scroll`.

### Phase 3: badges and tooltips

Moves `wireBadges`, `allTips`, `shutTips`, `renderBadges`,
`setMoney` and `setPerks` to `badges.js`.

No criteria tests: `tierKeys` and `deliveryTip` came in phase 2,
and the rest is Bootstrap's tooltips and where a badge is on
screen.

e2e: `cart-tip`, `tooltip-center`, `cart-money`, `perk-label`,
`perk-revision`, `info-align`.

### Phase 4: Proceed to checkout and Clear cart

Moves `wireCheckout`, `explain`, `shutWhy` and `setWhy` to
`checkout.js`; `wireClear` to `clear.js`.

No criteria tests: `whyOf` came in phase 1 and `twoStep` has its
own.

Stay green: `cart-confirm.test.mjs`.
e2e: `checkout-go`, `stock-failure`, `cart-lines`, `cart-keyboard`.

### Phase 5: the shared row and the code

Moves `wireShare`, `shutRow`, `shutCode`, `wireCodeNote`,
`codeResult`, `codeValue` and `setCodeValue` to `share-row.js`.

No criteria tests: the note's timing and the away rule have their
own.

Stay green: `cart-code.test.mjs`, `share-away.test.mjs`.
e2e: `cart-way`, `group-code`, `delivery-pass`, `cart-fold`,
`cart-keyboard`.

### Phase 6: folding

Moves `apply`, `motion`, `fold`, `open`, `close`, `toggle`, `busy`,
`scrolled`, `setShare`, `markPassed` and the watchers to `fold.js`;
`added` and `keepOpen` to `added.js`.

Criteria (`plan.mjs`, `escape.mjs`):

1. `pillWord` is "Hide" for an open floating pane and "Expand" for
   a closed one, and nothing for a pane that does not float.
2. `escapeStep` is the tooltips when one is open.
3. With none open it is Clear cart while it is asking.
4. Then the shared row while a side is open.
5. Then the fold, when `state.escape` handles the key, and nothing
   otherwise.

Stay green: `cart-state.test.mjs`, `cart-view.test.mjs`.
e2e: `cart-fold`, `cart-float`, `cart-motion`, `cart-keyboard`,
`cart-tip`, `cart-a11y`, `cart-lines`.

### Phase 7: the root

`cart.js` is the constructor, `wire`, `render`, `show` and the
form's methods, each within the limits, and comes off the legacy
lists of #782 (quality gates in the build).

No criteria tests.
e2e: the eleven cart specs, `checkout-go`, `pricing`, `order-page`.

## 4. What must not change

- **The contract with the form:** the options, the ten methods,
  the six callbacks, and that the cart never reads the form
  (`docs/cart.md` 4.1).
- **The order of one render:** readouts and the reason first; the
  draw inside the motion, so the view measures before and after it;
  the badges only after the pane is still, and only for the latest
  render.
- **The order of Escape:** tooltips, Clear cart, the row, the fold,
  with the focus put where each leaves it.
- **Every hook in `cart.html`,** the attributes `state.mjs` names,
  `form.dataset.cartPassed`, and `inert` on the bars' links.
- **What a screen reader hears:** the live region's lines and the
  60 ms gap that makes a repeated one heard, the labels on the
  pill, the bars' links and each remove button, `aria-expanded`,
  `aria-pressed`, and `aria-disabled` (never `disabled`) on Proceed.
- **The first Add:** `nff-cart-first-add` in the session's storage,
  with the fallback when storage is blocked, and `TEACH_DWELL`.
- **Focus:** on the pill after Escape folds, on the row's button
  after it shuts, on the pane after a clear, on the heading or the
  pane in `show`.
- **Wording,** byte for byte. Several lines are drafts for comms.
- **Imports into the cart's folder.** `home/main.js` and
  `account/main.js` import `perk-label.js`, which is not edited.

The risk is the order inside `render`, which no unit test sees.
`cart-motion` and `cart-lines` are its guard, and phase 7 changes
that function alone.

## 5. Where the stall valve is needed

- **`cart.js`, phases 1 to 6:** one entry on #791 (the rule
  exceptions log) for the series.
- **`test/remove-icon.test.mjs`** changes by one path in phase 2,
  in the test agent's patch: modified lines only.
- **Nothing else.** `view.mjs` is finished before this series
  starts, and `order-form.js` is not edited.

## 6. Found while reading

None of these is fixed inside a move.

- `watchKeyboard` is given an `onInset` that does nothing.
- The disposers of the keyboard, focus and scroll watchers are kept
  and never called. The cart lives as long as the page.
- `wireBadges` reads Bootstrap's private `tip._element`.
- When a render moves nothing, `render` sets `this.state` without
  `apply`. It is harmless today, since a change that `apply` would
  write always counts as a move.
- `qs`, `all`, `pulse` and `reduced` are copies of those in
  `order-form.js` and `view.mjs`.
- `addedBefore` is a module variable.
- The comment on `PASSED_AT` measures from the screen's foot, and
  `markPassed` compares the slot's bottom edge with the top.
