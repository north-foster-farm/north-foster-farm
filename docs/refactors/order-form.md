# Splitting `order-form.js`

The design James asked for under #782 (quality gates in the build)
before any code moves, read from `next` at `56268aba`.

`assets/scripts/order/order-form.js` is one class, `OrderForm`: 2,655
lines, 1,765 of them code, in 95 methods. Eighteen methods run past 25
lines (`watchSections` 87, `constructor` 73, `startEdit` 65,
`applyCode` 61, `restore` 59, `collect` and `renderGroupCard` 53), and
several nest past two levels. The file changed in 24 commits in two
weeks. Everything the order page does that is not the cart pane, the
payment section or the date lists happens here.

## 1. The file today

### What it does

Each part lists its methods, the unit tests that reach its logic, and
the e2e specs that pin its behavior. No unit test imports
`order-form.js`. Where a part has unit tests, they test the library it
calls.

**Boot.** `init`, `constructor`, `start`, `wire`, `changed`. Reads
`#order-data`, builds the collaborators, restores the draft, wires the
form's events, then loads dates, stock and payment.
e2e: `order-page`, `skeletons`, `order-layout`.

**Draft and cross-device cart.** `resume`, `restore`, `syncLines`,
`clearDetails`, and the scrub, pull and `storage` steps of `start`.
Unit: `cart-sync.test.mjs` (`draft.js`, `lib/cart-sync.mjs`).
e2e: `cart-sync`, `order-draft-date`, `cart-badge`, `sku-alias`,
`group-delivery-removed`, `typed-address`.

**The account.** `signedIn`, `hideSignInPrompt`, `prefill`. Applies
the discount group, perks, member line, credit and the customer's
details from `/api/me`, and watches for a sign-in or sign-out in
another tab.
e2e: `sign-in-order`, `typed-address`, `skeletons`, `perk-label`,
`perk-revision`, `host-member`, `placed-signed-in`.

