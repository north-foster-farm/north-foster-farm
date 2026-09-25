# QA plan: checkout and the autumn refresh

## How to run

```sh
npm install
npx playwright install chromium   # only if chromium-1234 is not cached
# bin/nff --staging needs .env and .env.staging in the checkout root
npm run e2e                                   # everything, both projects
npm run e2e -- --grep @regression             # the regression list
npm run e2e -- --project=desktop e2e/pricing.spec.mjs
E2E_KEEP=1 npm run e2e -- e2e/payment.spec.mjs    # keep cancelled records
STAGING_TOKEN=... npm run e2e                 # read the outbox over HTTP
E2E_BASE_URL=https://deploy-preview-NNN--north-foster-farm.netlify.app \
  npm run e2e -- e2e/order-page.spec.mjs e2e/pricing.spec.mjs
npx playwright show-report
bin/nff --staging orders list
```

The suite runs against the staging branch deploy and refuses any host
without `--` in its name, so production is out of reach. Each test opens
a fresh browser (empty `localStorage`) with the staging toolbar hidden,
uses its own address (`qa-e2e-<tag>-<id>@example.com`), and cleans up
after itself: paid orders are cancelled with `--refund` and deleted,
test customers are deleted, and their messages are removed from the
outbox. The outbox is read from the jobs store with the CLI's Netlify
credentials, or over `/api/staging/outbox` when `STAGING_TOKEN` is set.
`POST /api/orders` answers 429 after 12 requests in 10 minutes; one full
run sends about ten, so leave ten minutes between runs that include the
payment, API and account specs. `rate-limit.spec.mjs` (PY-18) reaches
the limit on purpose and runs only with `E2E_LOCKOUT=1`: run it alone,
last in a pass.

Two projects: `desktop` (Chromium, 1500 by 900) runs every spec;
`phone` (Chromium, 390 by 664, touch) runs the order page and the forms.
The layout spec sets 1500, 1198, 990, 575 and 390 itself.

Every case below has a status. **Automated** names its spec and test.
**Partial** automates part and says what is left. **Manual** says why a
person must do it. **Pending** waits on an issue that is not built yet;
its steps come from the issue's acceptance points.

Sandbox cards: `4111 1111 1111 1111` approves (Visa ending 1111),
`4000 0000 0000 0002` declines; any future expiry, CVV `111`, postal
code `11111`. At the API, `cnon:card-nonce-ok` approves (Visa ending
5858) and `cnon:card-nonce-declined` declines.

## The order page and cart

### OP-01 An empty cart owes nothing

Automated: `order-page.spec.mjs`, "an empty cart owes nothing and cannot
continue" (both projects).

- **Scenario:** A customer opens the order page before choosing
  anything; a $5 fee on an empty cart once read as a $5 order (finding
  22).
- **Setup:** Fresh browser, no draft.
- **Test:**
  1. Open `/order/`.
- **Assert:** Delivery is checked. The cart reads "0 items", Subtotal $0,
  Total $0, with no Delivery fee row and no discount row. Continue to
  checkout is disabled. The nudge reads "Delivery orders need a $40
  minimum." The Delivery card reads "You need $40 or more in your cart
  to use this option."
- **Teardown:** None.

### OP-02 Delivery comes first

Automated: `order-page.spec.mjs`, "the ways to get an order: Delivery
first, then the drop site, then the farm" (both projects).

- **Scenario:** Delivery is the default and leads the list (finding 17).
- **Setup:** Fresh browser.
- **Test:**
  1. Open `/order/`.
- **Assert:** The method cards read, in order, "Delivery", "Scituate
  drop site", "On-farm pickup".
- **Teardown:** None.

### OP-03 Add becomes a stepper and the cart itemizes it

Automated: `order-page.spec.mjs`, "Add becomes a stepper and the cart
itemizes the line" (both projects).

- **Scenario:** The first tap on a product adds one and turns the button
  into a stepper; the cart shows the line.
- **Setup:** Fresh browser, empty cart.
- **Test:**
  1. Press Add on Eggs, Large.
  2. Fold the cart if it floats over the row, then press "One more".
- **Assert:** The row's stepper is active with 1, then 2. The cart has
  one group "Eggs" with one line "Large", "2 × $7", "$14". Count "2
  items", Subtotal $14, Delivery fee +$5, Total $19.
- **Teardown:** None.

### OP-04 Minus at one removes the item

Automated: `order-page.spec.mjs`, "the stepper's minus at one removes
the item" (both projects).

- **Scenario:** At one, the minus button is labeled Remove and empties
  the row.
- **Setup:** `/order/?add=NFF-CHK-EGG-LG:1`.
- **Test:**
  1. Fold the cart if it floats; press Remove on Eggs, Large.
- **Assert:** Quantity 0, the row shows Add again, the cart reads "0
  items".
- **Teardown:** None.

### OP-05 The cart's × takes every unit out

Automated: `order-page.spec.mjs`, "the × on a cart line takes every unit
out" (both projects).

- **Scenario:** A customer removes a whole line from the cart.
- **Setup:** `/order/?add=` 3 eggs and 2 wings.
- **Test:**
  1. Press "Remove Wings, under 2.0 lbs from the cart".
- **Assert:** Wings quantity 0; "3 items"; Subtotal $21.
- **Teardown:** None.

### OP-06 The × works right after typing

Automated: `order-page.spec.mjs`, "the × works on the first click right
after typing in a field" (both projects). Finding D1, fixed by #155.

- **Scenario:** A customer types a ZIP (or any field), then removes a
  cart line; leaving the field re-renders the cart, and the first click
  is lost.
- **Setup:** `/order/?add=` 5 wings and 1 egg.
- **Test:**
  1. Type `02857` in ZIP.
  2. Without clicking elsewhere, press the × on the Wings line.
- **Assert:** Wings quantity 0 and the cart reads "1 item" after one
  click.
- **Teardown:** None.

### OP-07 Quantities keep to two digits

Automated: `order-page.spec.mjs`, "a typed quantity keeps to two digits"
(both projects).

- **Scenario:** Typed quantities cannot exceed 99 or hold letters.
- **Setup:** 1 egg in the cart.
- **Test:**
  1. Clear the eggs box and type `150`; leave the field.
  2. Type `abc`; leave the field.
- **Assert:** The box reads 15, then 0.
- **Teardown:** None.

### OP-08 Reorder links fill the cart

Automated: `order-page.spec.mjs`, "?add= fills the cart, names what it
added and clears the query" (both projects).

- **Scenario:** The account page's Add again and Reorder links open
  `/order/?add=SKU:qty`; anything no longer sold is named, not added.
- **Setup:** `/order/?add=NFF-CHK-EGG-LG:2,NFF-CHK-EGG-MD:1` (Medium is
  sold out).
- **Test:**
  1. Open the link.
- **Assert:** The notice reads "Added to your cart: 2 × Large. No longer
  available: Eggs (per dozen), Medium." Eggs, Large reads 2. The URL is
  `/order/` with no query.
- **Teardown:** None.

### OP-09 The draft survives a reload

Automated: `order-page.spec.mjs`, "the draft survives a reload" (both
projects).

- **Scenario:** A customer who leaves and comes back finds the order as
  they left it.
- **Setup:** 5 wings.
- **Test:**
  1. Choose Scituate drop site; type "Draft" as the first name.
  2. Reload.
- **Assert:** Wings 5, Scituate checked, first name "Draft", Total $45.
- **Teardown:** None (the browser context is discarded).

### OP-10 Continue to checkout goes to Contact information

Automated: `order-page.spec.mjs`, "Continue to checkout takes the
customer to Contact information" (both projects).

- **Scenario:** The cart's way on lands the customer on their details.
- **Setup:** 5 wings.
- **Test:**
  1. Press Continue to checkout.
- **Assert:** The "Contact information" legend has focus and is on
  screen.
- **Teardown:** None.

### OP-11 The site's scripts log no errors

Automated: `order-page.spec.mjs`, "the site's own scripts log no errors"
(both projects).

- **Scenario:** Nothing of ours throws while the page and the payment
  SDKs load. Vendor SDK noise (CSP reports from Cash App's telemetry,
  inline-script reports from the wallet frames) is excluded.
- **Setup:** 2 eggs.
- **Test:**
  1. Scroll to Payment and wait for the card form.
- **Assert:** No `pageerror`, and no console error whose source is the
  staging host (outside `/api/staging/`).
- **Teardown:** None.

### OP-12 Every product in stock has a row

Automated: `order-page.spec.mjs`, "every in-stock product has a row and
an Add button" (both projects).

- **Scenario:** The page and `GET /api/stock` agree on what is for sale.
- **Setup:** Fresh browser.
- **Test:**
  1. Open `/order/`; read `/api/stock`.
- **Assert:** The set of rows equals the SKUs with `inStock` true and
  `available` not 0.
- **Teardown:** None.

### OP-13 Continue to checkout can always be reached

Automated: `cart-layout.spec.mjs`, "Continue to checkout can be reached
and pressed", at 1500, 1198, 990, 575 and 390. Tagged `@regression`.

- **Scenario:** With a long cart the sticky pane was taller than the
  window and cut the button off (finding 2).
- **Setup:** The 20-item, $199 cart (`FULL_CART` in
  `e2e/support/order.mjs`) at each width.
- **Test:**
  1. Scroll the button into view.
  2. Press it.
- **Assert:** The whole button is on screen, nothing covers it, and the
  "Contact information" legend takes focus.
- **Teardown:** None.

### OP-14 Continue to checkout is never wider than 370px

Automated: `cart-layout.spec.mjs`, "Continue to checkout is never wider
than 370px", every width.

- **Scenario:** Finding 21.
- **Setup:** `FULL_CART`.
- **Test:**
  1. Measure the button.
- **Assert:** Width 370px or less.
- **Teardown:** None.

### OP-15 The nudge sits under Continue

Automated: `cart-layout.spec.mjs`, "the next-discount nudge shows under
Continue", every width.

- **Scenario:** The nudge had vanished at most widths (finding 20).
- **Setup:** `FULL_CART` ($199).
- **Test:**
  1. Scroll the nudge into view.
- **Assert:** It reads "Next discount: add $1 for $20 off.", is wholly
  on screen, below the button, right edges within 2px.
- **Teardown:** None.

### OP-16 The total sits under the price column

Automated: `cart-layout.spec.mjs`, "the total sits under the column of
prices", every width.

- **Scenario:** Finding 1.
- **Setup:** `FULL_CART`.
- **Test:**
  1. Measure the total, the subtotal and the first line price.
- **Assert:** The total's right edge is within 2px of the subtotal's; at
  1500 and below 768 also within 2px of the line prices'.
- **Teardown:** None.

### OP-17 The cart's foot

Automated: `cart-layout.spec.mjs`, "the foot carries Hide below xl and
not at xl", every width.

- **Scenario:** Hide on the left, Continue on the right, below xl only
  (finding 3).
- **Setup:** `FULL_CART`.
- **Test:**
  1. Look at the foot.
- **Assert:** At 1500 no Hide. Below 1200 Hide reads "Hide", sits left of
  Continue, centers within 12px of it vertically.
- **Teardown:** None.

### OP-18 The settled cart keeps its lines inside

