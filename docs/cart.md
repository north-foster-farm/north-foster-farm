# The cart

The order page's cart, rebuilt as one component for every viewport
(#477). Section 1 is the study of why the old one kept breaking,
section 2 names the causes, and sections 3 to 7 are the spec the
rebuild follows. Written by the cart lanes, 2026-10-26, from the code
at cb7839f1.

## 1. The churn

The order page was redesigned around the shopping flow on 2026-09-18
(adf0e363). Every cart commit but four is later than that: 176 commits
in 38 days whose subject names the cart, 15% of the repository's 1,206.

| File | Commits | Lines |
| --- | --- | --- |
| `assets/scripts/order/order-form.js` | 132 | 3,242 |
| `assets/styles/components/_order.scss` | 128 | 3,247 |
| `layouts/partials/order/cart.html` | 39 | 160 |
| `layouts/partials/order/form.html` | 37 | 155 |
| `assets/scripts/order/lib/summary.mjs` | 14 | 167 |
| `layouts/partials/header/mini-cart.html` | 9 | 30 |
| `assets/scripts/order/lib/totals.mjs` | 7 | 141 |
| `assets/scripts/order/lib/cart-scroll.mjs` | 5 | 110 |
| `assets/scripts/order/lib/cart-sync.mjs` | 3 | 93 |
| `assets/scripts/order/lib/cart-float.mjs` | 2 | 63 |

Commits touching the three big files, by ISO week: 15, 44, 24, 0, 29,
87, 5 (weeks 37 to 43). The peaks are review days: 2026-09-24 (18
cart commits), 09-28 (24), 10-18 (20), 10-20 (16), 10-22 (13) and
10-24 (30). The money logic (`totals.mjs`, `summary.mjs`) is the quiet
part: 21 commits between them, with unit tests that pin every sentence.
The churn is in the pane: its height, its folds, where it sits, and how
it reacts to the viewport.

Thirteen `e2e/cart-*.spec.mjs` files, 2,997 lines, plus cart cases in
`keyboard`, `order-page`, `overflow`, `restock` and `search`. Four are
named after review rounds (`cart-round3` to `cart-round6`), and the
rest pin pixel heights, fill positions and data attributes. Every
change to the pane broke a handful: five flaking specs fixed on 10-20
(17b13685), the keyboard spec flaky since 10-18 (#427), and the two
keyboard specs marked `test.fixme` on 10-26 (#476).

The review trail: #180 (09-25, the phone cart shows one line), #203
(09-27, James stops the build and asks for a mock-up; the whole-row
fold is reverted), #204 (10-17, James: "we have introduced too many
collapsible panes... the interaction story needs to be made 50% less
complicated"; 10-18, seven more pane items), #267 (10-16, the launch
blockers), #274 (rounds 3, 4, 5 and 6, 10-20 to 10-24, plus a round 6
bug), #278 (round 4), then one issue a day: #383 (the way can't be
picked on Safari), #389 (the code field under the keyboard), #448
(three landings, a round trip and a clipped ring), #473 (a scroll keeps
the pane open), #475 (the list is short), #476 (Hide and Proceed out of
reach; open), and #392 (the toggle's design, built twice and reverted
twice, paused).

### What kept changing