**Changing a paid order.** `startEdit`, `keepBooked`, `bookedClosed`,
`hold`, `renderEdit`, `editRounds`, `locked`.
Unit: `kept-thursday.test.mjs`, `booked-day.test.mjs`,
`delivery-moved.test.mjs` (the libraries and the server's side).
e2e: `edit-order`, `edit-order-date`, `edit-switch`, `archived-edit`,
`kept-thursday`, `delivery-moved`, `missed-delivery`, `group-orders`.

**Quantities.** `qty`, `setQty`, `step`, `lines`, `lineDetails`,
`remove`, `clear`, and the `focusin` and `focusout` handlers.
e2e: `order-page`, `cart-lines`, `cart-one`, `cart-keyboard`,
`keyboard`, `remove-icon`, `restock`, `staging-toolbar`.

**Links into the page.** `methodFromQuery`, `chooseSeries`,
`addFromQuery`, `clearQuery`, and the `?group=` step of `start`.
Unit: `query.test.mjs`, `sku.test.mjs`, `sentence.test.mjs`.
e2e: `order-scheduled`, `map-link`, `map`, `cart-way`, `order-page`,
`sku-alias`, `restock`, `membership`.

**The section spy.** `watchSections`, `keepInRail`. Names the section
on screen in the rail, the phone bar and the total bar.
Unit: `sections.test.mjs` (`showing`).
e2e: `order-topbar-scroll`, `top-bar`, `skip-link`,
`catalog-visibility`.

**Phone and contact row.** `formatPhone`, `showContact`.
e2e: `forms`, `contact-card`, `order-layout`.

**Money.** `money`, `totals`, `lock`, `rules`, `perkTypes`,
`zipStatus`, `amount`. Gathers the arguments for `computeTotals` and
`validateOrder`.
Unit: `totals`, `money-change`, `perk-pricing`, `perk-checkout`,
`group-credit`, `passes`, `summary`, `minimum-tip` (all `.test.mjs`).
e2e: `pricing`, `cart-money`, `perk-label`, `group-credit`,
`delivery-pass`.

**Codes.** `applyCode`, `applyPass`, `dropPass`, `applyGroup`,
`unlockGroup`, `offerRounds`, `dropGroup`, `notMember`. One box takes
a discount code, the joke, a buying group's code or a delivery pass.
Unit: `passes.test.mjs`, `group-page.test.mjs` (libraries).
e2e: `group-code`, `delivery-pass`, `pass-order`, `group-orders`,
`host-member`, `group-credit`, `rate-limit`, `cart-fold`.

**Rendering.** `refresh`, `renderCart`, `renderScheduledCard`,
`renderGroupCard`, `renderWindows`, `renderCredit`, `renderZipNote`,
`revealMethod`, `pickWay`, `stockMoved`, `submitLabel`.
Unit: `order-ways`, `scheduled`, `pickup-days`, `window-label`,
`summary` (libraries).
e2e: `order-scheduled`, `pickup-days`, `pickup-days-revision`,
`pickup-days-revision-2`, `pickup-horizon`, `onfarm-times`,
`window-label`, `group-orders`, `round-card-ring`, `cart-way`,
`pricing`, `stock-failure`.

**Checking and the way to Pay.** `check`, `revalidate`, `prepare`,
`prepareAsync`, `proceed`, `showErrors`, `goTo`, `lapse`, `useLapsed`,
`otherWay`.
Unit: `validate`, `pickup-time-message`, `stock-ready`, `stock-gate`.
e2e: `forms`, `checkout-go`, `place-order-pane`, `pay-focus`,
`keyboard`, `stock-failure`, `onfarm-times`, `order-scheduled`,
`picker-out`, `wallets`.

**Sending.** `submit`, `deliver`, `pay`, `venmoCreate`,
`venmoCapture`, `paid`, `settle`, `setBusy`, `billing`,
`referenceId`, `paymentReady`.
Unit: `submit.test.mjs` (`submit.js`), `venmo-gate.test.mjs`.
e2e: `payment`, `fake-payments`, `wallets`, `venmo-paid`,
`venmo-restart`, `recovery`, `rate-limit`, `busy-buttons`.

**The result panels.** `succeed`, `fail`, `finish`, `when`,
`pickupAt`, `orderType`, `dateTime`, `pickupAddress`, `summaryText`,
`paidWith`, `contactLinks`.
e2e: `placed-panel`, `placed-overflow`, `placed-signed-in`,
`recovery`, `kept-thursday` (the failed card), `report-privacy`.
No spec opens the locked card (`#order-locked`).

### State

All of it is fields on the one instance, read and written from any
method.

- **Page data, fixed after load:** `form`, `catalog`, `aliases`,
  `index`, `contact`, `codes`, `raw`, `dropSeries`, `drop`.
- **Terms:** `terms` (prices, area, time zone, the pickup model). It
  is replaced when a group is unlocked or dropped (`withPlaces`).
- **What prices the order:** `code`, `pass`, `passFee`, `group` (the
  discount group), `perks`, `credit`, `ownCredit`.
- **Buying group:** `member`, `roundGroup`, `groupCode`,
  `groupLinked`, `joinConfirmed`, `shownMember`, `termTips`.
- **Session:** `isSignedIn`.
- **A paid order being changed:** `editId`, `editing` (`id`, `held`,
  `kept`, `keptDate`, `placed`, `booked`).
- **Choices waiting for the lists:** `wantedWindow`,
  `wantedOccurrence`, `wantedSeries`.
- **Flags of the moment:** `busy`, `preparing`, `typing`, `adding`,
  `quietMethod`, `moved`, `covered`, `total`.
- **Collaborators:** `errors`, `draft`, `dates`, `lapsed`,
  `submitter`, `stock`, `cart`, `pending`, `payment`, and four
  elements (`saveButton`, `submitButton`, `stockNotice`, `result`).

The quantities, the way, and every typed value live in the DOM and
nowhere else. `refresh()` reads them, computes the totals and redraws.
Nine fields are first assigned outside the constructor: `ownCredit`,
`covered`, `total`, `moved`, `preparing`, `adding`, `quietMethod`,
`wantedSeries`, `groupLinked`.

### DOM

Read or written here, by region
(`layouts/partials/order/*.html`):

- **Page:** `#order-data`, `#order-form[data-version]`, the class
  `order-busy`.
- **Catalog rows:** `[data-qty]` (value property and attribute),
  `input[data-max]`, `.order-qty[data-qty-state]`, `[data-step]`,
  `.order-item[data-archived|data-held|data-out]`, the class
  `order-qty-tick`.
- **Ways:** the `[name=method]` radios (`#method-onfarm`,
  `-scheduled`, `-delivery`, `-group`), `[data-method-body]` (made
  inert), `[data-dates]`, `[data-windows]` from `#tpl-window`,
  `[data-scheduled-facts|count|none]`, `#tpl-group-way` and its
  `[data-group-way|when|where|close]`, `.order-method-title`,
  `[data-zip-note]`, `[data-delivery-short]`.
- **Contact:** `[data-field="customer.*"]`, `[data-prefill]`,
  `[data-prefill-region]`, `[data-contact-row][data-shown]`,
  `[data-phone-optional]`, `[data-signin-prompt]`,
  `[data-farm-list-block]`, `[name=website]`.
- **Pay:** `#payment` (hidden, and its legend focused), `#confirm`,
  `#order-submit`, `#order-save`, `[data-credit-note]`,
  `[data-lapsed-status]`.
- **Notices:** `#order-added`, `#order-stock`, `#order-editing`,
  `#order-result`.
- **Templates:** `#order-success`, `#order-failed`, `#order-locked`,
  filled through `[data-out]`.
- **Chrome:** `#order-nav` links (the class `active`),
  `.order-topbar[data-stuck]`, `.order-total-bar`,
  `[data-topbar-title]` and its parent's `data-cat`,
  `.page-heading h1`, `#order-cart-heading`, `#order-catalog`,
  `.order-cat`.

It leaves alone what its collaborators own: `#order-cart` (`Cart`),
the inside of `#payment` (`Payment`), `#order-lapsed` (`Lapsed`), the
date pickers' options (`DateLists`), the error slots (`Errors`),
`#order-pending` (`Pending`).

### Events, timers, requests

Listens:

- `document`: `DOMContentLoaded`.
- the form: `input`, `change`, `submit`, `click`, `focusin`,
  `focusout`. The phone field: `input`. `#order-save`: `click`.
- the rail's Cart link: `click`.
- `window`: `hashchange`, `scroll` (passive), `resize`, `storage` for
  the draft's key, `nff:draft-scrubbed`; through `watchSignIn`,
  `visibilitychange`, `focus`, `pageshow` and `storage`.

Sends:

- a bubbling `change` on a method radio (`pickWay`);
- `nff:cart` through `announceCart(count)`, which the header's badge
  hears;
- `nff:draft` through `Draft.save` and `Draft.clear`, which
  `session/cart-sync.js` hears.

Timers: 3,000 ms before the one resend, 240 ms before `revealMethod`
scrolls, 300 ms before `?add=` shows the cart, 2,000 ms of "Copied",
one animation frame per scroll in the spy, two for the contact row.

Requests of its own: `GET /api/account/orders`, `POST /api/group`,
`GET /api/pass`, `/api/me` through `me()`, the order through
`Submitter` (`POST /api/orders`, or
`/api/account/orders/<id>/edit`), and a beacon to `/api/health`.

It navigates four ways: to `/login/?next=` and `/account/#orders`
with `location.replace`, to `/account/#orders` with `location.assign`
after a paid change, a `location.reload()` when the account signs out
in another tab, and `history.replaceState` to clear a query it used.

For the farm it leaves three crumbs (`pay.press`, `pay.ok`,
`pay.failed`), one `console.error` line (`order.undeliverable`) and
the beacon (`kind: "checkout.failed"`).

### Imports and importers

`order/main.js` is the only importer, and calls `OrderForm.init()`.

It imports 16 pure libraries from `order/lib/`, the collaborators
beside it (`cart/cart.js`, `cart/perk-label.js`, `celebrate.js`,
`date-lists.js`, `draft.js`, `errors.js`, `lapsed.js`, `pay.js`,
`pending.js`, `report.js`, `restock.js`, `stock.js`, `submit.js`),
and from outside the folder `cart-badge/announce.js`,
`group/join-dialog.js`, four `session/` modules and five `utils/`
modules.

Two collaborators call back into it by name:

- **`Payment`** is given the whole form and uses eleven members:
  `amount()`, `prepare()`, `prepareAsync()`, `pay()`, `billing()`,
  `referenceId()`, `paymentReady()`, `venmoCreate()`,
  `venmoCapture()`, `contact.name` and `stock.locked`.
- **`Cart`** is given six callbacks (`onRemove`, `onClear`, `onWay`,
  `onCode`, `onCheckout`, `onBlocked`) and is driven through
  `render`, `added`, `setMoney`, `setPerks`, `codeResult`,
  `codeValue`, `setCodeValue`, `startJoke`, `stopJoke` and `show`
  (`docs/cart.md` 4.1).

Other code reaches the page without importing it:
`cart-badge/count.js` sums `#order-form [data-qty]`, and
`session/cart-sync.js` stands aside when `#order-form` exists.
`test/group-delivery-removal.test.mjs` reads this file's source for
`postedDelivery`.

## 2. The target

`order-form.js` stays, as the root that builds the parts and answers
`Payment` and `Cart`. Its work moves into `assets/scripts/order/form/`.
The folder is new because `order/lib/**` is shared with the server
and marked so in `e2e/dispatch.json`, where a change selects every
spec. These modules belong to the page alone.

Three kinds of module:

- **Pure** (`.mjs`): data in, data out. No DOM, no clock, no request.
  Tested with `node --test`.
- **Dumb** (`.js`): given an element and plain data, it writes the
  DOM, or reads it into plain data. It holds nothing and decides
  nothing.
- **Smart** (`.js`): holds state, hears events, asks the server, and
  calls the other two.

### Modules

Sizes are code lines, estimated. Every file sits well under 300.

Pure:

```
form/page-data.mjs     pageData(json), editIdFrom(search)           45
form/order-state.mjs   initialState, createStore, the transitions  160
form/pricing.mjs       pricesOn, lockOf, rulesOf, perkTypes,
                       totalsArgs, checkOptions, amountDue          90
form/payload.mjs       buildPayload, restorePlan, billingOf,
                       lineTargets                                 170
form/quantity.mjs      parseQty, stepTo, qtyState, minusLabel       30
form/phone.mjs         maskPhone                                    20
form/add-query.mjs     parseAdd, addNotice                          45
form/section-pick.mjs  barEdge, pickSection, inCatalog, barTitle    60
form/ways.mjs          scheduledCard, groupCard, windowsPlan,
                       zipNote, creditNote                         130
form/codes.mjs         passCode, joinAsks, codeWords                70
form/edit.mjs          editingFrom, pricedPerks, editDraft,
                       bookedClosed, editButtons                    60
form/checkout.mjs      nextStep, roundWording, lapseList,
                       lapsedStatus, paymentFor, invalidRoute       80
form/placed.mjs        paidWith, when, pickupAt, dateTime,
                       pickupAddress, isRound, summaryText,
                       contactHrefs, failureBeacon                 120
form/hash.mjs          sha256                                       10
```

Dumb:

```
form/dom.js            qs, all, pulse                               15
form/fields.js         readFields, writeFields, clearDetails,
                       way, zip                                     90
form/ways.js           drawScheduledCard, drawGroupCard,
                       drawWindows, drawZipNote, drawCreditNote,
                       drawBodies, drawQuantities                  170
form/result.js         showPlaced, showFailed, showLocked           150
form/section-spy.js    watchSections                               110
```

`section-spy.js` owns a scroll listener and the last link it marked.
It knows nothing of the order, so it counts as dumb.

Smart:

```
form/quantities.js     Quantities: read, set, step, remove, clear,
                       hold, the typing box                        100
form/contact.js        Contact: the mask, the contact row, prefill  55
form/links.js          Links: ?method ?series ?add ?group           90
form/restore.js        Restore: resume, apply a plan, syncLines     80
form/view.js           View: refresh, renderCart, stockMoved        90
form/codes.js          Codes: apply, pass, group, rounds, drop     150
form/account.js        Account: signedIn                            70
form/edit.js           Edit: start, keepBooked, draw                110
form/checkout.js       Checkout: check, revalidate, prepare,
                       prepareAsync, proceed, showErrors           150
form/lapse.js          Lapse: lapse, use, otherWay                  60
form/send.js           Send: submit, deliver, venmo, paid,
                       settle, setBusy, submitLabel                190
order-form.js          OrderForm: init, build, start, wire,
                       changed, Cart's callbacks, Payment's port   220
```

That is 31 modules, 30 of them new, and by these estimates about
3,000 lines for today's 1,765. The growth is function headers,
imports and exports: the price of 25-line functions.

### How state moves

```
event or answer
  -> a smart module
       store.set(transition(store.get(), ...))    order-state.mjs
       refresh()                                  view.js
         snapshot = readFields(form)              fields.js
         totals   = computeTotals(totalsArgs(state, snapshot))
         facts    = scheduledCard(...), groupCard(...), ...
         draw*(element, facts)                    ways.js
         cart.render(summarize(...), ...)
       draft.save(buildPayload(snapshot, state))
```

- **The store** holds one frozen record: terms, what prices the
  order, the buying group, the session, the edit, the waiting
  choices. A transition is a pure function from one record to the
  next (`codeApplied`, `codeCleared`, `passAccepted`, `passDropped`,
  `groupUnlocked`, `groupDropped`, `roundsOffered`, `accountLoaded`,
  `editOpened`). Setting the store draws nothing. The caller calls
  `refresh()` as it does today, so the count and order of redraws do
  not change.
- **The DOM stays the model for what the customer types.**
  `readFields` is the one reader. Nothing else queries a field's
  value.
- **Flags stay with their owner:** `typing` and `adding` in
  `Quantities`, `busy` and `preparing` in `Send`, `quietMethod` in
  the root, `moved` in `Checkout`, `covered` in `View`. A module that
  needs another's flag reads it through a getter.
- **Each smart module names what it needs.** The root builds one
  `app` object (the form, the page data, the store, the
  collaborators, and `refresh`, `changed`, `collect`), and each
  constructor destructures only its own part, so the first line of a
  class is its list of dependencies.
- **Page data** is frozen at load and passed by reference.

### What stays as it is

- `OrderForm.init()` and the name `OrderForm`.
- `Payment`'s port. The root keeps the eleven members `pay.js` uses,
  under the same names, each a one-line call into `Checkout`, `Send`
  or `pricing`. `pay.js` is not edited. Its own design narrows the
  port.
- `Cart`'s callbacks and methods, unchanged (`docs/cart.md` 4.1).
- `Errors`, `Draft`, `DateLists`, `Lapsed`, `Submitter`, `Stock`,
  `Pending`: not edited.
- Every library in `order/lib/`.
- No new package. Dumb modules are tested by e2e, as now. The suite's
  hand-built element doubles (`test/stock-ready.test.mjs`) serve for
  a smart module driven with fakes.

## 3. The phases

Rules for every phase:

- One implementer carries the whole series (James: refactoring is
  not split across agents). A test agent writes each phase's criteria
  tests first, from the criteria given here, word for word, one test
  per criterion, and delivers them as a patch.
- A phase is one commit and one pull request into `next`. It changes
  nothing a customer can see. A bug met on the way is its own commit,
  before or after, never inside a move.
- A new file meets every limit of #782 (quality gates in the build)
  in the commit that adds it: functions of 25 lines, 4 parameters, 2
  levels of nesting, cognitive complexity 15. `order-form.js` shrinks
  with each phase and meets them at the last.
- Before the commit: `npm run check`, through `run-heavy.sh`, and a
  Hugo build.
- After it: the full e2e suite in Actions, as James ruled, at most
  one run an hour. `bin/nff e2e` on the phase's branch selects the 95
  specs mapped to `assets/scripts/order/**`. The specs named under a
  phase pin what it moved: read them first when the run fails, and
  rerun only those after a fix.
- Notes move with the code: the template comments that name an
  `order-form.js` function, "The page" in `docs/order-form.md`, and
  4.1 in `docs/cart.md`.

Before phase 1, #812 (scroll once when `?add=` opens the cart) lands.
It edits `addFromQuery`. Before phase 4, the fix for #814 (the
`order.undeliverable` console line never carries its idempotency key)
lands. It edits `fail()`.