Automated: `cart-layout.spec.mjs`, "the settled cart stays inside its
own box", every width.

- **Scenario:** At 1198 and 990 the settled cart's lines spilled over
  Contact information (finding 4).
- **Setup:** `FULL_CART`.
- **Test:**
  1. Scroll Contact information into view so the cart settles.
- **Assert:** The foot ends inside the cart; below xl the cart ends above
  the legend; no line is drawn below the cart's bottom edge.
- **Teardown:** None.

### OP-19 Nothing shows through the cart

Automated: `cart-layout.spec.mjs`, "nothing shows through the cart",
every width.

- **Scenario:** Catalog headings and buttons showed through the folded
  cart at 575 (finding 7).
- **Setup:** `FULL_CART`.
- **Test:**
  1. Hit-test a grid of points across the cart.
  2. Below xl, press Hide and hit-test again.
- **Assert:** Every point lands on the cart or its children, open and
  folded.
- **Teardown:** None.

### OP-20 The item list scrolls on its own

Automated: `cart-layout.spec.mjs`, "the item list scrolls on its own
while the cart floats", 1198, 990, 575, 390.

- **Scenario:** At 990 the wheel over the floating list did not scroll
  it (finding 5).
- **Setup:** `FULL_CART`; the cart floating.
- **Test:**
  1. Wheel over the item list.
- **Assert:** The list's `scrollTop` rises above 0. Skipped where the
  whole list fits.
- **Teardown:** None.

### OP-21 The total bar is flush with the top

Automated: `cart-layout.spec.mjs`, "the total bar is flush with the top
once the cart is passed", 1198, 990, 575, 390.

- **Scenario:** The sticky total bar sat below the top with page text
  above it (finding 6).
- **Setup:** `FULL_CART`.
- **Test:**
  1. Scroll past Pickup or delivery.
- **Assert:** The bar (from lg the total bar, below lg the topbar)
  reads "20 items" and "$184", its top is within 1px of the window's,
  and below lg nothing shows through it.
- **Teardown:** None.

### OP-22 The Cart heading matches the other headings

Automated: `cart-layout.spec.mjs`, "the Cart heading looks like the
other section headings", below xl.

- **Scenario:** "Cart" rendered as an h4 (finding 9).
- **Setup:** Any cart.
- **Test:**
  1. Compare computed styles.
- **Assert:** Font size, weight and family equal the "Contact
  information" legend's.
- **Teardown:** None.

### OP-23 Contact form spacing

Partial: `cart-layout.spec.mjs`, "heading to hint is 0.375rem, and each
label sits with its own field", every width. Whether the form reads as
grouped is a visual judgement.

- **Scenario:** Findings 11 and 12.
- **Setup:** 1 egg.
- **Test:**
  1. Measure the legend's bottom margin and the hint's inline style.
  2. Where labels stack, measure label-to-field and field-to-next-label.
  3. By eye at 575 and on an iPhone: "Marketing opt-in" belongs to its
     checkbox, not the phone above.
- **Assert:** Margin 6px; no `-12px` inline margin; the gap between
  groups is larger than the gap inside one.
- **Teardown:** None.

### OP-24 The phone cart floats and settles

Manual: visual judgement and a real iPhone keyboard.

- **Scenario:** Findings 8 and 10: pinched with a back shadow while
  floating, flat and borderless once settled, no big gap before Contact
  information, and a tap in the discount field does not shift it.
- **Setup:** iPhone, Safari, `FULL_CART`.
- **Test:**
  1. Scroll the catalog; watch the floating cart.
  2. Scroll until it settles.
  3. Tap the discount code field.
- **Assert:** Floating: inset on both sides, shadow on its back edge.
  Settled: no border, no inset, the gap to "Contact information" matches
  the gaps between sections. The cart does not jump when the keyboard
  opens; the lines scroll with a finger.
- **Teardown:** Clear the draft (Safari settings, or remove the lines).

### OP-25 Badges explain themselves and celebrate

Manual: animation and tooltip behavior are visual.

- **Scenario:** A tap on a badge explains it; a badge that lights sends
  chicks.
- **Setup:** 4 wings, Delivery.
- **Test:**
  1. Tap "Delivery"; tap elsewhere.
  2. Add a fifth wing.
- **Assert:** The tooltip reads "Orders of $40 or more after discounts
  can be delivered on Thursdays. $5 fee, waived at $150." and closes on
  the next tap. At $50 the "$50+" badge turns green and italic and a few
  chicks hop out of it once.
- **Teardown:** None.

### OP-26 Stock counts close rows and clamp the cart

Manual: the stock counts are shared by everyone using staging, so a
test that sets them would disturb other runs.

- **Scenario:** The page shows "N left" at five or fewer, drops sold-out
  rows and clamps the cart.
- **Setup:** Pick an unused SKU, for example `NFF-CHK-DRM-0150-0300`.
  `bin/nff --staging stock set NFF-CHK-DRM-0150-0300 3`.
- **Test:**
  1. Open `/order/?add=NFF-CHK-DRM-0150-0300:5`.
  2. `bin/nff --staging stock set NFF-CHK-DRM-0150-0300 0`; return to the
     tab.
- **Assert:** Step 1: the row says "3 left" and the quantity is clamped
  to 3 with a notice. Step 2: the row is gone and the cart line removed
  with a notice.
- **Teardown:** `bin/nff --staging stock set NFF-CHK-DRM-0150-0300 none`.

### OP-27 The phone cart after the first Add

Manual: a judgement for James.

- **Scenario:** On a 390 by 664 screen, the first Add opens the floating
  cart over about two thirds of the catalog, covering the row just used.
- **Setup:** Phone, empty cart.
- **Test:**
  1. Tap Add on Eggs, Large.
  2. Try to tap + on the same row.
- **Assert:** Decide whether the row should stay reachable without Hide.
  Screenshot of today's state:
  `.ignored/qa/2026-09-24-launch/phone-floating-cart-covers-catalog.png`.
- **Teardown:** None.

## Pricing and discounts

Wings are $10, eggs $7, thighs $12. Tiers: $5 off at $50, $10 at $100,
$15 at $150, $20 at $200, never stacked. The $5 delivery fee is waived
at $150 before discounts; an unlisted Rhode Island ZIP adds $3, never
waived. Delivery needs $40 after discounts.

### PR-01 Bulk tiers and the delivery fee

Automated: `pricing.spec.mjs`, the seven "... of goods by delivery"
tests. Tagged `@regression`.

- **Scenario:** Every threshold, with Delivery chosen.
- **Setup:** One fresh page per row, filled by `?add=`.
- **Test:**
  1. Open the cart below; read the totals.
- **Assert:**

  | Cart           | Subtotal | Discount                     | Fee  | Total |
  | -------------- | -------- | ---------------------------- | ---- | ----- |
  | 7 eggs         | $49      | none                         | +$5  | $54   |
  | 5 wings        | $50      | Bulk discount ($50+) −$5     | +$5  | $50   |
  | 10 wings       | $100     | Bulk discount ($100+) −$10   | +$5  | $95   |
  | 13 wings, 1 egg, 1 thigh | $149 | Bulk discount ($100+) −$10 | +$5 | $144 |
  | 15 wings       | $150     | Bulk discount ($150+) −$15   | Free | $135  |
  | 20 wings       | $200     | Bulk discount ($200+) −$20   | Free | $180  |
  | 25 wings       | $250     | Bulk discount ($200+) −$20   | Free | $230  |

- **Teardown:** None.

### PR-02 Pickup and the drop site carry no fee

Automated: `pricing.spec.mjs`, "pickup and the drop site carry no fee".

- **Scenario:** Only delivery is charged for.
- **Setup:** 7 eggs ($49).
- **Test:**
  1. Choose On-farm pickup, then Scituate drop site.
- **Assert:** No fee row either way; Total $49.
- **Teardown:** None.

### PR-03 Badges light with the tiers

Automated: `pricing.spec.mjs`, "the badges light as the tiers are
reached".

- **Scenario:** The dotted line of badges agrees with the totals.
- **Setup:** 15 wings.
- **Test:**
  1. Read each badge's `data-on`.
- **Assert:** Delivery, Free delivery, $50+, $100+, $150+ on; $200+ off.
- **Teardown:** None.

### PR-04 The nudge names the next tier

Automated: `pricing.spec.mjs`, "the nudge names the next tier, and says
nothing at the top".

- **Scenario:** The nudge promises only what the breakdown will show.
- **Setup:** 10 wings.
- **Test:**
  1. Read the nudge with Delivery, then On-farm pickup.
  2. Make it 20 wings.
- **Assert:** "Next discount: add $50 for $15 off and free delivery.",
  then "Next discount: add $50 for $15 off."; at $200 (Total $180) no
  nudge.
- **Teardown:** None.

### PR-05 Exactly $40 meets the minimum

Automated: `pricing.spec.mjs`, "exactly $40 meets the delivery minimum".

- **Scenario:** The minimum is inclusive.
- **Setup:** 4 wings.
- **Test:**
  1. Read the cart.
- **Assert:** No red warning, Continue enabled, fee +$5, Total $45, the
  Delivery badge on.
- **Teardown:** None.

### PR-06 Under the minimum, delivery is blocked

Automated: `pricing.spec.mjs`, "$35 by delivery is short; the drop site
takes it". Tagged `@regression`.

- **Scenario:** A small order learns about the minimum at the choice,
  and the drop site takes it.
- **Setup:** 5 eggs ($35).
- **Test:**
  1. Read the nudge and the Delivery card.
  2. Choose Scituate drop site.
- **Assert:** "Add $5 to reach the $40 delivery minimum."; "You need $40
  or more in your cart to use this option. Add $5 more."; Continue
  disabled. After step 2: no warning, Continue enabled, Total $35.
- **Teardown:** None.

### PR-07 The outside-area fee

Automated: `pricing.spec.mjs`, "an unlisted Rhode Island ZIP adds $3,
never waived".

- **Scenario:** An unlisted 028 or 029 ZIP pays $3 more, even when the
  $5 is waived.
- **Setup:** 5 wings, Delivery.
- **Test:**
  1. ZIP `02830`.
  2. Make it 15 wings.
  3. ZIP `02857`.
- **Assert:** Fee +$8, Total $53; then fee +$3, Total $138; then Free,
  Total $135.
- **Teardown:** None.

### PR-08 The outside-area note on the order page

Automated: `pricing.spec.mjs`, "the unlisted-ZIP note states the fee in
dollars and charges now". Fails today: finding D2.

- **Scenario:** The note under the ZIP must state the fee as money and
  must not promise a check before charging, since the card is charged on
  the page with the fee in it.
- **Setup:** 5 wings, Delivery.
- **Test:**
  1. ZIP `02830`.
- **Assert:** The note contains "$3" and not "before we charge you".
- **Teardown:** None.

### PR-09 The delivery policy's ZIP check

Automated: `pricing.spec.mjs`, "the delivery policy's ZIP check hedges
the same way". Fails today: finding D2.

- **Scenario:** The "Do we deliver to you?" widget says the same as the
  order page.
- **Setup:** `/delivery-policy/`.
- **Test:**
  1. ZIP `02830`, then `02857`.
- **Assert:** "A little outside our usual area: delivery is $3 more",
  without "before we charge you"; then "Yes! We deliver to ...".
