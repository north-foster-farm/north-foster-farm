# Splitting `order/pay.js`

The sixth design under #782 (quality gates in the build), read from
`next` at `3c101a73`. The rules common to every phase are in
[order-form.md](order-form.md#3-the-phases). How the payment section
works, and why, is in `docs/order-form.md` ("The page", "Square",
"PayPal").

`assets/scripts/order/pay.js` is one class, `Payment`: 689 lines,
501 of them code, in 24 methods. Four run past 25 lines:
`initVenmo` 101, `initSquare` 56, `init` 28, `tokenizeCard` 26. It
turns a card or a wallet into a token, or runs Venmo's approval, and
hands the result to the order form. It never posts the order
itself. Its length comes from two vendors' SDKs set up inline, each
with its own callbacks, failures and reports.

## 1. The file today

### What it does

**The section's state.** `constructor`, `setState`, `setCardOpen`,
`setCardAvailable`, `setCovered`, `showWallets`, `fail`,
`clearError`, `setBusy`. One element, `[data-pay]`, carries the
state the stylesheet reads.
e2e: `payment`, `pay-focus`, `payment-stacking`, `group-credit`,
`place-order-pane`, `order-page`.

**Loading.** `start`, `load`, `init`, and the module's `loadScript`.
The SDKs load once the section is within 600 px of the screen or
takes the focus. `/api/checkout/config` says which to load. A load
that never answers is called unavailable after 20 s and reported.
e2e: `payment`, `skeletons`, `wallets`, `report-privacy`,
`fake-payments`.

**The card.** The first half of `initSquare`, `cardInput`,
`cardDone`, `complete`, `tokenizeCard`, and the module's
`tokenMessage`.
Unit: `field-errors.test.mjs` (`validField`).
e2e: `payment`, `fake-payments`, `checkout-go`, `pay-focus`,
`recovery`.

**The wallets.** The second half of `initSquare`, `initApplePay`,
`initGooglePay`, `initCashAppPay`, `guard`, `finishWallet`,
`setAmount`.
e2e: `wallets`.

**Venmo.** `initVenmo` and the module's `venmoEnabled`. PayPal's
button with six callbacks: the gate, the click, the order's
creation, the approval with its one restart, cancel, error.
Unit: `venmo-gate.test.mjs` (`lib/venmo.mjs`).
e2e: `venmo-paid`, `venmo-restart`, `payment-stacking`,
`fake-payments`.

**Reports.** Seventeen crumbs, eleven report places and two SDK
states, spread through the above.
Unit: `report.test.mjs`, which reads this file's source and checks
every place it names against the allowlist in
`report/fields.mjs`.

### State

- **Square:** `payments`, `card`, `request`, `wallets`,
  `cardFields`.
- **PayPal:** `venmo`, `venmoPayload`, `venmoRestarted`,
  `venmoSettled`.
- **The section:** `config`, `ready`, `starting`, `busy`, `covered`.
- **Elements:** `root`, `error`, `state`, `cardButton`.
- **Outside the instance:** the module's `loaded`, a map of script
  promises, and `nff-venmo` in `localStorage`.

Four are first set outside the constructor: `covered`,
`venmoPayload`, `venmoRestarted`, `venmoSettled`.

### DOM

In `layouts/partials/order/payment.html`: `#payment` (the root),
`[data-pay]` with `data-pay-state` (`loading`, `ready`,
`venmo-only`, `unavailable`, `off`), `data-card-open` and
`data-pay-covered`; `[data-card-choose]` and its `aria-pressed`;
`[data-card]`, where Square's frame attaches; `#pay-card-panel`;
`[data-wallets]`, `[data-apple-pay]`, `[data-google-pay]`,
`[data-cash-app-pay]`; `[data-venmo-cell]`, `[data-venmo]`,
`[data-venmo-soon]`; `[data-error-for='payment']`; the class
`order-pay-busy`.

It also reaches one element outside its section: `#order-submit`,
which it hides, shows and enables.

### Events, timers, requests

Listens: an `IntersectionObserver` on the root; `focusin` once;
`click` on the card's button and the three wallet buttons, Google
Pay's and Cash App Pay's also in the capture phase; Square's card
events (five kinds) and Cash App Pay's `ontokenization`; PayPal's
six callbacks.

It dispatches nothing. It appends `script` elements to the head.

Timers: 20,000 ms for the SDKs to answer; 200 ms for the card's
last field to report.

One request of its own: `GET /api/checkout/config`, uncached. The
SDKs make their own.

### The two contracts

What the form gives it, eleven members, used by name:
`paymentReady()`, `amount()`, `contact.name`, `prepare()`,
`prepareAsync()`, `referenceId()`, `pay()`, `billing()`,
`stock.locked`, `venmoCreate()`, `venmoCapture()`.

What the form uses of it: `start()`, `setAmount()`, `setCovered()`,
`complete()`, `tokenizeCard()`, `fail()`, `clearError()`, and three
fields read directly, `ready`, `root` and `state`.

### Imports and importers

`order-form.js` is the one importer.

It imports `lib/venmo.mjs`, `report.js`, `utils/field-errors.mjs`
and `utils/skeleton.js`.

Two stand-ins follow its use of the SDKs,
`assets/scripts/fake/square.js` and `fake/paypal.js`, and
`test/sourcemaps.test.mjs` names this file in a fixture.

## 2. The target

`pay.js` stays, with `Payment` and everything the form uses of it,
so `order-form.js` is not edited. The work moves into
`assets/scripts/order/pay/`. Inside, no part sees the form:
`Payment` builds one `checkout` object from the eleven members and
hands the parts that. The port is narrowed here, in one place, as
the order form's design left it to this one to do.

### Modules

Sizes are code lines, estimated.

Pure:

```
pay/words.mjs       dollarsOf, tokenMessage, venmoRefusal           40
pay/states.mjs      endState, submitHidden, cardFieldOf, cardDone,
                    sectionComplete, walletsShown                   50
pay/requests.mjs    CARD_STYLE, cardRequest, billingContact,
                    paymentRequestOf                                60
pay/venmo-flow.mjs  clickAllowed, shouldRestart                     20
```

`lib/venmo.mjs` stays as it is.

Dumb:

```
pay/scripts.js      loadScript                                      20
pay/section.js      Section: setState, setCardOpen,
                    setCardAvailable, setCovered, showWallets,
                    fail, clearError, setBusy                       90
pay/venmo-gate.js   venmoEnabled                                    25
```

Smart:

```
pay/loader.js       Loader: start, load, init                      100
pay/card.js         Card: attach, the field events, complete,
                    tokenize                                       100
pay/wallets.js      Wallets: the request, Apple Pay, Google Pay,
                    Cash App Pay, guard, finish, setAmount         140
pay/venmo.js        Venmo: the button and its six callbacks        150
pay.js              Payment: the checkout port, the parts, the
                    form's surface                                  90
```

Eleven new modules and about 900 lines for today's 501.

### How state moves

```
the section nears the screen
  -> loader.js   config = /api/checkout/config
                 card.attach(), wallets.attach(), venmo.attach()
                 section.setState(endState({ card, venmo }))
                 checkout.ready()

a wallet's press
  -> wallets.js  payload = checkout.prepare()      in the click
                 token = wallet.tokenize()
                 checkout.pay(payload, { method, sourceId })

Place your order (the form's button)
  -> the form    payment.tokenizeCard(payload)
  -> card.js     cardRequest(amount, billing)      requests.mjs
                 -> { method: "card", sourceId }

Venmo
  -> venmo.js    payload = checkout.prepareAsync()
                 id = checkout.venmoCreate(payload)
                 checkout.venmoCapture(payload, orderID, ...)
```

- **`Section` is the one writer of the section's DOM state** and
  holds its two flags, `busy` and `covered`. `Card`, `Wallets` and
  `Venmo` ask it to fail, to go busy, to show the wallets.
- **Each vendor part owns its SDK objects.** `Card` has the card
  and its fields' states, `Wallets` the payment request and the
  three wallets, `Venmo` its payload and its two flags.
- **`checkout` is the form, narrowed:** `amount()`, `label()`,
  `prepare()`, `prepareAsync()`, `pay()`, `billing()`,
  `referenceId()`, `venmoCreate()`, `venmoCapture()`,
  `stockLocked()`, `ready()`. `Payment` builds it once from the
  form.
- **`Payment` keeps `ready`, `root` and `state` readable,** since
  the form reads them.

### What stays as it is

`Payment`'s constructor and the surface the form uses; the eleven
members the form gives; `lib/venmo.mjs`; `report.js`; the two
stand-ins; every crumb and report place by name. No new package.

## 3. The phases

The rules are those of
[order-form.md](order-form.md#3-the-phases). `bin/nff e2e` selects
the 95 specs mapped to `assets/scripts/order/**`. The specs that pin
the section are `payment`, `fake-payments`, `wallets`, `venmo-paid`,
`venmo-restart`, `pay-focus`, `payment-stacking` and
`place-order-pane`. They are read first after every phase.

Real Square and PayPal are reached only on staging and by James's
phone. Section 5 says what that means for landing.

### Phase 1: words and decisions

Moves `money`, `tokenMessage` and the two Venmo refusals to
`pay/words.mjs`; the choices now written inline to
`pay/states.mjs`, `pay/requests.mjs` and `pay/venmo-flow.mjs`.

Criteria:

1. `dollarsOf` writes cents as dollars with two decimals.
2. `tokenMessage` with no error asks the customer to check the
   card's details.
3. It names the ZIP code, the expiration date or the security code
   for an error in that field, and uses the field rule's words for
   the card number.
4. For any other error it gives the SDK's message, or the general
   line where there is none.
5. `endState` is ready with a card, Venmo only with Venmo alone,
   and unavailable with neither.
6. `submitHidden` hides the form's button when the card is not
   chosen, unless credit covers the order.
7. `cardFieldOf` reads a field's name and whether it is completely
   valid from the event's detail, or from the event itself.
8. `cardDone` is true only when the number, the expiration date,
   the security code and the ZIP code are all complete.
9. `sectionComplete` is true with nothing to charge or with credit
   covering the order, false with no card or with the card not
   chosen, and otherwise whether the card is done.
10. `cardRequest` asks for a charge of the amount in dollars, by
    the customer, with the billing contact.
11. `billingContact` carries the name, email and phone, and the
    address only when there is a street, without a state it does
    not know.
12. `clickAllowed` is false for a locked button, a busy section or
    a form that did not validate.
13. `shouldRestart` is true only for a first capture that Venmo
    declined for the funding source, when PayPal offers a restart.
14. `venmoRefusal` says ordering isn't available when stock is
    locked, and to check the form otherwise.

Stay green: `venmo-gate.test.mjs`, `field-errors.test.mjs`,
`report.test.mjs`.
e2e: the eight payment specs.

### Phase 2: the section, the scripts, the gate

Moves `setState`, `setCardOpen`, `setCardAvailable`, `setCovered`,
`showWallets`, `fail`, `clearError` and `setBusy` to
`pay/section.js`; `loadScript` to `pay/scripts.js`; `venmoEnabled`
to `pay/venmo-gate.js`. `Payment` keeps methods of the same names
that call them.

No criteria tests: the decisions came in phase 1.
e2e: `payment`, `pay-focus`, `payment-stacking`, `group-credit`,
`place-order-pane`.

### Phase 3: the card

Moves the card's half of `initSquare`, `cardInput`, `cardDone`,
`complete` and `tokenizeCard` to `pay/card.js`. `Payment` builds
the `checkout` port here, since `Card` is the first part to need
it.

The test agent changes `test/report.test.mjs` to read `pay.js` and
every file in `order/pay/` for the places reported from. That
changes an expectation, so it comes in the test agent's patch.

Criteria (`Card`, driven with a stand-in for Square's card):

1. A card that fails to attach is reported as `card.attach`, and
   the section goes on without the card.
2. `tokenize` with no card throws "Card payments aren't available
   right now."
3. A token that is not OK throws `tokenMessage`'s words.
4. `complete` waits 200 ms for the last field's word before it
   answers no.

Stay green: `report.test.mjs`, `field-errors.test.mjs`.
e2e: `payment`, `fake-payments`, `checkout-go`, `pay-focus`,
`recovery`, `report-privacy`.

### Phase 4: the wallets

Moves the payment request, `initApplePay`, `initGooglePay`,
`initCashAppPay`, `guard`, `finishWallet` and `setAmount` to
`pay/wallets.js`.

Criteria (`Wallets`, driven with stand-ins):

1. Apple Pay calls `prepare()` and `tokenize()` in the click's own
   turn, with nothing awaited between.
2. A press while the section is busy, or on a form that does not
   validate, opens no sheet.
3. A canceled sheet says nothing and reports nothing.
4. A token that is not OK reports the wallet and the status only,
   never the SDK's message, and shows `tokenMessage`'s words.
5. A wallet the browser lacks leaves its button hidden.
6. `setAmount` updates the request, and a request that refuses the
   update is left alone.

e2e: `wallets`, `payment`, `payment-stacking`.

### Phase 5: Venmo

Moves `initVenmo` to `pay/venmo.js`, each of PayPal's six callbacks
a method of its own.

Criteria (`Venmo`, driven with a stand-in for PayPal's button):

1. A locked button is inert, disabled at init, rejects a click, and
   never counts as a way to pay.
2. A click on a busy section, or on a form that does not validate,
   is rejected.
3. Creating the order with a form that does not prepare throws
   `venmoRefusal`'s words.
4. An order found already paid stops PayPal with an error that
   `onError` then keeps quiet about, once.
5. A first decline for the funding source restarts the sheet, and a
   second does not.
6. Any other error reports `paypal.error` and tells the customer to
   try again or pay another way.
7. A button that is not eligible hides its cell.

Stay green: `venmo-gate.test.mjs`.
e2e: `venmo-paid`, `venmo-restart`, `payment-stacking`,
`fake-payments`.

### Phase 6: loading and the root

Moves `start`, `load` and `init` to `pay/loader.js`. `pay.js` is
the port, the parts and the form's surface, within the limits, and
comes off the legacy lists of #782 (quality gates in the build).

Criteria (`Loader`, driven with stand-ins and Node's mock timers):

1. A config that says off sets the state off and loads nothing.
2. A config with neither processor reports `checkout.config` and is
   unavailable.
3. Both SDKs failing reports `sdks.gone` and is unavailable.
4. No answer in 20 s reports `checkout.init` and is unavailable,
   and a late success still takes over.
5. A second call of `load` returns the first one's promise.

e2e: every spec named in this document.

## 4. What must not change

- **Both contracts,** by name: what the form gives and what it
  uses.
- **A wallet tokenizes inside its click.** Nothing is awaited
  between the press and `tokenize()`. Safari refuses the sheet
  otherwise.
- **The guard runs in the capture phase,** before the wallet's own
  listener.
- **Reports:** the seventeen crumbs, the eleven places and the SDK
  states, by name. The server keeps an allowlist
  (`report/fields.mjs`) and drops any other. A wallet's failure
  reports its status only, since the SDK's own words can quote the
  card.
- **The section's states:** the five values of `data-pay-state`,
  `data-card-open`, `data-pay-covered`, and the class
  `order-pay-busy`.
- **The dark launch:** `nff-venmo` in `localStorage`, `?venmo` and
  `?venmo=0`, and the inert button over "Coming soon".
- **When the SDKs load:** within 600 px, or on the first focus, and
  only from the URLs the config gives, which are the hosts the
  content-security policy allows.
- **What the stand-ins offer:** the calls `fake/square.js` and
  `fake/paypal.js` answer are the calls the parts make.
- **Venmo's one restart,** and the quiet error for an order already
  paid.
- **Wording,** byte for byte, and the card frame's colors.

The risk here is unlike the other files'. The specs run against
stand-ins, so a mistake in how a real SDK is called passes every
test. The phases therefore change no call to an SDK: same methods,
same arguments, same order.

## 5. Where the stall valve is needed, and what needs James

- **`pay.js`, phases 1 to 5:** one entry on #791 (the rule
  exceptions log) for the series.
- **`test/report.test.mjs`** changes in phase 3, in the test
  agent's patch: modified lines only.
- **The Venmo button's options.** PayPal takes one object of six
  callbacks. With each a method the object is short, and no
  exception is expected.
- **A check on staging after phases 3, 4 and 5.** Each moves how a
  real SDK is reached. Before the release that carries them: a card
  payment, a wallet on James's phone and a Venmo payment against
  the sandbox, as the release's staging looks already do. This is
  James's step, asked for on the pull request.

`order-form.js` is not edited.

## 6. Found while reading

None of these is fixed inside a move.

- A press on Google Pay or Cash App Pay runs the form's `prepare()`
  twice, once in the guard and once in the wallet's own handler, so
  the form validates and saves the draft twice.
- `setCardOpen` and `setCovered` hide, show and enable
  `#order-submit`, which the form also hides, shows and enables.
  One button has two owners.
- The header comment lists seven things the form gives. The code
  uses eleven.
- Four fields are first set outside the constructor.