### Phase 1: helpers and the section spy

Moves `qs`, `all`, `pulse` to `form/dom.js`; `keepInRail` and
`watchSections` to `form/section-spy.js`, with the choice of section
drawn out into `form/section-pick.mjs`. `wire()` calls
`watchSections()`.

Criteria (`section-pick.mjs`):

1. `barEdge` returns the lowest bottom edge among the bars that are
   shown and stuck (top within 1 px of the screen's top), and 0 when
   there is none.
2. `pickSection` passes over a section that is stuck, one that is not
   shown, and the cart when the cart is a column.
3. A section is current once its top reaches the line. Of two that
   have, the lower one wins, and on a tie the later link.
4. At the foot of the page the last section on screen wins, though
   its top never reached the line.
5. `inCatalog` names the category of the first row showing below the
   bar when that row is on screen, the catalog itself when every row
   has gone above the bar, and otherwise keeps the section it was
   given.
6. `barTitle` gives the phone bar a category's name or nothing, and
   the other bars the section's name.

Stay green: `sections.test.mjs`.
e2e: `order-topbar-scroll`, `top-bar`, `top-bar-places`, `skip-link`,
`catalog-visibility`, `keyboard`.

### Phase 2: phone and contact row

Moves `formatPhone`, `showContact`, `prefill` and the phone field's
listener to `form/contact.js`; the mask to `form/phone.mjs`.

Criteria (`maskPhone(raw, deleting)`):

1. Up to three digits read `(401`; four to six, `(401) 555`; seven to
   ten, `(401) 555-1234`. No digits give an empty string.
2. Eleven digits that begin with 1 lose the 1.
3. Digits past the tenth are dropped.
4. Every character that is not a digit is ignored.
5. While deleting, a value that ends on a bracket, space or dash
   loses the digit before it.

e2e: `forms`, `contact-card`, `order-layout`, `sign-in-order`,
`typed-address`, `skeletons`.

### Phase 3: links into the page

Moves `methodFromQuery`, `chooseSeries`, `clearQuery`, `addFromQuery`
and the `?group=` step to `form/links.js`; the parsing and the notice
to `form/add-query.mjs`.

Criteria (`add-query.mjs`):

1. `parseAdd("A:2,B")` gives A twice and B once.
2. A quantity that is missing, zero or not a number is 1, and one
   over 99 is 99.
3. `addNotice` with items added says "Added to your cart:" and each
   as `2 × Name`, in the success tone.
4. With none added and some unavailable it says "Not available:" and
   their names, in the warning tone.
5. An unknown SKU adds the sentence about items that have changed,
   and names no SKU.
6. With nothing to say the notice is hidden.

Stay green: `query.test.mjs`, `sku.test.mjs`, `sentence.test.mjs`.
e2e: `order-page`, `sku-alias`, `restock`, `order-scheduled`,
`map-link`, `map`, `cart-way`, `membership`, `group-code`.

### Phase 4: the result panels

First, in a commit of its own, the test agent writes an e2e spec for
the locked card, which no spec opens: a change the server refuses
with `errors.order` shows `#order-locked` with the server's message
and the farm's email and phone, and clears the edit's draft.

Then `when`, `pickupAt`, `dateTime`, `pickupAddress`, `orderType`,
`summaryText`, `paidWith` and the links' hrefs move to
`form/placed.mjs`; `succeed`, `fail`, `locked`, `finish`,
`contactLinks` and the beacon to `form/result.js`.

Criteria (`placed.mjs`):

1. `paidWith` names Apple Pay, Google Pay, Cash App Pay and Venmo. A
   card reads as its brand in title case with "ending" and its last
   four digits, or as the brand alone, or as "Card".
2. `when` for a delivery is the day and "delivered to" the first
   address line.
3. `when` for a pickup day is the day, the occurrence's hours and its
   place. The drop site's series reads "the drop site".
4. An occurrence the lists no longer hold reads "at the pickup you
   chose".
5. A draft saved as `scituate` reads as the drop site's own hours.
6. `when` for on-farm pickup is the day, the window in full and "at
   the farm".
7. `dateTime` is the day, then the window that belongs to the way.
8. `pickupAddress` is the farm's address for on-farm pickup, the
   location's street, city and state for a pickup day, and empty for
   a delivery.
9. `isRound` is true only for a scheduled pickup whose occurrence
   belongs to the offered group's series.
10. `summaryText` is the customer's name and address, the `when`
    line, a line for each item with its price, and the total.
11. `contactHrefs` gives a `mailto:` only for an address that looks
    like one, encoded, with the subject and any body, and a `tel:`
    only for a plain number.
12. `failureBeacon` carries `kind: "checkout.failed"`, the message,
    the way and the page's path, and nothing of the customer.

Stay green: `window-label.test.mjs`, `email-rule.test.mjs`.
e2e: `placed-panel`, `placed-overflow`, `placed-signed-in`,
`payment`, `fake-payments`, `recovery`, `kept-thursday`,
`report-privacy`, `venmo-paid`, and the new locked-card spec.

### Phase 5: one record for the order's state

Adds `form/page-data.mjs` and `form/order-state.mjs`. The constructor
splits into builders of 25 lines or fewer. Every loose state field
becomes a key of the store's record. No transition yet: writes are
`store.set({ ...patch })`. `contact` and `stock` stay readable on the
root for `Payment`. This is the widest diff of the series and the
most mechanical.

Criteria:

1. `pageData` builds the pickup model from the page's locations and
   series, and names the drop site's series and its record.
2. `pageData` gives an empty list for missing codes and an empty map
   for missing aliases.
3. `editIdFrom` takes 1 to 32 letters, digits and hyphens from
   `?edit=`, and gives null for anything else or nothing.
4. `initialState` has no code, pass, member, group or credit, no
   perks, is signed out, and is not editing.
5. `createStore` returns the record it was given, replaces it on
   `set`, and never changes a record it has handed out.

e2e: every spec named in this document.

### Phase 6: money

Moves `money`, `lock`, `rules`, `perkTypes`, `totals`, `zipStatus`,
`amount` and the options of `check` to `form/pricing.mjs`. Deletes
`eligible()`, which has no caller.

Criteria (`pricing.mjs`):

1. `pricesOn` gives the prices in force today in the farm's zone,
   and for an order being changed, those of the day it was placed.
2. `lockOf` is null with no member or no lock. Otherwise it is the
   member price for that same day, through the lock's last day.
3. `rulesOf` sets the delivery minimum to 0 for a pass or a perk
   that lifts it, and changes nothing else.
4. `totalsArgs` waives the fee only for a pass that waives it.
5. `totalsArgs` counts no credit while an order is being changed.
6. `totalsArgs` gives a ZIP status only when the way is delivery.
7. `amountDue` is the total for a new order. For a change it is the
   total less what is held, plus a kept fee, and never below 0.
8. `checkOptions` passes the day the order was placed and its booked
   day, and waives as the pass says.

Stay green: `totals`, `money-change`, `perk-pricing`,
`perk-checkout`, `group-credit`, `passes`, `summary`, `minimum-tip`,
`validate`.
e2e: `pricing`, `cart-money`, `perk-label`, `perk-revision`,
`group-credit`, `delivery-pass`, `pass-order`, `edit-order`,
`missed-delivery`.

### Phase 7: fields, payload, restore

Moves `collect` to `readFields` (`form/fields.js`) and `buildPayload`
(`form/payload.mjs`); `restore` to `restorePlan` and
`form/restore.js`, with `resume` and `syncLines`; `billing` to
`billingOf`; `clearDetails` to `fields.js`.

The test agent also moves the source check in
`test/group-delivery-removal.test.mjs` from `order-form.js` to
`form/payload.mjs`. That is a change to an expectation, so it is the
test agent's, in its patch.

Criteria (`payload.mjs`):

1. Group orders posts as `scheduled` with its round as `occurrence`.
   Every other way posts `date`.
2. The delivery block is `postedDelivery`'s and never carries
   `toGroup`.
3. `code` is the applied code, or else the typed one normalized.
4. `groupLink` is set only with a group code that came by a link.
5. `marketing` is false whenever the opt-in block is hidden.
6. `restorePlan` turns a draft's `scituate` into a scheduled pickup
   at the drop site's series.
7. A draft with the group's delivery ticked comes back with the
   address blank and the notes kept. A paid order being changed keeps
   its address.
8. A draft's SKUs are brought up to date through the aliases. A paid
   order's are taken as they are.
9. A draft's round of the offered group chooses Group orders.
10. A draft's pass and group code are asked about again, and neither
    is for a paid order being changed.
11. A value the draft lacks leaves its field alone.
12. `billingOf` carries the address only for a delivery, with the
    state its ZIP belongs to.
13. `lineTargets` gives each row its quantity from the saved lines,
    0 to 99, and 0 for a row the lines lack.

Stay green: `cart-sync`, `group-delivery-removal`, `sku`,
`scheduled`, `order-ways`.
e2e: `cart-sync`, `order-draft-date`, `sku-alias`,
`group-delivery-removed`, `typed-address`, `sign-in-order`,
`cart-badge`, `recovery`, `edit-order`, `edit-order-date`,
`edit-switch`, `scheduled-pickup`.

### Phase 8: quantities

Moves `qty`, `setQty`, `step`, `lines`, `lineDetails`, `remove`,
`clear`, `hold` and the two focus handlers to `form/quantities.js`;
the arithmetic to `form/quantity.mjs`. `Stock` still gets `setQty`.

Criteria (`quantity.mjs`):

1. `parseQty` reads the digits of what was typed, between 0 and 99,
   and 0 for none.
2. `stepTo` adds the step and holds the result between 0 and the
   row's maximum, which is 99 unless the row is held.
3. `qtyState` is `active` above 0 or while the box is being typed
   in, and `empty` otherwise.
4. `minusLabel` is "Remove" at 1 and "One fewer" otherwise.

e2e: `order-page`, `cart-lines`, `cart-one`, `cart-keyboard`,
`keyboard`, `remove-icon`, `cart-badge`, `restock`, `archived-edit`,
`staging-toolbar`, `cart-a11y`.

### Phase 9: the way cards and the redraw

Moves the facts of `renderScheduledCard`, `renderGroupCard`,
`renderWindows`, `renderZipNote` and `renderCredit` to
`form/ways.mjs`, their writes to `form/ways.js`, and `refresh`,
`renderCart` and `stockMoved` to `form/view.js`.

Criteria (`ways.mjs`):

1. `scheduledCard` with an empty list cannot be chosen. With pickups
   it counts their locations in `locationsLabel`'s words.
2. `groupCard` with a round open gives the series' rhythm for When
   and the first round's closing line.
3. With none open it marks the heading "no open group order", gives
   the day the next round opens for When, and cannot be chosen.
4. Before the lists come it reads as open.
5. Where is the place's short name, or its name and city.
6. `windowsPlan` keeps the chosen time when the new day has it, and
   chooses none otherwise.
7. A day with no windows says "No pick-up times on this day." once
   the lists are here, and "Loading times…" before.
8. `zipNote` outside the area says so and is marked as a warning.
9. An unlisted ZIP names the extra fee from the day's prices.
10. A state that takes only some products names them and the state,
    and is marked as a warning.
11. `creditNote` for a family order with nothing to pay says so and
    is covered.
12. Credit that covers the order says what it covers. Credit that
    covers part says what comes off and what is left. No credit
    hides the note.

Stay green: `order-ways`, `scheduled`, `pickup-days`, `group-page`,
`window-label`, `pickup-hyphen`, `summary`.
e2e: `order-scheduled`, `pickup-days`, `pickup-days-revision`,
`pickup-days-revision-2`, `pickup-days-status`, `pickup-horizon`,
`onfarm-times`, `window-label`, `group-orders`, `round-card-ring`,
`cart-way`, `group-credit`, `pricing`, `cart-money`, `stock-failure`.

### Phase 10: codes

Moves `applyCode`, `applyPass`, `dropPass`, `applyGroup`,
`unlockGroup`, `offerRounds`, `editRounds`, `dropGroup` and
`notMember` to `form/codes.js`; the shapes and the words to
`form/codes.mjs`; `sha256` to `form/hash.mjs`. The first transitions
enter `order-state.mjs`.

Criteria:

1. `passCode` strips what is not a letter or digit, upper-cases, and
   returns `XXXX-XXXX` for exactly eight characters, else null.
2. `joinAsks` is true only for a group found by a code the customer
   has not said Join to, who is neither in it nor in another.
3. `codeWords` for a discount is "Code applied: $N off."
4. For a group it is the welcome, "You're already in the group." for
   a member, and the stays-in-your-own-group line for a member of
   another.
5. For a pass that waives the fee it is "Applied."; for one that
   does not, it names the day's minimum.
6. A refused code says "That code isn't valid." unless the server
   sent its own words, and nothing when it was applied quietly.
7. `codeCleared` takes the code off, and the pass too unless an
   order is being changed.
8. `groupUnlocked` sets the member, the code and the credit.
9. `groupDropped` clears the member, the rounds' group and the code,
   and puts the account's own credit back.
10. `sha256` of a known string is its known digest in hex.

The order of the tree is unchanged: empty, the joke, a known hash, a
group for six characters or more, then a pass. A paid order being
changed tries neither group nor pass.

Stay green: `passes`, `group-page`, `cart-code`.
e2e: `group-code`, `delivery-pass`, `pass-order`, `group-orders`,
`host-member`, `group-credit`, `membership`, `rate-limit`,
`cart-fold`.

### Phase 11: the account and a paid order's change

Moves `signedIn` and `hideSignInPrompt` to `form/account.js`;
`startEdit`, `keepBooked`, `hold` and `renderEdit` to `form/edit.js`;
their decisions to `form/edit.mjs` and two transitions.

Criteria:

1. `editingFrom` holds what was paid less what was refunded, the
   kept fee and its date, the day placed and the booked day.
2. `pricedPerks` keeps the order's perks the account still holds,
   and all of the order's when the account gave no answer.
3. `editDraft` is the order's customer, lines, fulfilment and code,
   with the account's email where the order has none.
4. `bookedClosed` is true only for a delivery on the booked day,
   past that day's cutoff.
5. `editButtons` with nothing more to pay hides the payment section
   and shows Save. With more to pay it shows the section, and Pay
   only while the card is open.
6. `accountLoaded` sets the discount group and marks the page
   signed in.
7. It lays the account's perks and member line over the order,
   except on a paid order being changed.
8. It asks for the account's group when the account has one, none is
   unlocked, and no order is being changed.
9. It applies the account's own credit only with no group unlocked
   and no order being changed.

Stay green: `kept-thursday`, `booked-day`, `delivery-moved`, `edit`.
e2e: `edit-order`, `edit-order-date`, `edit-switch`, `archived-edit`,
`kept-thursday`, `delivery-moved`, `missed-delivery`, `group-orders`,
`sign-in-order`, `typed-address`, `skeletons`, `perk-label`,
`perk-revision`, `host-member`, `placed-signed-in`.

### Phase 12: checking and the way to Pay

Moves `check`, `revalidate`, `prepare`, `prepareAsync`, `proceed`,
`showErrors` and `goTo` to `form/checkout.js`; `lapse`, `useLapsed`
and `otherWay` to `form/lapse.js`; their decisions to
`form/checkout.mjs`. `prepare()` stays synchronous: a wallet must
tokenize inside its click.

Criteria (`checkout.mjs`):

1. `nextStep` with an error under `fulfilment.`, `onfarm.` or
   `delivery.` is the way, with only those errors.
2. With none of those and an error under `customer.` it is the
   contact section, with only those.
3. With neither it is the payment.
4. `roundWording` rewords a missing occurrence as "Choose a group
   order date." only when Group orders is chosen.
5. `lapseList` offers a lapsed round the group's open rounds, a
   lapsed pickup day the other pickups, and any other way the dates
   the server sent.
6. `lapsedStatus` names the new day, with the round's own label for
   a group, the times for on-farm pickup, the place for a pickup
   day, and ends "Pay again to place your order."

Stay green: `validate`, `pickup-time-message`, `stock-ready`,
`stock-gate`.
e2e: `forms`, `checkout-go`, `place-order-pane`, `pay-focus`,
`keyboard`, `stock-failure`, `order-draft-date`, `onfarm-times`,
`order-scheduled`, `group-orders`, `round-card-ring`,
`kept-thursday`, `wallets`, `picker-out`.

### Phase 13: sending

Moves `submit`, `deliver`, `pay`, `venmoCreate`, `venmoCapture`,
`paid`, `settle`, `setBusy` and `submitLabel` to `form/send.js`.
`settle`'s switch becomes a table of one handler per outcome.
`Send` takes its collaborators as arguments, so the test agent drives
it with fakes and Node's mock timers.

Criteria:

1. `paymentFor` is none for a change with nothing more to pay,
   credit when credit covers the order, and the card otherwise.
2. `invalidRoute` sends a refused pass to the pass, a refused group
   code to the group, and anything else to the fields.
3. A send that cannot get through is sent once more, 3 seconds
   later, with the same payload.
4. A second failure to get through shows the failed card and sends
   nothing more.
5. A declined payment and a payment that disagrees with its order
   each start a new attempt and say why by Pay.
6. A stale answer opens the lapsed dialog for the chosen way.
7. A refusal that locks a paid order shows the locked card. Any
   other failure shows the failed card.
8. A paid new order clears the draft and zeroes the header's count.
   A paid change clears its draft and goes to the account's orders.
9. One crumb is left on the press, and one on the answer: `pay.ok`
   or `pay.failed`.

Stay green: `submit`, `venmo-gate`, `report`, `sourcemaps`.
e2e: `payment`, `fake-payments`, `wallets`, `venmo-paid`,
`venmo-restart`, `recovery`, `rate-limit`, `busy-buttons`,
`stock-failure`, `delivery-pass`, `group-code`, `group-credit`,
`edit-order`, `report-privacy`.

### Phase 14: the root

What is left of `order-form.js` is tidied to the limits: `start()`
becomes a list of named steps in today's order, `wire()` a list of
listeners, each handler a call into a part. The file comes off the
legacy lists of #782 (quality gates in the build). The comments in
six specs and `e2e/support/order.mjs` that name an `order-form.js`
function are brought up to date.

No criteria tests: nothing new is decided here.
e2e: every spec named in this document.

## 4. What must not change

- **The order of `start()`.** Scrub a stray draft, restore this
  browser's draft, pull the account's copy, hear `storage`, take the
  links, load the dates, apply a linked or saved code quietly, draw,
  start stock, start payment, ask `/api/me`, watch for a sign-in.
  Several steps hold their place because of a bug fixed there.
- **Storage.** The keys `nff-order-draft`, `nff-order-pending`,
  `nff-edit-<id>` and `nff-edit-<id>-pending`, and the draft's shape
  (`payload`, `savedAt`, `key`, `attempt`, `attempted`, `owner`). A
  draft saved by today's page must restore on the split one,
  `scituate` and `toGroup` included.
- **The payload** posted to `/api/orders` and the edit endpoint,
  field for field, with `idempotencyKey` and `attempt`.
- **Events:** `nff:cart` with the count on every redraw of a new
  order, `nff:draft` on every save, the `storage` listener keyed to
  the draft's name, `nff:draft-scrubbed`.
- **The DOM other code reads:** `id="order-form"` (the uptime
  monitor, the badge, cart sync) and a quantity's value as both
  property and attribute (the badge and the stylesheet).
- **Observability:** the three crumbs, the `order.undeliverable`
  line, the `checkout.failed` beacon and what it leaves out.
- **Accessibility:** focus after a step (the plus button on a first
  add, the row at zero), the minus button's label, `inert` on the
  ways not chosen, `required` on the phone for delivery, focus on the
  first field in error without a scroll, focus on Pay after the
  lapsed dialog, the rail scrolled within its own box and never with
  `scrollIntoView`.
- **Timing the specs wait on:** 240 ms before a chosen way scrolls,
  300 ms before `?add=` shows the cart, 3,000 ms before the resend.
- **`prepare()` is synchronous,** and a second press during
  `prepareAsync` is ignored.
- **Requests:** none added, none dropped, none reordered. The page
  asks `/api/group` and `/api/pass` exactly when it does now.
- **Wording.** Every string moves byte for byte. Several are drafts
  awaiting James, and a move is no occasion to settle them.
- **Imports into `order/form/`.** Only `order-form.js` and the
  folder's own modules import from it. A shared script that imported
  one would have to add it to `shared` in `e2e/dispatch.json`
  (`test/e2e-dispatch-table.test.mjs`).

The largest risk is phase 5, where a missed field reads `undefined`
and prices an order wrong without an error. Its guard is the money
specs (`pricing`, `cart-money`, `group-credit`, `delivery-pass`,
`edit-order`) and a grep that leaves no `this.<field>` of the old
names behind. The second is a redraw gone missing or doubled once
`refresh` leaves the class. `renderWindows` and `chooseSeries` each
consume a waiting choice when they run, so an extra call can lose
one.

## 5. Where the stall valve is needed

The coordinator ruled on the first three on 2026-11-22.

- **`order-form.js`, phases 1 to 13.** Each phase edits a file that
  stays over the limits until phase 14. One entry on #791 (the rule
  exceptions log) covers the whole series, logged when phase 1's
  pull request opens. The file can only shrink under it.