- **Teardown:** None.

### PR-10 A ZIP outside the area

Automated: `pricing.spec.mjs`, "a ZIP outside the area is refused at the
field".

- **Scenario:** A New York ZIP is refused where it is typed.
- **Setup:** 5 wings, Delivery.
- **Test:**
  1. ZIP `10001`.
- **Assert:** "That's outside our delivery area. On-farm pickup and the
  Scituate drop site are open to everyone."
- **Teardown:** None.

### PR-11 Connecticut takes eggs only

Automated: `pricing.spec.mjs`, "Connecticut takes eggs only".

- **Scenario:** Chicken cannot be delivered to Connecticut yet.
- **Setup:** 5 wings, Delivery.
- **Test:**
  1. ZIP `06239`.
  2. Set wings to 0; add eggs.
- **Assert:** "We can only deliver eggs to Connecticut for now. Remove
  the chicken, or choose pickup."; then the state's note, "We are only
  able to deliver eggs in Connecticut at this time. ..."
- **Teardown:** None.

### PR-12 An unknown discount code

Automated: `pricing.spec.mjs`, "an unknown code says so and changes
nothing".

- **Scenario:** A code the site does not know is harmless.
- **Setup:** 5 wings.
- **Test:**
  1. Type `nosuchcode`; press Apply.
- **Assert:** "Not a valid discount code."; the field reads NOSUCHCODE;
  the discount stays "Bulk discount ($50+)"; Total $50.
- **Teardown:** None.

### PR-13 EGGBOI

Partial: `pricing.spec.mjs`, "EGGBOI counts up $40 a minute and changes
no real figure" covers the page. Paying with it is manual, to spare the
order endpoint's rate limit.