**The pane's height on a phone.** 65svh (09-20); the small viewport
under the top bar less 3rem, following the bar (#180, 09-26); a floor
of three rows (#180); the floor dropped for one item (O7c, 09-28);
55% of the screen for each pane (2b4c10d4, 10-18); 58% for the whole
pane (b4e4d1f3); capped by the visible height, with the floor measured
(a35053b3, 10-18); 48%; the floor re-measured on the Total tab and a
floor for the sums (#448, 10-25); a 0.75rem gap under the switch
(#448 round 2); the cap raised to 66% (#475, 10-26); and the rows now
give way under the keyboard (#476, on a branch). Each step added a CSS
variable the script measures: `--cart-min-h`, `--cart-fold-min`,
`--cart-scroll-min`, `--cart-sums-min`, `--cart-list-h`, `--cart-vis`,
`--cart-gap`, `--cart-kb`, `--cart-bar`, `--cart-keep`.

**The folds.** An Expand and Hide pill (09-20); the total row folds
the whole cart (4a455713, 09-24); reverted (328b3b5, 09-27); the count
folds the lines and the total unfolds the sums (0a4f2468, 09-28);
settled, nothing folds (a28065b, 09-28); the two panes take turns on a
phone (d4af18c7, 10-18); the pair becomes tabs with `role="tab"`
(syncSeg); from md the pair are disclosure buttons; in the 576 to 1199
panel the pair is a readout and the pill folds the lines alone (round
6, 10-24); the pair should share the top switcher's design (#392, two
reverts). The same two buttons have had four semantics.

**Floating and settling.** Sticky with `data-stuck` read from the
rect (09-20); settling decided from the pane's place under its heading
and its floating height, so a settled pane that shows every line does
not float again at once (round 3, item 6); the pane lifts off hidden,
whatever it settled as, measured from an unseen clone of itself
(round 5); one pill lit after lifting off (round 5); a panel at 576 to
1199 lifts off shut on its right column (round 6); on load at 1010 the
cart was a dead sheet until the first scroll (round 6 bug); short
screens never float (round 4). QA, 10-22: "it now lifts off about
370px later on the way up at 390, because it waits until the hidden
cart fits. That's by design."

**The keyboard.** The pane rides up by the keyboard's height
(ddbc0600, 10-18); the visual viewport is read on every resize and
scroll (#389); the Total tab is measured too (#448); the tier line
keeps its room (#448 round 2); the rings are drawn inside (#448 round
3); the rows give way (#476). Five fixes in nine days for one field.

**The badges.** Dropped first when the cap is short (bb34f07d); shown
only for delivery (4dabd6d4); restored, with a spec (round 3); one
"Free Delivery" badge (round 4, item 6); two badges again, James's
option A (round 4); a second line below 22rem (#289); room under the
switch with the keyboard up (#448).

**The shared row.** The way and the code share one row (0a4f2468);
blur must not fold it because iOS blurs before Apply's click; Safari
focuses the pane instead of the pick, so the "away" rule folded the
row between mousedown and mouseup (#383); the field under the keyboard
(#389).

**The first Add.** The pane opens on the new line, shuts after a
dwell and the pill pulses (#267, #278 item 8); the dwell went 2000 to
3500 to 2000 to 3500 ms; the outline on the new line came and went; a
scroll that lands on the pane must not keep it open (#473).

**The shape of the churn.** Each review set a target in pixels or
seconds (48, 55 to 60, 58 and 66 percent; three rows; 1.5 s; 0.75rem),
and each target became a new constant and a new measured branch
rather than a rule in a model: the height equation has about fifteen
terms. The iOS viewport was learned one phone screenshot at a time,
after shipping, because the Mac's WebKit has no toolbar and no
keyboard: 120px tells a toolbar from a keyboard, the keyboard fires no
window resize, `svh` for the cap but `visualViewport` for the foot.
#475 showed that the floor, not the cap, had set the phone pane's
height all along. In all: 25 issues, 16 review rounds from James's
phone or desktop, 4 reverts, and `measureFloor` rewritten 6 times in
8 days.

## 2. Root causes

Named for the instability, not for the symptoms above.

**R1. Three layout regimes in one DOM, told apart at run time.** Below
576 (or under 500px tall) the cart is a one-column sheet; from 576 to
1199 a two-column panel; from 1200 a column. The same attributes mean
different things in each: `data-items` and `data-money` are tabs that
take turns on the sheet, independent folds from md, and ignored in the
panel, where `data-open` is forced true and the pill folds the lines
instead. The script asks which regime it is in (`SHEET`, `PANEL`,
`SHORT`, `panel()`, `column`) in fifteen places and swaps ARIA roles
on a media change (`syncSeg`). The stylesheet dissolves the fold
wrappers into a grid with `display: contents` from 576, so the folds
measure 0 there and the script keeps a clone of the pane to measure
(`hiddenHeight`). A fix in one regime leaked into the next every time:
both pills lit after lifting off (round 5), a dead sheet at 1010
(round 6), the switcher broken by a shared selector (#392).

**R2. The pane's height is computed, not laid out.** The pane must
keep its total row and foot, let the lines give way first, then the
sums, then the badges and the code row, under a cap that follows the
visible height. Flex can express that order with `min-height` and
`overflow`, but the fold wrappers (`grid-template-rows: 0fr` to `1fr`
for the animation) sit between the parts and the pane, so the script
sums the parts' `offsetHeight` and margins after every render, scroll,
resize, visual viewport event, `transitionend` and `ResizeObserver`
tick (`measureFloor`, `syncScroll`, `paneFit`), and writes the result
back as CSS variables the same layout reads. The loop needs guards
("not while its padding eases", "counted always, or the gap's own
height would flip tight", "the strip is counted back first"). #180,
#389, #448 (three times) and #476 are each a term that was missing
from the sum, and each review's pixel target became another.

**R3. Settling is decided by the script from a height that depends on
the decision.** The cart is `position: sticky; bottom`, and the script
makes it `position: relative` once its place in the flow would put it
higher than it floats. Settled, it shows every line, so it is taller
than it floats; judged by that height it would float again at once,
so the script remembers its last floating height, lifts off hidden,
and measures a hidden clone of the whole pane each time it settles.
Scroll-to-cart retries up to four times because the layout moves under
the glide as the pane settles (`landOn`). The round trip settle, float,
tap the code field is how James reproduces #448 every time.

**R4. The view's state has no owner.** `data-open`, `data-items`,
`data-money`, `data-stuck`, `data-tight`, `data-empty`, `data-share`
and `data-cart-passed` are set by `stuckWatch`, `plain`, `renderCart`,
`added`, `changed`, `pick`, `flip`, Escape, the pill and `setPart`. The
rules ("a panel with lines is never folded to its total row", "settled
is always open, both parts", "tabs take turns", "floating again means
hidden on the lines", "empty folds, the first item opens") are
corrective `if`s applied after the fact in three places, and
re-applied on every scroll frame. Ten flags in all (the width class,
short, stuck, open, items, money, empty, tight, share, the keyboard,
the first-add timer), their invariants re-asserted in eight places. A
rule missed on one path is a bug (round 6 bug: `changed()` did not
apply the panel rule), and every state reached after the settle and
float round trip is reached by a different path than page load, which
is why James's #448 reproduction needs the round trip. There is no
state object and no transition function, so none of it is unit tested.

**R5. The cart's view and the order form are one class.** `OrderForm`
lays out the cart, watches the keyboard, scrolls the list, judges
touches, runs the teach animation, computes totals, saves the draft,
takes payment and submits. The cart reads quantities by querying the
catalog's `[data-qty]` inputs and writes them back by setting input
values and dispatching events; the header reads the saved draft
instead (`search/cart.js` branches on `onOrderPage()`). Two models of
the lines, and `order-form.js` at 3,242 lines is where every cart
change lands, beside the payment code.

**R6. Each round added a mechanism; none took one away.** Tabs,
disclosures, a readout; two "more" pills with a custom glide; a teach
dwell with three pulse pairs and a reduced-motion branch; an "Added:"
bar; a live region; the ring; the chicks; the height ease in the
column; `landOn`; the ghost clone; the touch judge. Each has timers
and guards, each is measured, and the specs pin the mechanism rather
than the behavior, so a change breaks a dozen tests (#427, #476).
James asked for half as many controls on 10-17; round 6 removed the
pair's control in the panel only.

**R7. The iOS viewport is handled by heuristics, after the fact.** The
pane is positioned against the layout viewport, which iOS does not
shrink for the keyboard or its toolbar, so every reaction to either is
a number read from `visualViewport` and pushed into the layout by
script (`--cart-kb`, `--cart-gap`, `--cart-vis`, `--cart-bar`), each
added after a phone screenshot, none testable on the Mac's WebKit,
which has neither. The specs stand in a shrunken visual viewport for
the keyboard and were written, not run.

## 3. What the cart does today

The surface the rebuild keeps, found in the code, the specs and the
issues. Wording below is today's, approved under #400.

- **Lines.** Every product with a quantity above 0, grouped by category
  in catalog order, each group under its short name, each line with a
  remove ×, the pack label (capitalized), "qty × $unit" and the line
  total. "0 items" when empty. Lines are rebuilt only when they change,
  so a × under the pointer survives a render (#155).
- **Quantities** live in the catalog rows' inputs (`[data-qty]`, 0 to
  99, `data-max` while changing a paid order). The × sets a line's
  input to 0. Search and the header change the same inputs on the
  order page and the saved draft elsewhere (`search/cart.js`).
- **Count and total.** "N items" and "Total $X" in the pane; the same
  figures in the phone top bar and the lg to xl total bar once the
  pane has scrolled away, where a tap returns to the cart; the count
  on the header's Order link and cart icon (`announceCart`).
- **Sums.** Subtotal; one discount row (the largest of the bulk tier
  "Bulk discount ($100+)", the signed-in group "Label (10%)" or a code
  by its label); Delivery fee ("+$5", "Free" at the waiver, "$0" when
  a pass waives it, "+$8" with the outside-area charge), only for
  delivery with items. Totals in integer cents from `totals.mjs`;
  prices on the day from `money-on.mjs`; the server recomputes all.
- **Changing a paid order** (`/order/?edit=`): Paid, a kept delivery
  fee, and "You pay" or "We refund" under the total; Save changes
  stands in for payment when nothing is owed.
- **Badges.** "Delivery" (lit at the delivery minimum after
  discounts), "Free delivery" (lit at the waiver), then "$50+ ...
  $200+" (lit at each tier), one dotted line, the tiers on a second
  line below 22rem; each a button with a tooltip; lit badges italic
  green. A badge that lights sends chicks (`celebrate.js`), from the
  total when the badge is out of sight. Tiers follow `money.changes`.
- **The nudge.** One sentence under Continue: "Add $X to reach the $40
  delivery minimum." (warn tone, delivery only), "Next discount: add
  $X for $Y off." or "... and free delivery.", nothing at the top
  tier; "Delivery requires $40 or more." on an empty delivery cart.
- **The way.** A button naming the page's chosen method ("On-farm
  pickup", "Pickup days", "Delivery", or "Pickup or delivery" when
  none); it opens into a three-way switch over the row; a pick sets
  the form's radio without scrolling the page; Pickup days is disabled
  without dates. The cart never picks a default: `?method=` and the
  home page's links win over a remembered way (#203).
- **Discount code.** "Add discount" opens a field and Apply over the
  row, with focus in the field; Enter or Apply applies; the code is
  checked by SHA-256 against hashes the page carries; an accepted code
  empties the field, folds the row, focuses Add discount and says
  "Code applied: $10 off." for 15 s; an unknown eight-character code is
  tried as a farm pass (`/api/pass`): "Applied: this order can be
  delivered under the $40 minimum." or "Applied."; anything else:
  "That code isn't valid." Apply with the field empty takes the code
  and the pass off. A saved pass is asked about again on restore. The
  code is sent as `code`, the pass as `pass`.
- **The joke.** `EGGBOI` adds a row "Discount (EGGBOI, $40/min)"
  growing by $40 a minute while the page is open; nothing else changes
  and the server has never heard of it.
- **Stock.** `stock.js` lowers or removes lines when stock changes and
  the notice over the catalog says so (`stock-notice.mjs`); a locked
  stock gate disables Proceed to checkout.
- **Proceed to checkout** scrolls to Pickup or delivery and focuses its
  legend; disabled when empty, locked, or delivery under the minimum.
- **The first Add of a browser session** (sessionStorage) opens the
  floating pane on the new line, shuts it after `TEACH_DWELL` (3500 ms)
  and pulses the pill in three pairs; a tap, focus or key in the pane
  keeps it open, a scroll does not (#473); reduced motion holds a
  still emphasis. Later Adds pulse once and, with the pane shut, show
  "Added: Wings, 1.0 – 1.9 lbs" in the bar for 2.6 s. Every Add is
  read to a screen reader ("Added Wings, 1.0 – 1.9 lbs to cart").
- **`?add=SKU:qty,...`** fills the cart, names what it added or could
  not, clears the query and scrolls to the cart.
- **The rail's Cart link and the mini cart's Go to cart** bring the
  cart into view at every width and ring it (#337); `#order-cart` in
  the URL does the same.
- **Escape** folds the floating pane and focuses the pill (#159);
  while folded its controls are `inert`. A control focused under the
  floating pane is scrolled clear of it (WCAG 2.4.11).
- **What it saves.** `changed()` saves the whole form as the draft
  (`nff-order-draft` in localStorage: lines, way, date, customer,
  address, code, pass) with `savedAt`; a signed-in customer's copy
  goes to `/api/account/cart` 1.5 s later or on `pagehide`, newest
  wins, a placed order clears both; a draft tagged for another account
  is scrubbed of its details (`cart-sync.mjs`, `draft.js`). The header
  reads the same draft on other pages and on `storage` events.
- **What it sends** at checkout: `lines`, `fulfilment.method`, `code`,
  `pass`, `claimedTotal`, with the customer and fulfilment fields.
- **The mini cart.** The header's cart icon, shown with items, opens a
  dropdown of the lines with ×, a subtotal and two links. James
  decided on 10-24 that it goes (#402): the icon stays as a link to
  `/order/#order-cart` with its count badge.
- **Accessibility today.** The pane is an `aside` named by its
  heading; the pair are tabs, disclosures or text by width; the pill,
  the way and Add discount carry `aria-expanded`; the live region and
  the code note are polite; the nudge is a polite live region; badges
  are buttons with tooltips; folded parts are `inert`.

## 4. The design

### 4.1 Boundaries

The cart is a class of its own, `assets/scripts/order/cart/cart.js`,
owning everything inside `#order-cart` and the summary bar, and
nothing outside. `OrderForm` keeps the form's model: quantities in the
catalog rows, the method radios, the draft, stock, dates, payment and
submission. The contract between them:

- `OrderForm` calls `cart.render(summary, { method, edit })` on every
  `refresh()`, where `summary` is `summarize()`'s output (count, groups,
  sums, badges, nudge, eligibility) plus `ways` (which are enabled).
  The cart never reads the form.
- `OrderForm` calls `cart.added(sku, name)` after an Add, and
  `cart.locked(bool)` from the stock gate.
- The cart calls back: `onRemove(sku)`, `onWay(method)`,
  `onCode(text)` (the form applies it and answers with
  `cart.codeResult({ tone, text })`), `onCheckout()`.
- The code field, the way picks, the badges and the pill are the
  cart's. The joke row is the cart's too (a render flag `joke` with the
  running amount from the form's clock, or the cart's own timer; one
  of the two, decided in the build).
- Draft, sync and the header badge stay in `draft.js`, `cart-sync.mjs`,
  `session/cart-sync.js` and `cart-badge/*`, unchanged in shape. The
  cart announces nothing itself; `OrderForm` keeps `announceCart`.

`order-form.js` loses the pane: `wire()`'s cart half, `wireShare`,
`watchKeyboard`, `scrollMore`, `setShare`, `setPart`, `syncSeg`,
`hiddenHeight`, `setOpen`, `panel`, `syncToggle`, `syncScroll`,
`measureFloor`, `added`, `firstAdd`, `reveal`, `pulsePill`, `ringCart`,
`keepOpen`, `watchTouch`, `renderCart`, `ease`, `renderItems`,
`startJoke`, `stopJoke`, and the cart parts of `stuckWatch` and
`landOn`. About 1,300 lines move or go.

**`cart/view.mjs`.** The view module owns what touches the viewport,
the clock and the pane's own motion. It writes no height, floor or cap
to CSS. Its surface, which the Cart class imports:

- `watchKeyboard(pane, { onInset })` -> dispose. One `visualViewport`
  resize listener writes `--cart-vis`, `--cart-gap` and `--cart-kb` on
  the pane as raw pixels and calls `onInset(inset, before)` when the
  keyboard's inset changes. The one scroll it makes: when the inset
  grows while the code field has focus, the field is brought into its
  scroller's view once (`scrollIntoView({ block: "nearest" })`), since
  Chromium does not do that for a scroller that shrinks after focus.
- `watchPlacement(pane, slot, { bar, look })` -> `{ refresh, dispose }`.
  A `requestAnimationFrame` tick on scroll and resize sets `--cart-bar`
  from the top bar's foot and calls `look({ column, short, slotTop,
  slotBottom, room, height, closedH })`, exactly `place()`'s inputs
  plus `slotBottom`. `height` is the pane's height read in `refresh()`
  only, which the class calls after a render and after `animateFold`
  resolves, and which the view calls itself on resize and when the
  pane's chrome transition ends; `closedH` is the pane's own height
  as last measured floating and closed, or, until it has been, the
  stylesheet's `--cart-closed-h` for this width, read then too; a
  resize or a width change forgets the measurement; `room` is the
  layout viewport's height less the rest margin and the toolbar's gap.
  While `--cart-kb` is above 0 the tick writes the bar and looks at
  nothing else.
- `animateFold(pane, apply, { reduce })` -> Promise. Reads the pane's
  height, runs `apply()` (the class's attribute writes), reads it
  again and eases between the two with the Web Animations API; a
  floating sheet rests on its foot, so it grows upward. Nothing under
  reduced motion or when nothing moved.
- `watchList(list, wrap, { more, moreTop })` -> `{ sync, dispose }`:
  the "N more" pills, the edge fades and the glide (`moreStop`), on
  the list's scroll and a `ResizeObserver`.
- `teach(pane, pill, { dwell, onShut })` -> `{ keep, cancel }`: the
  first Add's timer, with `cart-touch` judging a touch when it ends;
  a mouse or pen press keeps at once; the class calls `keep()` on
  focusin and keydown. When the dwell passes, `onShut()` runs and the
  pill pulses in three pairs.
- `pulsePill(pill, kind)`, `ringCart(pane)`, `showAdded(box, text)`,
  `revealLine(list, row)`, `clearFocusUnder(pane, bar)` -> dispose.
- Pure and unit tested: `toPx(value, rootFont)` and `restOf({ margin,
  gap, kb })`.

### 4.2 Structure

One tree, flat, in `layouts/partials/order/cart.html`. The heading
stays in the flow above the slot. No fold wrappers, no `display:
contents` below 576, no cloned pane.

```
h2#order-cart-heading
div.order-cart-slot[data-cart-slot]             the pane's place in the page
  aside#order-cart.order-cart
      [data-placement][data-fold][data-empty][data-share]
    div.order-cart-body[data-cart-body]         scrolls as a whole when short
      section.order-cart-lines  [data-part=lines]   the "more" pills, the list,
                                                    the two line templates
      dl.order-cart-sums        [data-part=sums]    subtotal, discount, joke, fee
      div.order-cart-total-row  [data-part=total]   "N items" and "Total $X"
      dl.order-cart-sums.order-cart-edit [data-part=edit]  paid, kept, to pay
      ul.order-cart-badges      [data-part=badges]
      div.order-cart-share      [data-part=share]   the way and the code
      p.order-cart-code-note
    div.order-cart-foot[data-part=foot]
      button.order-cart-toggle[data-cart-toggle]  Expand or Hide (below xl)
      button.order-cart-next[data-checkout]       Proceed to checkout
      p.order-cart-nudge
    div.order-cart-added[data-cart-added-box]     the "Added:" strip
    p.visually-hidden[role=status][data-cart-live]
```

The count and the total are text at every width. The pill is the one
fold control. The parts' order on a phone is today's. The lines render
from `template[data-cart-group]` (`li.order-cart-group` with
`[data-group-name]` and `ul[data-group-items]`) and
`template[data-cart-line]` (`li.order-cart-item` with
`button[data-remove]`, `[data-line-name]`, `[data-line-qty]`,
`[data-line-sub]`), so their classes survive the build. The rules
between the parts are the parts' own top borders, not `hr` elements.
Every data hook the specs use today is kept.

### 4.3 State

A pure module, `assets/scripts/order/cart/state.mjs`, holds the view
state and every transition, with unit tests for each rule:

```
{ placement: "column" | "inline" | "floating",
  fold: "open" | "closed",
  empty: boolean,
  share: "" | "way" | "code" }
```

Transitions: `measure({ wide, short, slotTop, room, height, closedH })`
decides placement; `settle()` sets fold open; `float()` sets fold
closed; `toggle()`, `open()`, `close()`, `escape()`; `render(count)`
sets `empty`, folds an emptied floating cart and opens it on the first
item; `teach()` opens and returns the close to run after the dwell.
The rules live here and nowhere else:

- `column` ignores fold: everything shows, the pill is hidden.
- `inline` is always open (James, #233 item 19: settled shows the
  whole cart).
- `floating` opens and closes by the pill, Escape, the first Add and
  the empty rule only. Lifting off always closes (round 5).
- Placement never changes while the keyboard is up.
- What `closed` hides is the stylesheet's, by width (4.4). The script
  has one fold, not three.

The DOM reflects the state: `data-placement`, `data-fold`,
`data-empty`, `data-share`, `aria-expanded` on the pill and the two
row buttons, `inert` on hidden parts. Nothing else is written by the
layout code.

### 4.4 Layout at every width

`_cart.scss`, scoped under `.order` like `_order.scss`. The pane is a
flex column: the body, then the foot. The body is `flex: 1 1 auto;
min-height: 0; overflow-y: auto; overscroll-behavior: contain`: when
the room is short it scrolls as a whole and the foot stays in reach.
Inside it the lines are the one part that shrinks (`flex: 0 1 auto;
min-height: three rows`), and they scroll on their own; every other
part is `flex: 0 0 auto`. The browser lays out James's priority
(lines give way first, the foot never) with no measured floor and no
`data-tight`.

The soft cap is declarative: the lines' `max-height` is
`max(three rows, calc(var(--cart-vis) * 0.66 - var(--cart-chrome)))`,
where `--cart-chrome` is a rem constant for the parts other than the
lines at one line each. A line of badges more or less moves the cap by
that line; that is the error accepted for a layout that cannot
oscillate. The hard limits are exact: the pane's `max-height` is the
visible height less the top bar's foot and the rest, and the body's
overflow is the fallback.

Four raw inputs reach the stylesheet, from one listener and the
placement tick: `--cart-vis`, `--cart-gap`, `--cart-kb` and
`--cart-bar`. It derives only the floating pane's `bottom` and
`max-height` and the lines' cap from them. Three constants come the
other way, read by the tick with `getComputedStyle`: `--cart-closed-h`
(11rem on the sheet, 19.5rem in the panel, each a little under the
closed pane as measured), `--cart-chrome` and `--cart-lines-min`.

**Floating, settling and lifting off (below xl, tall screens).** The
floating pane is `position: sticky; bottom: calc(rest + gap + kb)`
inside its slot, so the browser itself holds it at the foot of the
screen while the slot is below and lets it rise with the slot as the
slot comes up. The script decides only when the pane's chrome changes
(`data-placement`), from `place()`: settle when `slotTop <= room -
height`, where `height` is the cached floating height, which is the
moment the sticky pane is already at the slot's top, so nothing moves;
lift off when `slotTop > room - closedH`, when the pane becomes sticky
again, closed, `closedH` tall, where the slot's top just was. The two
thresholds can never overlap: `closedH` is the pane's own closed
height, cached whenever it is measured floating and closed, and the
stylesheet's constant stands in only before that, as a lower bound.
Were the constant above the real closed height, a scroll stopping in
the band between the thresholds would settle and lift off in turn,
and in the panel, whose open and closed heights are nearly equal, it
did. The slot needs no `min-height`: a sticky pane keeps its place in
the flow, and at both seams the content below the slot is off screen.
Placement is frozen while the keyboard is up.

**Phone, under 576px, and any screen 500px tall or less**

- `floating`: on the page's gutters (the slot's width), resting a
  margin above the browser toolbar (`--cart-gap`), the safe area
  (`env()`) and the keyboard (`--cart-kb`); never behind the toolbar;
  the top bar stays over it (z-index 30 under the bar's 35). `closed`
  shows the total row and the foot: every other part of the body is
  `display: none`. `open` shows every part, lines first. An accent
  along the top below lg, as today.
- `inline` and short screens: in the slot, in the flow, flat (no
  border, padding or shadow, the border's pixel taken back by a
  margin); the body no scroller; the lines uncapped; the pill hidden;
  Continue as wide as its words. Short screens tighten the paddings
  and put the nudge at the left of the foot's one row.
- Only the chrome eases between floating and inline (padding, border
  color, shadow); never a height, a width or a position.

**576 to 1199px, taller than 500px**

- `floating`: James's panel (round 6). The pane itself is the grid
  (`display: grid`), the body `display: contents` (nothing is measured,
  so the dissolved wrapper costs nothing here); the lines take column
  1 spanning every row with `contain: size`, so the right column sets
  the height and the lines scroll in theirs; the sums to the foot take
  column 2. `closed` hides the lines and the pane is the right column
  alone, `min(100%, max(50%, 22rem))` wide at the column's right.
  `open` widens leftward to the full column; the right track is the
  same width shut or open, so nothing on the right moves. The width
  eases, not under reduced motion. Empty, the pane keeps the right
  column's width whatever its fold.
- `inline`: the same two columns at the page's width, every line
  showing, the foot across both.

**1200px and up**

- `column`: `.order-cart-slot` is the grid area beside the catalog,
  stretched to the area's height; the pane is `position: sticky; top:
  1rem; max-height: calc(100svh - 2rem)`; one column, everything
  showing, the lines scrolling inside with the pills; the heading and
  the pill hidden; Continue as wide as its words at the right; the
  height eases as lines come and go (`animateFold`).

The count and total in the phone top bar and in the lg to xl total
bar stay, with their tap back to the cart (James, #203, 2026-09-27).
They show once the settled cart has scrolled above the screen, as
today; the tap is one `scrollIntoView` to the heading, with no retry,
since a sticky pane keeps its place in the flow and nothing moves
under the glide.

### 4.5 The keyboard and the visual viewport

The pane is positioned against the layout viewport, which iOS does not
shrink for the keyboard. One `visualViewport` resize listener writes
three raw facts on the pane: `--cart-kb` (the keyboard's height when
120px or more is covered, `keyboardInset`), `--cart-vis` (the visible
height) and `--cart-gap` (the toolbar's share, `visibleArea`). The
stylesheet derives the floating pane's `bottom` and `max-height` from
them and nothing else; the script never reads them back for a layout
decision. With the keyboard up the pane's cap shrinks to the visible
room under the top bar, the body scrolls, and the pane sits at the top
of the screen under the bar, the state James asked to keep (#448).
One explicit scroll: when the inset grows while the code field has
focus, the field is brought into its scroller's view once; a
customer's own scroll is never pulled back. Placement does not change
while the keyboard is up.

Verified in a headless prototype (WebKit and Chromium, 320x568,
375x667, 390x664, 390x844, twelve lines, a stand-in visual viewport
300px shorter): the open sheet is two thirds of the visible height at
every size, the lines give way first to three rows and scroll, Hide
and Proceed stay inside the pane with the keyboard up, the field and
Apply are in reach after the one scroll, a body scroll is kept, and
the pane returns to its height when the keyboard drops. At 320x568
with the keyboard up the total row scrolls with the body (section 5).

### 4.6 Interactions kept

- The pill: Expand and Hide with James's icons, `aria-expanded`, keeps
  focus; Escape in the floating pane folds it and focuses the pill.
- "N more ↓" and "N more ↑" over the lines while they overflow, gliding
  to the next row (`moreStop`); fades at the list's edges.
- The shared row: the way opens into the switch, Add discount into the
  field and Apply; a pick, an accepted code, a tap or focus outside
  the row (`awayFrom`, the Safari rule), or Escape folds it.
- The first Add: open on the line, dwell, close, pulse (`cart-touch`
  judges a touch when it ends); later Adds: one pulse and the "Added:"
  strip when closed; the live region every time.
- Badges with tooltips; chicks from the badge that lights.
- The ring from the rail's Cart link; the top bar's and total bar's
  count and total once the settled cart is passed, and their tap back.
- The empty cart: lines, sums and badges hidden; the way and the code
  showing; a floating empty cart folds; the first item opens it.
- Edit mode: the Paid, kept fee and You pay rows under the total.
- The column eases its height as lines come and go.

### 4.7 Accessibility

- `aside#order-cart` named by its heading; `tabindex="-1"` for the
  rail's focus (the Safari rule in `awayFrom` stays).
- The count and total are text. The pill is the one disclosure, with
  `aria-expanded` and `aria-controls="order-cart-body"`, and it keeps
  focus through a press; Escape in the floating pane folds it and
  focuses the pill. Hidden parts are `display: none` (closed sheet,
  closed panel's lines, empty cart), so they leave the tab order and
  the accessibility tree without `inert`.
- The way and Add discount keep `aria-expanded` and `aria-controls`;
  the switch is a `role="group"` of `aria-pressed` buttons; the badges
  are buttons with tooltips.
- The code note, the nudge and the Add announcement are polite live
  regions.
- Inside the body every focus ring is drawn inside the control (the
  field's inset `box-shadow`, the buttons' inset ring, the badges'
  negative `outline-offset`), at every width, so the body's scroller
  never clips one (#448 round 3 made general).
- A control focused under the floating pane is scrolled clear of it
  and of the top bar (`clearFocusUnder`, WCAG 2.4.11).
- Reduced motion: no fold ease, no width ease, no pulse, no glide, no
  chicks, a still ring and a still pill emphasis; `_order.scss`'s
  global rule cuts every other transition to 1ms.

### 4.8 The mini cart

Per #402 (James, 2026-10-24) the dropdown goes with this rebuild: the
header's cart icon stays, shown while the cart holds items, as a link
to `/order/#order-cart` with its count badge on the cart side; the
Order link keeps its badge in the phone menu. `mini-cart.html`,
`mini-cart.js` and their styles are removed; `cart-badge.js`,
`announce.js` and `search/cart.js` stay. The cart link lands on the
cart and rings it as the rail's link does.

## 5. What changes for the customer, and why

Each change is named with the problem it solves, as #477 asks.
Everything not listed here looks and behaves as today.

| Change | Problem it solves |
| --- | --- |
| "N items" and "Total $X" are a readout at every width, not tabs or disclosure buttons. The pill is the one fold control. This reverses James's own pick of the segmented control on 2026-10-18 (#204, item 5, the day after his "half the controls" line), so it is his to overrule. | R1 and R6: the pair had four semantics by width (#278 item 3 and 5, round 3 item 2, round 5 item 4, round 6, #392 twice reverted). Round 6 already made it a readout from 576. |
| When the room is too short for the pane (the keyboard, a small phone), the body scrolls as a whole and the foot stays in reach. Today the parts under the total row scroll and the lines are squeezed. The total row scrolls with the body only while the keyboard is up on the smallest phones (320 by 568), against James's lines that the total is always visible (#180) and does not move (#203); with the keyboard down it is in view at every size. | R2: the measured floors and `data-tight` (#180, #389, #448 three times, #476 still failing). |
| The floating pane lifts off at a line set by a constant, at once; today it lifts off up to 370px later on the way up, and the seam can be off by a line if the nudge wraps. | R3: the clone measurement and the hidden-height memory. |
| The header's mini cart dropdown becomes a link to the cart with its badge. | James's decision on #402; one renderer of the lines less (R5). |
| Open parts are shown with `hidden`, not folded with a grid animation; the pane's height eases instead (the column already does). | R2: the fold wrappers between the parts and the pane are what forced the measurements. |

## 6. Tests

Unit (`test/`): `cart-state.test.mjs` for every transition and rule in
4.3, including the load state at every width, the empty rules, the
first Add, lift-off and settle thresholds; `cart-scroll.test.mjs` keeps
`moreStop`, `keyboardInset`, `visibleArea`, `ringsCart`; `rowsFloor`,
`paneFit`, `scrollIntoPane`, `look`, `floatAgain`, `segOn` and
`segShown` go with the code they served; `summary`, `totals`,
`cart-sync`, `cart-touch` and `share-away` stay.

End to end (`e2e/`), replacing the thirteen `cart-*` specs, named by
behavior and run in the desktop, phone and iphone projects:

- `cart-lines.spec.mjs`: lines, groups, ×, count, the pills and the
  glide, the first click after typing (#155).
- `cart-money.spec.mjs`: sums, tiers, group, code, pass, joke, fee
  cells, nudge, badges, chicks' origin, edit mode rows.
- `cart-way.spec.mjs`: the switch, the Safari tap, the link wins,
  Pickup days disabled, the code row's open, apply, refuse, fold.
- `cart-fold.spec.mjs`: the pill, Escape, the empty rule, the first
  Add's open, dwell, close and pulse, the touch judge, the "Added:"
  strip, reduced motion.
- `cart-float.spec.mjs`: at 390, 576, 768, 1024, 1199 and 1280, and
  844 by 390: placement on load, settle and lift-off at one line, the
  slot's height, the panel's two widths, the column's sticky and ease,
  short screens never floating, the top bar over the pane.
- `cart-keyboard.spec.mjs`: at 320 by 568, 375 by 667 and 390 by 844
  with the visual viewport 300px shorter, on both Chromium and WebKit:
  the field, Apply, Hide and Proceed in reach; the sums whole; a
  customer's scroll not pulled back; the round trip; whole rings.
- `cart-a11y.spec.mjs`: names, roles, `aria-expanded`, the live
  regions, hidden parts out of the tab order, the keyboard walk with a
  full cart (the #427 flake, fixed or explained).
- `cart-sync.spec.mjs` and `cart-badge.spec.mjs` stay, the latter
  losing its mini cart cases and gaining the cart link.

## 7. The split and the order of work

Two lanes, one branch to integrate on (`lane/cart1`), each on its own
until then. No file has two owners.

- **cart1: the model and the contract.** `cart/state.mjs` and its
  tests; `cart/cart.js`, the `Cart` class (the state, `render`,
  `added`, the callbacks, every write of content and attributes to the
  DOM); the extraction from `order-form.js` (render, added, code, way,
  checkout, the joke, edit mode); the mini cart's retirement and the
  cart link; `cart-lines`, `cart-money`, `cart-way`, `cart-sync`,
  `cart-badge` specs; `docs/order-form.md`'s cart section.
- **cart2: the view at every width.** `cart.html`, `_cart.scss` (the
  cart's rules out of `_order.scss` and `_variables.scss`), and
  `cart/view.mjs`: `watchPlacement` (the tick that feeds `place()` and
  the slot's placeholder), `watchKeyboard` (the three properties), the
  fold and width animations, the pills and fades with `moreStop`, the
  teach timing with `cart-touch`, the pulse, the ring, focus clearing,
  accessibility; `cart-fold`, `cart-float`, `cart-keyboard`,
  `cart-a11y` specs. The class imports `view.mjs` by these names:
  `watchKeyboard(pane, { onInset })`, `watchPlacement(pane, slot,
  { look })` returning `{ dispose, refresh }` (the tick feeds `look`
  exactly `place()`'s inputs and the class applies the result;
  `refresh()` recaches the height after a render or a fold),
  `animateFold(pane, apply, { reduced })` (the view measures before
  and after the class's `apply`), `watchList(list, wrap, { more,
  moreTop })` returning `{ sync, dispose }`, `teach(pane, pill, { dwell,
  onShut })` returning `{ keep, cancel }`, `pulsePill(pill, kind)`,
  `ringCart(pane)`, `showAdded(box, text)`, `clearFocusUnder(pane,
  bar)`, `revealLine(list, row)`.

Order: the skeleton and the markup first (both, one day), so each can
build against the other's shape; then in parallel; then the old pane's
code, styles and specs deleted together, in one commit, so nothing of
the old cart survives beside the new one.