- **Phase 5's renames** fall inside functions that are still too
  long. If the gate counts a function's length against a pull
  request that changed a line inside it, phase 5 cannot pass on
  modified lines alone. The same entry covers it.
- **Spec comments, phase 14.** Seven e2e files change by a comment
  each. Under the whole-file rule each would have to meet the
  Playwright rules in full. They are held to their modified lines
  only, logged on #791 with that pull request.
- **Nothing else.** No function in the target needs a disabled rule
  on paper. If one does, the likeliest are the spy's measuring loop,
  which reads layout for each section, and `buildPayload`, whose
  payload is one long literal until it is built from parts.

`pay.js`, `cart/cart.js` and `date-lists.js` are over or near the
limits and are deliberately not edited, so no phase pulls them in.

## 6. Found while reading

None of these is fixed inside a move.

- `fail()` logs `payload.meta.idempotencyKey`. The payload carries
  `idempotencyKey` at its top level and nothing on the page sets
  `meta`, so the `order.undeliverable` line never has its key. Filed
  as #814 (the `order.undeliverable` console line never carries its
  idempotency key). Its fix, with a test, lands before phase 4.
- `eligible()` has no caller (deleted in phase 6).
- `settle()` handles `declined` and `checkout` with the same three
  lines (one handler in phase 13).
- `lapse()` copies `way` into `method` and uses only the copy.
- `renderGroupCard` writes the title's text and then appends a span
  to it, in two passes (one write in phase 9).
- The locked card has no e2e spec (written in phase 4).