- **Scenario:** The joke counts up on screen and changes nothing real
  (#127).
- **Setup:** 5 wings.
- **Test:**
  1. Type `eggboi`; press Enter.
  2. Wait two seconds.
  3. Manual: pay with the sandbox card, on-farm pickup.
- **Assert:** "Code applied."; the field empties; a row "Discount
  (EGGBOI, $40/min)" whose amount climbs past $1; the real discount and
  Total $50 unchanged. Step 3 (on-farm, so no fee): charged $45;
  `bin/nff --staging orders show <id>` has no code and the emails
  mention none.
- **Teardown:** `bin/nff --staging orders cancel <id> --refund`, then
  `bin/nff --staging orders delete <id>`.

### PR-14 A real discount code

Pending: `data/discount-codes.json` has no codes.

- **Scenario:** A known code shows its discount; the largest discount
  wins; a code never takes more than the subtotal.
- **Setup:** A code added to the data file on a preview, for example
  `{ "code": "QA5", "label": "QA test", "off": 5 }`.
- **Test:**
  1. 3 eggs ($21), code `qa5`.
  2. 10 wings ($100), code `QA5`.
  3. Pay step 1's cart by card.
- **Assert:** "Code applied: $5 off."; row "QA test −$5", Total $16 by
  pickup. With $100 the bulk $10 wins. The record's `code` is QA5 and
  Square's order carries the $5 discount.
- **Teardown:** Refund, cancel and delete the order; remove the code.

### PR-15 A pricing group

Manual: needs a signed-in customer whose record carries a group.

- **Scenario:** Friends and family get 10%, never stacked with the bulk
  tier; the server takes the group from the session, not the payload.
- **Setup:** Sign in once as `qa-group@example.com` (AO-01), then
  `bin/nff --staging customers set qa-group@example.com group=friends`.
- **Test:**
  1. Signed in, open `/order/?add=NFF-CHK-WNG-0000-0200:12`.
  2. Make it 12 wings and 1 necks ($125).
- **Assert:** At $120: "Friends & family (10%)" −$12 (beats the $10
  tier). At $125: check whether the discount is $12.50. Every charge is
  meant to be a whole dollar; the code rounds to the cent, so this is a
  question for James (finding D6).
- **Teardown:** `bin/nff --staging customers delete qa-group@example.com`.

## Contact and pickup forms

### FM-01 The phone is required for delivery only

Automated: `forms.spec.mjs`, "Delivery is the default and needs a phone;
pickup does not" (both projects).

- **Scenario:** Finding 14: phone required for delivery, optional for
  pickup and the drop site.
- **Setup:** 5 wings.
- **Test:**
  1. Read the phone label with Delivery, On-farm pickup, Scituate.
- **Assert:** Delivery: no "(optional)", the field `required`. The
  others: "(optional)" shown.
- **Teardown:** None.

### FM-02 An empty delivery order names every field

Automated: `forms.spec.mjs`, "an empty delivery order names every
missing field and sends nothing" (both projects). Tagged `@regression`.

- **Scenario:** The form validates before any processor is asked.
- **Setup:** 5 wings, Delivery.
- **Test:**
  1. Open Card and press Place your order with every field empty.
- **Assert:** "Please enter your first name.", "Please enter your last
  name.", "That email address doesn't look right.", "Please enter a
  phone number.", "Please enter your street address.", "Please enter
  your town.", "Please enter a five-digit ZIP code.", "Tell us where the
  cooler will be."; first name marked invalid and focused; no request
  to `/api/orders`.
- **Teardown:** None.

### FM-03 Pickup without a phone, and a bad phone

Automated: `forms.spec.mjs`, "on-farm pickup needs no phone, but a phone
given must work" (both projects).

- **Scenario:** An empty phone is fine for pickup; a wrong one is not.
- **Setup:** 1 egg, On-farm pickup, a date, name and email.
- **Test:**
  1. Press Place your order with an empty card form.
  2. Type `401555` as the phone; press again.
- **Assert:** Step 1: no phone error, the card form's own error shows,
  nothing sent. Step 2: "That phone number doesn't look right.", nothing
  sent.
- **Teardown:** None.

### FM-04 Errors clear as fields are fixed

Automated: `forms.spec.mjs`, "errors clear as each field is fixed,
without refocusing" (both projects). Tagged `@regression`.

- **Scenario:** Finding 16: errors stayed after autofill until the field
  was focused again.
- **Setup:** 1 egg, On-farm pickup, a date; one failed attempt.
- **Test:**
  1. Type a first name.
  2. Set the last name as autofill does (value, `input`, `change`, no
     focus).
  3. Type `ada@`, leave; click it, type `ada@example.com`, leave.
- **Assert:** Each error disappears as its field becomes valid; "That
  email address doesn't look right." shows while it is wrong.
- **Teardown:** None.

### FM-05 A field emptied later shows its error on leaving

Automated: `forms.spec.mjs`, "after a failed attempt, a field emptied
and left shows its error" (both projects).

- **Scenario:** Once an attempt has failed, leaving a field shows its own
  error even if it had none.
- **Setup:** Pickup order with no last name; one failed attempt.
- **Test:**
  1. Click the first name, clear it, leave.
- **Assert:** "Please enter your first name." appears.
- **Teardown:** None.

### FM-06 The phone formats itself

Automated: `forms.spec.mjs`, "the phone formats itself and then offers
text or call" (both projects).

- **Scenario:** A usable number brings "Prefer text or call?".
- **Setup:** 1 egg.
- **Test:**
  1. Type `4015550100`.
- **Assert:** The field reads "(401) 555-0100"; the row is shown with
  Text checked.
- **Teardown:** None.

### FM-07 The minimum warning is red and blocks

Automated: `forms.spec.mjs`, "delivery under the minimum warns in red at
the choice and blocks the order" (both projects).

- **Scenario:** Finding 17.
- **Setup:** 5 eggs ($35), Delivery, every field filled.
- **Test:**
  1. Read the Delivery card; press Place your order.
- **Assert:** "You need $40 or more in your cart to use this option. Add
  $5 more." in a red color; Continue disabled; nothing sent.
- **Teardown:** None.

### FM-08 The delivery-policy note stays dismissed

Automated: `forms.spec.mjs`, "the delivery-policy note can be dismissed,
and stays dismissed" (both projects).

- **Scenario:** The yellow note is dismissible and remembered.
- **Setup:** 5 wings, Delivery.
- **Test:**
  1. Press Dismiss; reload.
- **Assert:** "By placing a delivery order you agree to our delivery
  policy." is shown, then gone, and gone after the reload.
- **Teardown:** None.

### FM-09 The delivery countdown

Automated: `forms.spec.mjs`, "the delivery countdown names the next
delivery day" (both projects).

- **Scenario:** The countdown to the Wednesday-noon cutoff.
- **Setup:** 5 wings, Delivery.
- **Test:**
  1. Read the countdown.
- **Assert:** Starts "Order in the next" and contains "to get your order
  on our next delivery day".
- **Teardown:** None.

### FM-10 The farm-news box at checkout

Automated: `forms.spec.mjs`, "ticking the farm-news box sends the
confirmation at once" (both projects).

- **Scenario:** Ticking the box mails the double opt-in at once;
  finding 15 set the note's wording.
- **Setup:** 1 egg; a unique email.
- **Test:**
  1. Type the email; tick "I want to get email from North Foster Farm."
- **Assert:** The note reads "Click the link in the email you receive to
  join the list."; the outbox has "Confirm your email for North Foster
  Farm news and updates" to that address; no order is sent.
- **Teardown:** The message is removed from the outbox.

### FM-11 Autofill on an iPhone

Manual: Safari's autofill cannot be driven from Playwright.

- **Scenario:** Finding 16 as James met it.
- **Setup:** iPhone with a contact card; 1 egg, pickup.
- **Test:**
  1. Press Place your order empty.
  2. Autofill the name, email and phone from the keyboard bar.
- **Assert:** Every filled field's error disappears without tapping into
  it; "Prefer text or call?" fades in without a jump.
- **Teardown:** Clear the draft.

### FM-12 A signed-in customer's details

Manual: automatable with the account spec's sign-in; not yet written.

- **Scenario:** Name, email and phone arrive as plain text; a click makes
  one a field again.
- **Setup:** Signed in as a customer with a name and phone (AO-01).
- **Test:**
  1. Open `/order/`; click the email; change it; leave.
- **Assert:** The details show as text under "Click on a field to edit
  it."; the clicked one becomes a field and returns to text on leaving.
- **Teardown:** Sign out; delete the customer.

### FM-13 A date that closes while the page is open

Partial: `orders-api.spec.mjs`, "a date no longer offered answers 409
with a fresh list" covers the server. The page's message is manual.

- **Scenario:** A delivery cutoff passes between choosing and paying.
- **Setup:** A delivery order started before Wednesday noon; or a
  preview whose clock can be moved.
- **Test:**
  1. API: post an order dated `2026-01-02`.
  2. Page: choose the first delivery date, wait past the cutoff, pay.
- **Assert:** API: 409, "That date is no longer available.", a non-empty
  `dates`. Page: "That date just closed. Pick another from the updated
  list and try again." and the list replaced; nothing charged.
- **Teardown:** None.

### FM-14 The date lists

Manual: automatable; not yet written.

- **Scenario:** Dates follow `data/delivery.json`.
- **Setup:** Fresh page.
- **Test:**
  1. Open each method's date list.
- **Assert:** On-farm: weekdays from tomorrow through next Friday, no
  holidays. Scituate: the next two Saturdays from October 17. Delivery:
  the next two Thursdays whose Wednesday-noon cutoff has not passed.
- **Teardown:** None.

## Payments

### PY-01 A card pays for an on-farm pickup

Automated: `payment.spec.mjs`, "a card pays for an on-farm pickup, and
the farm is asked to confirm". Tagged `@regression`.

- **Scenario:** The main path, end to end: page, Square, record, emails.
- **Setup:** 1 egg, On-farm pickup, first date, name, unique email.
- **Test:**
  1. Press Card; the button reads "Place your order".
  2. Enter `4111 1111 1111 1111`, `12/30`, `111`, `11111`; press it.
  3. Reload `/order/`.
- **Assert:** `/api/orders` answers 200. "Thank you, Card. Your order is
  placed."; "$7" paid with "Visa ending 1111"; the email; an order
  number like `NFF-2609-AB2C`; "The pickup time you chose is a request";
  a receipt link to Square. `bin/nff --staging orders show <id>`:
  `status` paid, `payment.via` square, `method` card, `last4` 1111,
  `square.squareOrderId` set, `fulfilment.state` requested, `total`
  700. Outbox: "Payment received" to the customer with "Your payment of
  $7 came through." and "Requested:"; the farm's "New order <id>" for
  "$7, on-farm pickup" with "$7 by Visa ending 1111", "Requested, not
  yet confirmed" and `orders confirm <id>`. After the reload: "0 items".
- **Teardown:** `bin/nff --staging orders cancel <id> --refund`, then
  `orders delete <id>`, `customers delete <email>`, outbox cleared.

### PY-02 A delivery paid by card is confirmed at once

Automated: `payment.spec.mjs`, "a delivery paid by card is confirmed at
once". Tagged `@regression`.

- **Scenario:** Delivery needs no farm agreement.
- **Setup:** 5 wings, Delivery, phone, 12 Test Road, Scituate, 02857,
  cooler, first date.
- **Test:**
  1. Pay with the approved card.
- **Assert:** "$50"; "..., delivered to 12 Test Road."; no pickup
  request line. Record: `fulfilment.state` agreed; subtotal 5000,
  discount 500, fee 500, total 5000; phone kept. Outbox: "Your order is
  confirmed" with "Your payment of $50 came through and your order is
  confirmed."; the farm's "New order <id>" for "$50, delivery".
- **Teardown:** As PY-01.

### PY-03 A decline, then a good card for the new total

Automated: `payment.spec.mjs`, "a declined card says so, and the next
card pays the new total". Tagged `@regression`.

- **Scenario:** A decline is not a failure; the customer changes the
  cart and pays with another card, and is charged the new figure.
- **Setup:** 1 egg, Scituate, first date.
- **Test:**
  1. Pay with `4000 0000 0000 0002`.
  2. Add one more egg (Total $14); enter `4111 1111 1111 1111`; pay.
- **Assert:** Step 1: 402 with `declined: true`; the red message under
  the card form contains "declined"; the form stays;
  `bin/nff --staging orders list --email=<email>` prints "No orders.".
  Step 2: 200, "$14", Visa ending 1111; record total 1400 and
  `meta.attempt` 2 or more.
- **Teardown:** As PY-01.

### PY-04 A decline at the API

Automated: `orders-api.spec.mjs`, "a declined card answers 402 with the
customer's words and records nothing".

- **Scenario:** The server's decline answer and its record keeping.
- **Setup:** A valid one-egg pickup payload (`e2e/support/api.mjs`).
- **Test:**
  1. Post it with `cnon:card-nonce-declined`.
- **Assert:** 402, `declined` true, a `code`, a `message`; no order for
  the address.
- **Teardown:** None.

### PY-05 A total that moved is refused

Automated: `orders-api.spec.mjs`, "a total that differs from the
server's is refused, not charged".

- **Scenario:** The customer authorized the figure on screen; a
  different one is never charged.
- **Setup:** The payload with `claimedTotal` 600.
- **Test:**
  1. Post it.
- **Assert:** 422, "The total changed while you were on this page. Check
  it and pay again.", `totals.total` 700.
- **Teardown:** None.

### PY-06 Bad fields at the API

Automated: `orders-api.spec.mjs`, "bad fields answer 422, field by
field".

- **Scenario:** The server is the gate, whatever the page let through.
- **Setup:** No first name, email `not-an-email`, delivery to `10001`
  with one egg.
- **Test:**
  1. Post it.
- **Assert:** 422 with the first-name, email, phone ("Please enter a
  phone number."), ZIP ("That's outside our delivery area.") and
  minimum ("$40 or more") errors.
- **Teardown:** None.

### PY-07 The honeypot

Automated: `orders-api.spec.mjs`, "the honeypot is dropped silently".

- **Scenario:** A bot that fills the hidden field learns nothing.
- **Setup:** The payload with `website` set.
- **Test:**
  1. Post it.
- **Assert:** 204, empty body.
- **Teardown:** None.

### PY-08 A transient failure is retried

Automated: `recovery.spec.mjs`, "a transient failure shows the retry
panel, and Stop trying hands the form back".

- **Scenario:** A 503 leaves the order pending in the browser with a
  countdown, Try now and Stop trying.
- **Setup:** `/api/orders` stubbed in the browser to answer 503; a
  pickup order and the approved card (tokenized, never charged).
- **Test:**
  1. Press Place your order.
  2. Press Stop trying.
- **Assert:** The panel shows with Try now and a countdown; the submit
  button is disabled; `nff-order-pending` is in `localStorage`. After
  Stop trying: the panel is gone, the button enabled, the pending entry
  removed.
- **Teardown:** None.

### PY-09 A permanent failure goes to the by-hand card

Automated: `recovery.spec.mjs`, "a permanent failure shows the order to
send by hand". Finding D3, fixed by #156.

- **Scenario:** A 502 from the server is permanent (`docs/order-form.md`)
  and should not be retried for eight minutes.
- **Setup:** `/api/orders` stubbed to answer 502 `retryable: false`.
- **Test:**
  1. Press Place your order.
- **Assert:** Within 20 seconds, "Send this to us and we'll finish it by
  hand" with a summary containing "1 × Eggs" and "Total $7", a
  `mailto:` whose subject is "Order from the website", and a `tel:`
  link. The endpoint was called once.
- **Teardown:** None.

### PY-10 The card box

Partial: `cart-layout.spec.mjs`, "the card box hugs Square's field" at
1500, 1198 and 390. The two-row box on a phone is Square's own layout;
whether it looks right is a judgement.

- **Scenario:** Finding 13: an oversized card box.
- **Setup:** 1 egg, pickup; Card pressed.
- **Test:**
  1. Measure the iframe, Square's guidance line and the holder.
- **Assert:** Only Square's "Enter your card number" line sits under the
  field (within 16px); from 576 up the field is one row (60px or less).
  On an iPhone: the two rows look deliberate.
- **Teardown:** None.

### PY-11 Google Pay

Manual: the Google Pay sheet needs a signed-in Google account with a
card, which headless Chromium cannot provide.

- **Scenario:** A wallet pays the whole order in one step.
- **Setup:** Desktop Chrome signed in to Google with a test card; 1 egg,
  pickup, details filled.
- **Test:**
  1. Press Buy with G Pay; approve.
- **Assert:** The sheet shows $7; "paid with Google Pay"; record
  `payment.method` googlepay; emails as PY-01.
- **Teardown:** Cancel with `--refund`, delete, as PY-01.

### PY-12 Apple Pay

Manual: needs a real iPhone or Mac with Safari and the verified domain.

- **Scenario:** Apple Pay on the phone (worked for James on 2026-09-24).
- **Setup:** iPhone, Safari, sandbox Apple Pay; 1 egg, pickup, details.
- **Test:**
  1. Press Apple Pay; empty a required field first, then fill it and
     press again; approve with Face ID.
- **Assert:** With a field empty, nothing opens and the field is marked
  (the check runs inside the tap). Then "paid with Apple Pay", record
  `method` applepay.
- **Teardown:** As PY-11.

### PY-13 Cash App Pay

Manual: needs the Cash App sandbox approval on a phone.

- **Scenario:** The third wallet.
- **Setup:** Desktop, 1 egg, pickup, details.
- **Test:**
  1. Press Cash App Pay; scan the QR with the sandbox app; approve.
- **Assert:** "paid with Cash App Pay"; record `method` cashapp.
- **Teardown:** As PY-11.

### PY-14 Venmo, end to end

Manual: approval happens in PayPal's sandbox window with a sandbox buyer
account; never done yet (#151).

- **Scenario:** The full Venmo payment.
- **Setup:** A PayPal sandbox personal account with Venmo; 1 egg,
  pickup, details.
- **Test:**
  1. Press the Venmo button; sign in as the sandbox buyer; approve.
- **Assert:** "paid with Venmo"; record `payment.via` venmo,
  `paypalOrderId`, `paypalCaptureId`, `square.squareOrderId` and
  `payment.squarePaymentId` set; the Square sandbox order shows an
  external "Venmo" tender for $7; outbox "Payment received" and the
  farm's notice with "$7 by Venmo".
- **Teardown:** `bin/nff --staging orders cancel <id> --refund` (PayPal
  refunds; RF-05), then delete.

### PY-15 Venmo cancelled during approval

Manual: PayPal's window.

- **Scenario:** The customer closes PayPal's window.
- **Setup:** As PY-14.
- **Test:**
  1. Press Venmo; close the window.
  2. Next day, after PayPal has deleted the unapproved order: run the
     jobs (`bin/nff --staging jobs run`) and read the outbox.
- **Assert:** No order, no message; the form as it was. The jobs raise
  no alert for the abandoned checkout (a PayPal 404 means nothing to
  rescue, since 1c740aa), and the sweep drops it after a day.
- **Teardown:** None.

### PY-16 Venmo finished by the jobs

Manual: needs the network cut between approval and capture. Rewritten
for 384e37c: the capture webhook no longer finishes orders; the jobs
do, once PayPal has left the checkout alone for ten minutes.

- **Scenario:** The browser closes after approval, before the page
  sends its capture; the jobs capture and record the order.
- **Setup:** As PY-14, DevTools open.
- **Test:**
  1. Approve; set the network offline before the capture request.
  2. Wait ten minutes; run the jobs (`bin/nff --staging jobs run`, or
     wait for the schedule).
  3. Go back online and let the page retry its capture.
- **Assert:** One order, paid, with `paypalCaptureId` set; stock taken
  once; one "Payment received" and one farm notice in the outbox. The
  page's retry answers with the same record rather than asking the
  customer to start again. No `paypal.webhook` line finishes the
  order; it only notes the delivery.
- **Teardown:** As PY-14.

### PY-16b A Venmo capture the page finishes is written once

Manual: PayPal's window.

- **Scenario:** Before 384e37c the capture webhook and the page both
  finished the order, writing it twice.
- **Setup:** As PY-14.
- **Test:**
  1. Pay by Venmo normally; wait a minute for the webhook.
- **Assert:** One record for the PayPal order; stock taken once; one
  "Payment received" and one farm notice.
- **Teardown:** As PY-14.

### PY-17 Venmo when Square is down

Manual: needs a preview with a broken Square token.

- **Scenario:** Captured money is recorded even when Square is not.
- **Setup:** A preview with a wrong `SQUARE_ACCESS_TOKEN`.
- **Test:**
  1. Pay by Venmo.
  2. Restore the token; run the jobs.
- **Assert:** The record is written with `square: null`; the farm gets
  "Site alert: square.record_failed"; after the jobs run the record has
  its Square copy.
- **Teardown:** Refund and delete.

### PY-18 A rate-limited order must not say it is placed

Automated: `rate-limit.spec.mjs`, both tests, with `E2E_LOCKOUT=1`
only, since it locks this address out of `/api/orders` for ten minutes;
the page alone, stubbed, in `recovery.spec.mjs`, "too many tries says
so by the Pay button and keeps the order" and "an empty 204 is never
taken for a placed order". Finding D4, fixed by #154; passed on staging
2026-09-24.

- **Scenario:** After 12 requests from one address in 10 minutes the
  endpoint once answered 204, and the page showed "Your order is placed"
  for an order that was never charged or recorded.
- **Setup:** None; the spec sends cheap requests (no submission key,
  refused with 422 after they are counted) until the limit answers.
- **Test:**
  1. Post until the endpoint answers 429; post the honeypot.
  2. On the page: 1 egg, pickup, details, the approved card; press
     Place your order.
- **Assert:** 429 with `Retry-After: 600` and the message "There have
  been too many tries from here. Wait a few minutes and try again; your
  order is saved on this page."; the honeypot still gets 204. The page
  shows that message by the Pay button, no "Your order is placed", the
  button enabled, the cart kept; `orders list` finds nothing.
- **Teardown:** None (nothing is recorded).

## After the order

### AO-01 A sign-in link, used once

Automated: `account.spec.mjs`, "a link by email signs in, once". Tagged
`@regression`.

- **Scenario:** Magic-link sign-in, and its single use.
- **Setup:** A paid order for a unique address, placed at the API with
  `cnon:card-nonce-ok`.
- **Test:**
  1. `/login/`; request a link for the address.
  2. Open the link from the outbox.
  3. Clear cookies; open it again.
- **Assert:** "Check your email" naming the address; the outbox has
  "Your secure sign-in link to North Foster Farm" with a link to the
  staging host; it lands on `/account/` showing the address; the second
  use lands on `/login/` with "already used".
- **Teardown:** The order cancelled with `--refund` and deleted; the
  customer deleted; the outbox cleared.

### AO-02 Orders and receipts on the account page

Automated: `account.spec.mjs`, "the account page lists the order and its
receipt".

- **Scenario:** A customer sees their order and its payment.
- **Setup:** As AO-01, signed in.
- **Test:**
  1. Read the Orders tab; open Receipts.
- **Assert:** The order number; "Pickup time requested. We'll confirm it
  by email."; a receipt row with the number, "Visa ending" and four
  digits, $7. No "Pay now" and no "I paid by Venmo" anywhere.
- **Teardown:** As AO-01.

### AO-03 Find my order (removed)

The feature was removed on 2026-09-25 (#150); a customer reaches an
order by signing in. The number stays so later cases keep theirs.

### AO-04 Sign-in links are rate limited

Automated: `account.spec.mjs`, "a fourth link is refused quietly, the
first three kept". Passed on staging 2026-09-25.

- **Scenario:** Three links per address per 15 minutes.
- **Setup:** A unique address.
- **Test:**
  1. Request four links from `/login/`.
- **Assert:** The same "Check your email" each time; three messages in
  the outbox; the first and third links still sign in.
- **Teardown:** Delete the customer; clear its messages.

### AO-05 The farm confirms a pickup

Manual: a CLI step with emails to read; automatable later.

- **Scenario:** The farm agrees to an on-farm window.
- **Setup:** A paid on-farm order, placed for the purpose.
- **Test:**
  1. `bin/nff --staging orders confirm <id>`
  2. Run it again.
- **Assert:** "Your order is confirmed" with "Your payment of $7 came
  through and your pickup time is set" and "When:";
  `fulfilment.state` agreed. The second run sends nothing.
- **Teardown:** Cancel with `--refund`; delete.

### AO-06 The farm denies a pickup

Manual: several emails and pages across a week-long link.

- **Scenario:** A denied window: the customer picks again or cancels for
  a refund.
- **Setup:** A paid on-farm order.
- **Test:**
  1. `bin/nff --staging orders deny <id> --reason "We're at the market
     that morning."`
  2. Open "Pick a new time" from the outbox; change the window; save.
  3. On a second order, cancel from the card instead.
- **Assert:** "One more step: pick a new pickup time" with the reason
  and a "Pick a new time" button; the card says "We can't do that
  pickup time"; after the change "Your order is updated" and the farm's
  "Pickup time to confirm: <id>", `question.answer` reschedule,
  `fulfilment.state` requested. After the cancel: "We're refunding this
  order", the farm's "Refund needed" naming `orders cancel <id>
  --refund`, `cancelRequested` true, still paid.
- **Teardown:** `orders cancel <id> --refund` for both; delete.

### AO-07 A customer cancels

Manual: as AO-06, step 3, on a delivery order.

- **Scenario:** Cancel before the cutoff from the account page.
- **Setup:** A paid delivery order; signed in.
- **Test:**
  1. Cancel from the order card.
- **Assert:** "Your order is cancelled" saying the refund is on its way;
  the farm's "Refund needed"; stock released.
- **Teardown:** `orders cancel <id> --refund`; delete.

### AO-08 A customer changes an order

Manual: automatable; not yet written.

- **Scenario:** Date, window, phone and drop-off details change; items
  do not.
- **Setup:** A paid delivery order; signed in.
- **Test:**
  1. Change the date and the cooler note; save.
- **Assert:** "Your order is updated"; the Square order's fulfilment
  moves; no `squareOutOfSync`.
- **Teardown:** Cancel with `--refund`; delete.

### AO-09 The morning report and the manifest

Manual: needs the toolbar's token (or `STAGING_TOKEN`) for the jobs.

- **Scenario:** The daily reports the farm lives by.
- **Setup:** An on-farm order still requested within two days.
- **Test:**
  1. Toolbar: tick "Send today's reports again"; press As 8:00 today.
  2. Press As 18:00 today.
- **Assert:** "Morning report: <today>" with the vitals (placed, by card,
  by Venmo, declined, cancelled, refunded, open) and the pickup with its
  confirm command; "Tomorrow, <date>: N orders" grouped by method.
- **Teardown:** Cancel and delete the order; clear the reports' mail.

### AO-10 The delivery reminder

Manual: needs a delivery order due tomorrow and a jobs run at 18:00.

- **Scenario:** The cooler reminder the evening before, and its opt-out.
- **Setup:** A paid delivery order for the next delivery date, the day
  before it.
- **Test:**
  1. As 18:00 today; then turn reminders off in Settings and repeat on
     another order.
- **Assert:** "Your delivery is tomorrow" with a "Turn off delivery
  reminders" link; with it off, the run reports it `muted` and sends
  nothing.
- **Teardown:** Cancel and delete.

### AO-11 The emails on an iPhone

Manual: real iOS Mail rendering.

- **Scenario:** Finding 19: the farm's phone number turns blue and
  underlined on iOS.
- **Setup:** A real send to James's inbox (a preview with Resend), or
  the outbox HTML opened in iOS Safari.
- **Test:**
  1. Open "Payment received" and the farm-news confirmation in iOS Mail.
- **Assert:** The footer's phone number keeps the text color, no
  underline; layout intact.
- **Teardown:** None.

### AO-12 The order tells the customer they have an account

Pending: #114.

- **Scenario:** One line at order time: this email is now an account,
  signed in by emailed link.
- **Setup:** `ACCOUNTS_ENABLED=true`; a card order.
- **Test:**
  1. Pay; read the success card and the confirmation email.
- **Assert:** One line on each, in James's wording, only when accounts
  are on.
- **Teardown:** Cancel and delete.

### AO-13 No invoice or payment-link copy remains

Partial: `wording.spec.mjs` (desktop) reads ten pages and `llms.txt`,
and follows the retired paper form. Passed on staging 2026-09-25, since
ff8afe7 and 704412f. The cancel dialog needs a signed-in customer with
an order and stays manual. The account menu is settled: "Your orders"
has its own icon, and the invoice icon marks "Receipts".

- **Scenario:** The invoice era's words are gone.
- **Setup:** Staging.
- **Test:**
  1. Open `/`, `/order/`, `/login/`, `/account/`, `/delivery-policy/`,
     `/privacy/`, `/about/`, `/contact/`, `/news/`, `/accessibility/`;
     fetch `/llms.txt`.
  2. Request `/order-form.pdf` without following redirects.
  3. By hand: open the cancel dialog on an order.
- **Assert:** No "invoice", "invoices", "payment link" or "Pay to
  confirm" in any page's text, meta description or share
  description, in `llms.txt`, or in the dialog; no "market pickup" in
  `llms.txt`; the paper form answers 301 to `/order/`.
- **Teardown:** None.

## Refunds and the CLI

Every command here runs from the checkout root with `.env.staging`
present. The automated specs refund and delete their own orders, so
place one for the purpose: by hand, or at the API as
`e2e/support/api.mjs` does with `cnon:card-nonce-ok`.

### RF-01 A partial card refund

Manual: money leaves through the CLI, by design.

- **Scenario:** Short one dozen.
- **Setup:** A paid card order <id>.
- **Test:**
  1. `bin/nff --staging orders refund <id> --amount 5 --reason "Short
     one dozen"`
  2. The same again.
- **Assert:** "Refunded $5 of $X by Visa ending 1111"; `refund.amount`
  500, `refund.total` false; the Square sandbox shows the refund; the
  account card says "Refunded $5 on <date>". The second run is refused:
  "Already refunded $5 on <date>".
- **Teardown:** `bin/nff --staging orders cancel <id>`; delete.

### RF-02 Cancel with refund

Manual; every automated payment's teardown runs it, without asserting.

- **Scenario:** The farm cancels and refunds.
- **Setup:** A paid card order.
- **Test:**
  1. `bin/nff --staging orders cancel <id> --refund`
- **Assert:** `status` cancelled, `refund.total` true, stock back, the
  Square fulfilment Canceled, "Your order is cancelled" saying the
  refund is on its way.
- **Teardown:** `bin/nff --staging orders delete <id>`.

### RF-03 Cancel without refund

Manual.

- **Scenario:** An order cancelled without money back.
- **Setup:** A paid order.
- **Test:**
  1. `bin/nff --staging orders cancel <id>`
- **Assert:** The email says "Nothing more will be charged"; no
  `refund`.
- **Teardown:** Refund in the Square sandbox dashboard (which is RF-04);
  delete.

### RF-04 A refund made in Square's dashboard

Manual: Square's dashboard.

- **Scenario:** `refund.updated` reaches the record.
- **Setup:** A paid card order.
- **Test:**
  1. Refund it in the Square sandbox dashboard.
- **Assert:** Within a minute `orders show <id>` has `refund` with
  `source` square.
- **Teardown:** Cancel; delete.

### RF-05 A Venmo refund from the CLI

Manual: needs a Venmo order (PY-14).

- **Scenario:** Venmo money goes back through PayPal (#151).
- **Setup:** Two paid Venmo orders.
- **Test:**
  1. `bin/nff --staging orders refund <id1> --amount 2`
  2. `bin/nff --staging orders cancel <id2> --refund`
- **Assert:** PayPal refunds each capture; the Square tender is noted as
  refunded; <id2> cancelled with stock back and the refund email. The
  refund webhook PayPal sends afterwards adds nothing: Square's
  refunded amount for each order equals the CLI's, not twice it
  (7743382 brings Square up to PayPal's running total).
- **Teardown:** Delete both.

### RF-06 A refund made in PayPal

Manual: PayPal's sandbox dashboard. Before 7d86478 this failed: the
webhook looked the order up by the refund's id and answered "unknown
capture"; it now takes the capture from the refund's "up" link.

- **Scenario:** `PAYMENT.CAPTURE.REFUNDED` reaches the record.
- **Setup:** A paid Venmo order.
- **Test:**
  1. Refund the capture in the PayPal sandbox; do it once in full and,
     on a second order, once in part.
  2. Read the function log's `paypal.webhook` line, the record and
     the order in the Square sandbox.
  3. Resend the webhook from PayPal's dashboard.
- **Assert:** No "unknown capture" in the log; `refund.source` paypal
  on the record, `refund.amount` what PayPal refunded, and
  `refund.total` true for the full refund and false for the partial
  one, as RF-01 records a partial card refund. Since 7743382 Square's
  external payment shows the same refunded amount as PayPal; the
  resent webhook refunds nothing more. If Square refuses, the PayPal
  refund is still recorded and the outbox has a
  `square.refund_failed` alert.
- **Teardown:** Cancel; delete.

### RF-07 Confirm and deny guard themselves

Manual.

- **Scenario:** Only on-farm orders need agreement.
- **Setup:** A paid delivery order.
- **Test:**
  1. `bin/nff --staging orders deny <id> --reason "x"`
- **Assert:** Refused with "Only an on-farm pickup needs confirming."
- **Teardown:** Cancel with `--refund`; delete.

### RF-08 Nothing left unpaid before the deploy

Manual: James only; it reads production.

- **Scenario:** `docs/order-form.md`, "Before it ships", item 4.
- **Setup:** Production `.env`.
- **Test:**
  1. `bin/nff orders list --status=submitted`
- **Assert:** "No orders."
- **Teardown:** None.

## Farm news

### FN-01 Sign up, confirm, opted in

Automated: `news.spec.mjs`, "the footer sign-up asks, the email
confirms, the click opts in". Tagged `@regression`.

- **Scenario:** Double opt-in from the footer, in James's wording
  (finding 18).
- **Setup:** A unique address.
- **Test:**
  1. Home page footer: type the address; press Sign me up.
  2. Read the outbox; check the record; open the link; open it again.
- **Assert:** The note says "Check <address> for an email from us." and
  the field empties. The email's subject is "Confirm your email for
  North Foster Farm news and updates"; it reads "Click the button below
  to receive news and updates from North Foster Farm.", has a "Sign up"
  button, "This link expires in 7 days. If you didn't request this
  email, you can safely ignore it." and "Need help? Contact us", and
  says neither "now and then" nor "Nothing is sent until you do". Before
  the click the record is absent or not consenting. The link, to the
  staging host, lands on `/news/` with "You're on the list. Thanks!";
  the record has `marketing` true and a `marketingAt`. The second click
  says "That link isn't valid any more."
- **Teardown:** `customers delete`; the message removed.

### FN-02 A bad address

Automated: `news.spec.mjs`, "an address that is not one is refused at
the field".

- **Scenario:** No request for a malformed address.
- **Setup:** Home page.
- **Test:**
  1. Type `not-an-email`; press Sign me up.
- **Assert:** "Enter a valid email address, like you@example.com." (the
  wording since #141); no request sent.
- **Teardown:** None.

### FN-03 The news page has the sign-up

Automated: `news.spec.mjs`, "the news page carries the same sign-up".

- **Scenario:** The second place to sign up.
- **Setup:** None.
- **Test:**
  1. Open `/news/`.
- **Assert:** A sign-up form is visible.
- **Teardown:** None.

### FN-04 Sign-up requests are rate limited

Manual: automatable; not yet written.

- **Scenario:** The confirmation cannot be used to flood an inbox, and
  the answer never reveals who is on the list.
- **Setup:** A unique address.
- **Test:**
  1. Sign up four times in a minute.
- **Assert:** The same answer each time; no more messages than the
  sign-in limit allows.
- **Teardown:** Delete the customer; clear the messages.

### FN-05 An expired confirmation

Manual: the link lives seven days.

- **Scenario:** A week-old link.
- **Setup:** A confirmation requested eight days ago, or a preview with
  a shortened lifetime.
- **Test:**
  1. Open the link.
- **Assert:** `/news/` says "That link had expired. Enter your email
  again and we'll send a fresh one."
- **Teardown:** Delete the customer.

### FN-06 The settings box

Manual: automatable with a sign-in; not yet written.

- **Scenario:** The account page's "Farm news" box writes the same
  consent.
- **Setup:** Signed in.
- **Test:**
  1. Tick the box; untick it.
- **Assert:** `marketing` true, then false, each with a new
  `marketingAt`.
- **Teardown:** Delete the customer.

### FN-07 The audience sync

Pending: `RESEND_AUDIENCE_ID` and `RESEND_AUDIENCE_KEY` are not set.

- **Scenario:** Consent flows to Resend and unsubscribes flow back.
- **Setup:** A Resend test audience; one consenting and one withdrawn
  record.
- **Test:**
  1. `bin/nff --staging audience sync --dry-run`, then without it.
  2. Unsubscribe the first in Resend; sync again.
- **Assert:** The consenting record is added, the withdrawn one marked
  unsubscribed; after step 2 the record says `marketing` false with
  `marketingSource` resend.
- **Teardown:** Remove both contacts and records.

## The autumn refresh

None of these is built yet. Each case is written from its issue so it
is ready when the pull request reaches staging; most can be automated
then.

### AR-01 Hero video (#133)

Automated: `home.spec.mjs`, "the photograph paints first, then the
light clip plays over it" (both projects). The absence of a flash was
judged by eye on 2026-09-24.

- **Scenario:** The hero plays the coop video, muted and looping, over
  its poster.
- **Setup:** Home page.
- **Test:**
  1. Load the page; watch the network and the hero.
- **Assert:** The video is `muted`, `playsinline` and `loop`; it has no
  sources until the photograph has painted (better than the issue's
  `preload="metadata"`), and the first request for the clip comes
  after the photograph's; it plays, the hero gains `is-ready`, and
  the encode chosen is under 1.5 MB.
- **Teardown:** None.

### AR-02 Pausing offers to stop autoplay (#133)

Automated: `home.spec.mjs`, "a pause offers to stop autoplay, and the
choice holds site-wide" (both projects; hover on desktop) and "the
play button can be reached by keyboard" (desktop). Wording is a draft
for James.

- **Scenario:** A visitor who pauses is offered to stop videos playing
  on their own.
- **Setup:** Home page.
- **Test:**
  1. Hover the hero; press pause; press Turn off autoplay; reload.
  2. Play and pause again; open the about page's clip.
  3. Tab to the control with the keyboard; press Enter.
- **Assert:** The control shows on hover and on focus. After a pause
  it reads "Play video" and the note offers "Stop videos playing on
  their own? Turn off autoplay"; after the click it reads "Videos here
  will wait for you to press play." and `nff:autoplay` is `off`. After
  the reload no clip is fetched and the photograph and the button
  show; a second pause offers nothing; the about page's clip waits
  too. Enter on the focused control pauses.
- **Teardown:** None (a fresh browser per test).

### AR-03 Reduced motion and the account setting (#133)

Partial: with reduced motion the hero fetches no clip and waits for
play, and a pause then offers nothing, in `home.spec.mjs`, "with
reduced motion the photograph stays until play"; the about page's clip
obeys reduced motion and a stored `off` (AR-24). Save-Data and the
account setting are still to come: the account half of #133 has not
landed.

- **Scenario:** `prefers-reduced-motion` and Save-Data count as autoplay
  off; a signed-in customer's choice follows them.
- **Setup:** Emulated reduced motion; then a signed-in customer.
- **Test:**
  1. Load the home page with reduced motion.
  2. Signed in, turn autoplay off in Settings; sign in on a second
     browser.
- **Assert:** No autoplay with reduced motion or Save-Data; the setting
  on the record is adopted by the second browser; the about page's
  video obeys it too.
- **Teardown:** Delete the customer.

### AR-04 Hero size, type and tint (#134)

Automated: `home.spec.mjs`, "the hero's height, tint and type (#134)"
(both projects). Checked by eye at 390 and 1500 on 2026-09-24. The
wordmark is the header's logo.

- **Scenario:** James's hero adjustments.
- **Setup:** Home page at 320, 390, 575, 576, 768, 990, 1500 and 2560
  wide.
- **Test:**
  1. Measure the hero, the title and the h1 at each width.
- **Assert:** The title runs three lines below 576 and two from 576 up,
  and its words stay inside the window and their column at every width
  (it never wraps on its own); height at most 1300px; below 576 the big
  line at least 1.8 times the h1; from 768 up the h1's stroke at least
  2.5px; the picture under `brightness(0.82)`; the header's wordmark in
  `--bs-primary`.
- **Teardown:** None.

### AR-04b The hero and header fill the window

Automated: `home.spec.mjs`, "the hero and header fill the window
exactly" (both projects). Failed from 768 up until 97adf24; passes
since.

- **Scenario:** The hero reserves the header's height so the two fill
  the first screen and nothing of the next section peeks in.
- **Setup:** Home page at 390, 767, 768, 1199 and 1500 wide, 900 tall,
  and 1500 by 1300.
- **Test:**
  1. Read the hero's bottom edge.
- **Assert:** Within 1px of the window's bottom. Today it stops 13px
  short from 768 up (header 55px, 4.25rem reserved).
- **Teardown:** None.

### AR-05 Hero buttons on hover (#135)

Automated: `home.spec.mjs`, "Order now stays pure white on hover and
lifts" (desktop). Whether the softer shadow looks right is by eye.

- **Scenario:** The white CTA stays pure white on hover.
- **Setup:** Home page, desktop.
- **Test:**
  1. Hover "Order now".
- **Assert:** Background and border `rgb(255, 255, 255)` on hover, the
  text color unchanged, a shadow that it lacks at rest.
- **Teardown:** None.

### AR-06 Header button border on hover (#135)

Automated: `home.spec.mjs`, "header links ease in a gray border without
changing size" (desktop, at 1500 and 390). Checked by eye 2026-09-24:
light but visible.

- **Scenario:** A light gray border eases in without moving anything.
- **Setup:** A header text link at 1500; the menu toggle at 390.
- **Test:**
  1. Measure the link; hover; measure again.
- **Assert:** Transparent border at rest, a colored one of the same
  width on hover, `border-color` in the transition; same width and
  height; the same lift shadow as every other button.
- **Teardown:** None.

### AR-07 Wide buttons on phones only (#135)

Automated: `home.spec.mjs`, "Shop all products is wide on phones only"
(desktop, at 1500 and 390).

- **Scenario:** "Shop all products" matches the hero buttons' padding
  above phone width.
- **Setup:** 1500 and 390.
- **Test:**
  1. Compare its horizontal padding with the hero buttons'.
- **Assert:** Equal padding and narrower than 24rem at 1500; the full
  container width at 390.
- **Teardown:** None.

### AR-08 The home news section (#136)

Automated: `home.spec.mjs`, "the post in full, linked to its own page"
and "the post's page is canonical, and the home page is its own" (both
projects); `map.spec.mjs`, "the news post's ZIP button leads to the
map's check", which fails on the phone project today (#159). The
invoice wording on `/` is AO-13's.

- **Scenario:** The September post lives at `/news/<slug>/` and is shown
  in full on the home page.
- **Setup:** Home page; the post page; the news list.
- **Test:**
  1. Read the home section; press Check your ZIP code.
  2. Open the post; open the news list.
- **Assert:** "News and updates"; "September Update" linking to
  `/news/2026-09-22-september-update/`; "September 22, 2026" dated
  `2026-09-22`; the "Do we deliver to you?" row with "Check your ZIP
  code" and no ZIP check in the card; an outline button to `/news/`;
  the text no wider than 600px and, from 992 up, 52px of padding each
  side. The button lands on the map with its ZIP field on screen. The
  post's canonical URL is its own, the home page's is `/`, its ZIP
  button points at `/#map`, and the news list links to it.
- **Teardown:** None.

### AR-09 The off-season band (#137)

Automated: `home.spec.mjs`, "three ways to buy, in the market band's
place" and one test per button (both projects). The pickup and drop
site buttons fail today: #163. That the market band returns on May 15
needs a build in season and is not tested; the switch is in
`layouts/index.html`.

- **Scenario:** Three ways to buy, each with a button that preselects
  it on the order page.
- **Setup:** Home page, out of season.
- **Test:**
  1. Read the three columns; press each button.
- **Assert:** "No off-season" and "Three ways to get your order, all
  winter"; each column's icon, name, when, where and cost as
  `data/delivery.json` has them (by appointment at the farm's
  address; Saturdays 10:00 – 11:00 AM at the Village Green, "starting
  October 17" until then; every Thursday 10:00 AM – 4:00 PM, $40
  minimum, $5 fee); "The farmers markets return in June."; each
  button lands on `/order/` with that method checked.
- **Teardown:** None.

### AR-10 The map's areas (#138)

Automated: `map.spec.mjs`, "three fills: ours, the rest of Rhode
Island, the neighbours" and "the key's swatches match the map's fills"
(both projects). Rewritten for 17b929e, which gave Rhode Island's
other ZIPs their own fill. Connecticut's eggs-only rule is still not
on the map (raised on #138).

- **Scenario:** Delivery ZIPs, the rest of Rhode Island and the
  neighbours each in their own fill, from the same data as the form.
- **Setup:** Home page map row.
- **Test:**
  1. Compare every ZIP on the map with the delivery area the page's
     ZIP check carries; read each fill and the key's swatches.
- **Assert:** Every ZIP is five digits (the minifier once dropped the
  leading zero); each has exactly one of `is-ours`, `is-away`,
  `is-land`, and `is-ours` exactly when the area lists it; Rhode
  Island's (028, 029) are never plain land; one fill per class, three
  in all; the swatches "We deliver here" and "A little outside our
  area" match their fills; the SVG is titled; no request leaves the
  site.
- **Teardown:** None.

### AR-11 The ZIP check drops a pin (#138)

Automated: `map.spec.mjs`, "a ZIP typed in drops a visible pin on its
middle", "a tap on a town runs the check and drops the pin", "a town
names itself under the pointer" (desktop) and "with reduced motion the
pin appears without falling" (both projects).

Until 17b929e the dropped pin never showed: the script set a `hidden`
property that SVG groups do not have. The earlier test read that same
property and passed; it now asks whether the pin renders.

- **Scenario:** Typing or tapping a ZIP drops a pin at its center with
  the answer.
- **Setup:** Map row.
- **Test:**
  1. Type `02857`, `02802`, `10001`; type `02857` and clear the field.
  2. Tap North Scituate on the map.
  3. Hover a town.
  4. Again with reduced motion.
- **Assert:** `autocomplete="off"`. No pin at first. 02857: a visible
  pin, "02857 <town>: We deliver here", its outline drawn, the pin at
  its middle. 02802: "… A little outside our area", amber, likewise.
  10001, off the map, and a cleared field: no pin, and the words still
  answer. A tap fills the field with 02857, the check answers "We
  deliver to …", and the pin shows. Hovering names the town and our
  answer. Under reduced motion the pin shows without the fall.
- **Teardown:** None.

### AR-11b Pin cards and zoom (#138)

Automated: `map.spec.mjs`, "a pin opens its card; Escape closes it to
the pin", "a line in the key opens the same card" and "zoom in and
out; pins keep their size" (both projects). Pinch, trackpad pinch and
drag-to-pan are by hand on a phone and a laptop.

- **Scenario:** 17b929e made the map interactive.
- **Setup:** Map row.
- **Test:**
  1. Focus pin 1; press Enter; press Escape.
  2. Press the key's line for pin 3; press its Close.
  3. Press Zoom in, then Show the whole map.
- **Assert:** Pin 1's card opens with focus on "Our farm", the pin
  `aria-pressed`, a Google Maps "Directions" link and "Shop for pickup"
  to `/order/?method=onfarm` (which lands on Delivery until #163 is
  fixed), inside the map's frame; Escape closes it and returns focus to
  the pin. The key opens pin 3's card, on screen, reading "Out of
  season". Zoom in halves the view, enables Zoom out and shows the
  reset, and pins stay the same size on screen; the reset restores the
  whole map.
- **Teardown:** None.

### AR-12 The map on the delivery policy (#138)

Automated: `map.spec.mjs`, "the delivery policy carries the same map"
(both projects).

- **Scenario:** The same map on `/delivery-policy/`.
- **Setup:** Delivery policy page.
- **Test:**
  1. Load it; type `02857` in its ZIP check.
- **Assert:** The map renders with our ZIPs filled; the field has
  `autocomplete="off"`; the pin drops as on the home page.
- **Teardown:** None.

### AR-13 Markets and pop-ups on the map (#138)

Partial: `map.spec.mjs`, "the key matches the pins, what is on now
first" and "no pin hides another" (both projects). The second failed
until 17b929e stood crowded pins apart. Rewritten for 0660a0d, which
puts what is on now first and gives the farm its hen. Dropping 2026's
pop-ups needs a build after New Year and stays manual.

- **Scenario:** What is on now (the farm, the drop site, upcoming
  pop-ups, markets in season) is solid and listed first; the rest
  (earlier pop-ups, markets out of season) is hollow and listed last,
  with inline Instagram icons; 2026 pop-ups disappear when 2027
  starts.
- **Setup:** Home page; for the rollover, a build with the clock set to
  2027-01-01 (preview).
- **Test:**
  1. Read the pins and the key.
  2. Compare every pair of pins' boxes.
  3. By hand: build on or after 2027-01-01 and read the pins.
- **Assert:** One pin per key line, alike in number, name and on or
  off. "Our farm" first, with no number (the hen) and labeled "Our
  farm"; the rest numbered 1 on in key order. Every "on" line before
  every "off" line; "off" pins drawn first, so "on" pins sit over
  them. Headings "Pick up from us", "Upcoming pop-ups", "Earlier
  pop-ups in 2026", "Farmers markets, out of season"; the three
  market pins off. Each Instagram link is an icon labeled "on
  Instagram". No two pins share more than a quarter of their box.
  After New Year: no 2026 pop-ups.
- **Teardown:** None.

### AR-14 The pop-up banner (#139)

Automated: `top-bar.spec.mjs`, every test (both projects). The build
side of retiring (the next build skips an ended event) needs a build
after October 18 and is not tested. The wording is a draft for James;
there is no dismissal.

- **Scenario:** A thin site-wide bar for the October 18 pop-up that
  retires itself.
- **Setup:** The home page and six others; the browser's clock set
  either side of 2:00 PM on 2026-10-18.
- **Test:**
  1. Read the bar at 1500, 990, 576, 575, 390 and 320.
  2. Open `/order/`, `/about/`, `/contact/`, `/news/`,
     `/delivery-policy/`, `/login/`.
  3. Load the home page at 1:59 PM and 2:01 PM that day.
- **Assert:** From 576 up "Pop-up at The Village Family Fitness in
  Warwick, Sunday, October 18, 10:00 AM – 2:00 PM"; below, "Pop-up at
  The Village Family Fitness, Sun, Oct 18"; always one 30px line, with
  no ellipsis from 390 up, the header right under it, and a link to
  the host's Instagram in a new tab. On every page. At 1:59 the bar
  shows; at 2:01 it is gone and the hero reserves no room for it.
- **Teardown:** None.

### AR-15a The contact page (#140)

Automated: `contact.spec.mjs`, every test (both projects), with
`/api/contact` stubbed: the function is the checkout lane's and answers
404 on staging today, so a real message fails with "We couldn't send
that just now." until it lands.

- **Scenario:** The page and its form, before the function.
- **Setup:** `/contact/`.
- **Test:**
  1. Read the heading, the lead and the ways to reach the farm; follow
     "contact form".
  2. At 390, compare the ways and the form.
  3. Send empty; send with `you@farm`, then add `.com`.
  4. Send a good message and an order number while the answer is held;
     press again; release.
  5. Send with a 422 for the order number, then with a 500.
- **Assert:** "Don't be a chicken. Talk to us." and James's lead; call
  or text, email, Instagram and the farm, with "by appointment"; the
  link lands on the form; the honeypot is hidden and out of the tab
  order. On a phone the form sits under the ways. Empty: "Tell us your
  name.", "Enter your email address, so we can answer.", "Write us a
  message first.", Name focused, nothing sent. A bad address is named
  and its error clears once put right. The post carries name, order
  number, message and an empty `website`; the button shows the egg and
  "Sending" at its width; one request only; then "Thanks, we have it"
  with the address. A 422 lands under its field; a 500 shows the alert
  and keeps the message.
- **Teardown:** None.

### AR-15 The contact form (#140)

Pending: the function, the home band's new heading and the prefill of
a signed-in customer's order number have not landed.

- **Scenario:** A visitor writes to the farm from `/contact/`.
- **Setup:** A unique address.
- **Test:**
  1. Home band: check the heading "Don't be a chicken. Talk to us." and
     the lead; follow "contact form".
  2. Send a message.
- **Assert:** The farm's email in the outbox with reply-to set to the
  writer; an acknowledgement to the writer; a `messages/<id>` record.
- **Teardown:** `bin/nff --staging messages done <id>`; clear the
  outbox.

### AR-16 The contact form refuses abuse (#140)

Pending.

- **Scenario:** Validation, honeypot, five per address per ten minutes.
- **Setup:** `/contact/`.
- **Test:**
  1. Send empty; send with the honeypot; send six in a row.
- **Assert:** Field errors; the honeypot silently dropped; the sixth
  refused or dropped.
- **Teardown:** Mark them done; clear the outbox.

### AR-17 Unanswered messages are chased (#140)

Pending.

- **Scenario:** The farm is reminded daily until every message is
  answered.
- **Setup:** One unanswered message.
- **Test:**
  1. `bin/nff --staging messages`; As 8:00 today; `messages done <id>`;
     As 8:00 again with "Send today's reports again".
- **Assert:** Listed with its age; in the morning report; gone from both
  once done.
- **Teardown:** Clear the outbox.

### AR-18 The footer sign-up (#141)

Automated: `footer.spec.mjs`, "a bad address is marked at the field,
and fixing it clears it" and "while it sends, the button shows the egg
and keeps its width" (both projects). The request is stubbed and held,
so nothing is mailed; FN-01 covers the real sign-up.

- **Scenario:** An input group with a floating label and an egg
  spinner.
- **Setup:** Home page.
- **Test:**
  1. Press Sign me up empty; submit `nope` and `you@farm`; type a
     valid address.
  2. Submit a valid address while the answer is held; press again.
- **Assert:** Nothing under the field at rest. "Enter your email
  address." when empty; "Enter a valid email address, like
  you@example.com." with the field marked invalid and focused for both
  bad addresses; the mark clears once the address is valid. While
  held: `data-state="busy"`, "Submitting" and the egg spinner faded in,
  "Sign me up" faded out, the button's width unchanged, the line under
  the field empty, and the second press sends nothing. Then the
  "Check … for an email from us" answer at the same width.
- **Teardown:** None.

### AR-19 The footer layout (#141)

Automated: `footer.spec.mjs`, "the links, then how to reach the farm,
then the copyright" and "no row of the dotted lines opens with a dot,
at any width" (both projects). "More room above" is by eye: checked at
1500 and 390 on 2026-09-24.

- **Scenario:** More room above; links on one line with dots that never
  start a wrapped line.
- **Setup:** Home page.
- **Test:**
  1. Read the footer's lines.
  2. At 1500, 990, 575, 390 and 320, group each line's items by row.
- **Assert:** Links in the order About, Account, News, Accessibility,
  Privacy, Delivery, Contact (once `/contact/` exists, #140), Order,
  llms.txt; then the phone, the email and @northfosterfarm, linked;
  then the copyright with this year. Every row opens without a dot and
  every other item has one; at least one line wraps.
- **Teardown:** None.

### AR-20 The search palette opens and closes (#142)

Automated: `search.spec.mjs`, "cmd/ctrl K opens it, arrows move,
Escape closes to the button", "the button opens it; a click outside,
or Esc, closes it", "it reopens right after it closes" and "words
people use find the products, and nonsense says so". The reopen test
fails today: a line in #159.

- **Scenario:** Command or Control K, from any page.
- **Setup:** Home page.
- **Test:**
  1. Press Control K; type "wing"; arrow down; Tab twelve times;
     Escape.
  2. Open with the search button; click outside (on a phone, press
     Esc).
  3. Open, Escape, and press Control K again 250 ms later.
  4. Search "egg", "breast", "drumstick", "whole", then "zzz".
- **Assert:** Focus in the combobox; the button's `aria-expanded` is
  true; the first match is selected and named by
  `aria-activedescendant`, and its card shows its group and price; the
  arrow moves both. Tab never reaches the page behind (a modal dialog
  hands focus to the browser's own controls after its last field,
  which is acceptable). Escape or a click outside closes it and focus
  returns to the button. It reopens at once. Each word finds its
  group; "zzz" says "Nothing matches “zzz”. Try eggs, whole, breast or
  wings." with no card.
- **Teardown:** None.

### AR-21 Add to cart from the palette (#142)

Automated: `search.spec.mjs`, "add from any page, and the order page
has it", "on the order page it fills the row and the cart at once" and
"stock arriving late keeps the quantity chosen". The last fails today:
#162.

- **Scenario:** A product added from search lands in the order page's
  cart.
- **Setup:** A fresh browser.
- **Test:**
  1. On `/about/`, search "eggs"; press One more; Add to cart; open
     `/order/`.
  2. On `/order/?add=` 1 wing, search "wings"; Enter; Escape.
  3. With `/api/stock` held, search "eggs", press One more, then let
     the stock answer.
- **Assert:** "Large", "In stock"; "Added 2 × Eggs, Large. 2 items in
  your cart." and the button reads "Added · 2 in cart"; the order page
  shows 2 eggs, "2 items", $14. On the order page the wings row reads
  2, "2 items", $20. The late stock answer leaves the quantity at 2.
- **Teardown:** None.

### AR-22 The palette on a phone (#142)

Automated: `search.spec.mjs`, "on a phone it is a full-screen sheet"
(both projects); the combobox attributes are checked in AR-20.

- **Scenario:** A full-screen sheet with the combobox pattern.
- **Setup:** 390 by 664.
- **Test:**
  1. Open search from the nav; search "egg".
- **Assert:** The dialog covers the screen; the card and its Add
  button are on screen.
- **Teardown:** None.

### AR-23 The news page (#143)

Automated: `news-page.spec.mjs`, every test (both projects). Checked by
eye at 390 on 2026-09-25.

- **Scenario:** Posts grouped by year, each with a featured image or a
  leaf card, loading ten at a time.
- **Setup:** `/news/`.
- **Test:**
  1. With scripts off, follow "Older posts" to the end.
  2. With scripts on, scroll to the end.
  3. Again with page 2 answering 500.
  4. Reload and compare each post's picture or leaf; load the
     pictures.
  5. Read the captions on `/about/` and the September post.
- **Assert:** The pager walks every post once, at most ten a page. The
  pager is hidden and scrolling appends exactly the same posts in the
  same order; one heading per year, newest first, each post under its
  own year; one "older posts loaded" announcement; no request fails.
  A failed fetch shows the pager again, "Older posts" pointing at page
  2, with the first ten kept. Every post has a picture or a leaf, some
  of each, and the same one after a reload; pictures load at 4:3.
  Captions have no background.
- **Teardown:** None.

### AR-24 The about page (#144)

Automated: `about.spec.mjs`, every test (both projects). The
paragraph's wording is James's to approve.

- **Scenario:** The rule under "How we raise them" clears Linus's
  photo; a new paragraph; the tight-quarters video.
- **Setup:** `/about/` at 1500, 990, 575 and 390.
- **Test:**
  1. Measure the heading against the floated figure.
  2. Read what follows "What we sell".
  3. Fetch the poster and both encodes.
  4. Scroll the clip on screen; pause it; scroll away and back.
  5. Again with reduced motion, then with `nff:autoplay` set to `off`.
- **Assert:** The heading's box, and so its rule, never overlaps the
  figure. "What we sell" opens with the pasture paragraph, then the
  clip captioned "Morning chores in one of the mobile pens". The clip
  is muted, looping, inline, `preload="none"`, labeled; poster, MP4
  and WebM answer 200 with their types. On screen it plays and its
  button reads "Pause video"; once paused it stays paused, with the
  button showing. With reduced motion or autoplay off it waits, button
  showing, until play is pressed.
- **Teardown:** None.

### AR-25 The favicon (#145)

Partial: `favicon.spec.mjs` (desktop), all but the look at 16px in a
tab, which stays by eye. Passed on staging 2026-09-25 (1adb47f,
1908b57).

- **Scenario:** The gingham egg replaces the NF monogram.
- **Setup:** `/` and `/order/` (the hrefs are relative).
- **Test:**
  1. Read the icon links, the manifest and `browserconfig.xml`; fetch
     each file, and `/favicon.ico` and `/apple-touch-icon.png` at the
     root.
- **Assert:** Every file in `static/favicons/` answers 200 with its
  type and the bytes built by `bin/favicons/build`; each linked PNG is
  the size its `sizes` names; the manifest is
  `application/manifest+json` and lists one maskable icon; the pinned
  tab SVG is one color and the tile color is `#1e7b54`; the root paths
  answer with the set. The Windows tiles are drawn at 1.8 times
  (`mstile-150x150.png` is 270px), as before.
- **Teardown:** None.

### AR-26 The privacy policy (#146)

Pending.

- **Scenario:** The policy covers farm news, accounts, payments and
  storage.
- **Setup:** `/privacy/`.
- **Test:**
  1. Read it.
- **Assert:** Sections on the farm-news list (Resend, double opt-in,
  one-click unsubscribe), accounts and magic links, payments (Square
  and PayPal; card numbers never reach the site), what is stored where
  and for how long, what the browser keeps; no "Square, which creates
  your invoice"; a new effective date.
- **Teardown:** None.

### AR-27 The cart follows a signed-in customer (#149)

Pending.

- **Scenario:** A signed-in customer's cart and code appear on their
  other devices.
- **Setup:** Two browser contexts signed in as the same customer.
- **Test:**
  1. In A, add 3 wings and apply a code.
  2. Load `/order/` in B.
  3. As a guest with a local cart, sign in to an account with none.
- **Assert:** B shows 3 wings and the code; the newer draft wins; the
  guest cart becomes the account's.
- **Teardown:** Delete the customer.

### AR-28 How to buy (#150)

Automated: `home.spec.mjs`, "How to buy walks four steps without the
invoice era" (both projects).

- **Scenario:** James's wording for paying on the page replaces the
  emailed payment link.
- **Setup:** Home page.
- **Test:**
  1. Read `#how-to-buy`; press Shop all products.
- **Assert:** "From our pasture to your table"; steps "Shop one page",
  "Choose your day", "Make a change", "Pick up or delivery", each with
  its icon; no "invoice", "payment link" or "Pay to confirm"; the
  button lands on `/order/`.
- **Teardown:** None.

## Staging

### ST-01 The toolbar and its token

Automated: `staging-toolbar.spec.mjs`, "the Staging tab is on the page,
and the endpoints want a token".

- **Scenario:** The toolbar is on staging, and its endpoints are gated.
- **Setup:** Toolbar not hidden.
- **Test:**
  1. Open `/`; `GET /api/staging/info` without a token.
- **Assert:** `#staging` visible; 401.
- **Teardown:** None.

### ST-02 A wrong token is asked for once

Automated: `staging-toolbar.spec.mjs`, "a wrong token is asked for once,
not in a loop". Fails today: finding D5.

- **Scenario:** A reviewer who types the wrong token can still use the
  page.
- **Setup:** Toolbar shown; every prompt answered with a wrong token.
- **Test:**
  1. Open `/`; open the panel; wait six seconds.
- **Assert:** Two prompts at most.
- **Teardown:** None.

### ST-03 Production carries no staging code

Manual: James only; the suite never touches production.

- **Scenario:** `docs/staging.md`: nothing staging-only in production.
- **Setup:** The production site.
- **Test:**
  1. View source of `/order/`; `GET /api/staging/info`.
- **Assert:** No `#staging` element or staging script; 404.
- **Teardown:** None.

## Regression list

Run before every staging push that matters:
`npm run e2e -- --grep @regression`, then PY-14 by hand once Venmo is
wired.

1. PY-01 A card pays for an on-farm pickup
2. PY-02 A delivery paid by card is confirmed at once
3. PY-03 A decline, then a good card for the new total
4. PR-01 Bulk tiers and the delivery fee
5. PR-06 Under the minimum, delivery is blocked
6. FM-02 An empty delivery order names every field
7. FM-04 Errors clear as fields are fixed
8. OP-13 Continue to checkout can always be reached
9. AO-01 A sign-in link, used once
10. FN-01 Sign up, confirm, opted in
