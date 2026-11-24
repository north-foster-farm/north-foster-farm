# Splitting `account/main.js`

The second design under #782 (quality gates in the build), read from
`next` at `adef4ae2`. It follows the pattern of
[order-form.md](order-form.md).

`assets/scripts/account/main.js` is one class, `Account`: 1,940
lines, 1,407 of them code, in 56 methods. Seventeen run past 25 lines
(`orderCard` 127, `openChange` 85, `wireEmailChange` 54,
`renderReceipts` 44, `wireDelete` 42, `wire` 41). It draws the whole
account page from two answers, `/api/me` and `/api/account/orders`,
with DOM calls and never `innerHTML`, and it holds every action a
customer can take there. Its e2e cover is thin: several of those
actions have no spec at all.

## 1. The file today

### What it does

**Load.** `constructor`, `start`, `fetch`, `show`. One region under a
skeleton until both answers are in. Maintenance shows the bar and
nothing else. No session, or a session that an email-change link is
not for, goes to `/login/`.
e2e: `account`, `skeletons`, `maintenance`, `maintenance-bar`,
`email-change`.

**Tabs and the flash line.** `showTab`, `say`, the `hashchange`
listener, with `tabs-more.js` beside it.
Unit: `group-membership.test.mjs` (`lib/tab-scroll.mjs`).
e2e: `account-tabs`, `keyboard`.

**Arrivals.** `confirmChange`, `emailChanged`, `joined`, `openOrder`.
Each reads a flag in the URL once: the email-change link's fragment,
`?email=changed`, `?joined=1`, and `/account/orders/<id>/`.
e2e: `email-change` for the first two. None for the joined banner or
the link to one order.

**Membership.** `loadMembership`, `renderMembership`, `renderCode`,
`renderGroup`, `renderLeave`, `renderHost`, `renderMembers`,
`wireRemove`.
Unit: `membership-tab.test.mjs`, `group-membership.test.mjs`,
`membership-rounds.test.mjs`, `keep-together.test.mjs`.
e2e: `membership`, `membership-layout`, `host-member`.

**The head.** `renderHead`: the chicken, the address with its break
points, the credit beside Sign out.
e2e: `overflow`, `info-align`. None reads the credit line.

**Address.** `renderAddress`, `saveAddress`.
e2e: `account` (a denied address).

**Settings.** `renderProfile`, `saveProfile`, `saveAvatar`,
`saveAutoplay`, `saveAlone`, `wireReview`, `wireEmailChange`,
`wireDelete`, `deleteNote`, `deleteDetails`.
e2e: `email-change`, `orphan-email`, `perk-label`, `perk-revision`,
`busy-buttons` (Delete on a dropped connection). None for the
chicken, the videos box, or Dismiss on the review.

**Autosave.** `autosave`, `saving`, `lineFor`, `saveLine`, `why`,
`showErrors`, `clearErrors`.
Unit: `field-errors.test.mjs` (the shared helper).
e2e: none reads the "Saving…" and "Saved" line.

**Help.** `sendSupport`, `renderSupportOrders`.
e2e: `busy-buttons`.

**Orders.** `renderOrders`, `orderCard`, `replaceOrder`, `download`,
and the module's `when`, `at`, `placed`, `addUrl`.
Unit: `history.test.mjs` (`lib/history.mjs`).
e2e: `account`, `history-download`, `missed-delivery`,
`kept-thursday`, `scheduled-pickup`, `sku-alias`.

**Changing an order.** `openChange`, `drawPickups`, `drawWindows`,
`dateList`, `place`, `openCancel`, `openReturn`, `panel`,
`closePanel`.
Unit: `scheduled.test.mjs`, `pickup-days.test.mjs`,
`window-label.test.mjs` (the libraries).
e2e: `account-rounds`, `onfarm-times`, `window-label`, `pickup-days`,
`picker-out`, `kept-thursday`, `group-delivery-removed`,
`cancel-order`, `busy-buttons`. None for Report a problem.

**Receipts.** `renderReceipts`, `showReceipt`.
e2e: `account`, `history-download`. None opens the Venmo receipt.

### State

- **Page data:** `terms`, `locations` (which grows when a group's
  places arrive), `avatars` (assigned and never read), and the
  module's own `dropSeries`, a variable the constructor sets.
- **The account:** `customer`, `orders`, `member`, `credit`,
  `membership`.
- **Fetched on demand:** `dates` (asked for once, on the first Change
  panel), `roundSeries`.
- **One-time flags:** `confirm` (the email-change link),
  `leaveWired`.
- **Elements and timers:** `app`, `region`, `flash`, `ownParts`,
  `deleteUi`, `perkTips`, `fades`.

Nine of these are first set outside the constructor: `member`,
`credit`, `membership`, `ownParts`, `leaveWired`, `fades`,
`perkTips`, `deleteUi`, `roundSeries`.

### DOM

All in `layouts/account/single.html`:

- **Frame:** `#account-data`, `#account-app`, `#account-region`,
  `#account-flash`, `[data-tab]`, `[data-section]`,
  `[data-tabs-wrap]`.
- **Head:** `#account-avatar use`, `#account-email`,
  `#account-under[data-credit]`, `#account-credit`,
  `#account-signout`.
- **Orders:** `#orders-list`, `#orders-empty`, `[data-download]` and
  its `[data-download-row]`, the templates `#tpl-order` and
  `#tpl-line`, each card as `#order-<id>[data-status]` with its
  `[data-out]` slots and `[data-out="panel"]`.
- **Change panels:** `#tpl-change-delivery`, `#tpl-change-pickup`,
  `#tpl-change-window`, `#tpl-cancel`, `#tpl-return`, with
  `[data-dates]`, `[data-pickups]`, `[data-rounds]`,
  `[data-windows]`, `[data-onfarm]`, `[data-day]`,
  `[data-scheduled]`, `[data-group]`, `[data-items]`, `[data-close]`.
- **Receipts:** `#receipts-list`, `#receipts-empty`, `#tpl-receipt`,
  `#receipt-card` and its `[data-receipt]` slots.
- **Address and settings:** `#address-form`, `#address-status`,
  `#profile-form`, `[data-field]`, `[data-reminder]`,
  `[data-autosave][data-save]`, `[data-save-text]`,
  `[data-error-for]`, `#prof-group`, `#prof-group-row`,
  `#prof-email`, `#account-review`, the email-change panel
  (`#email-change*`, `#email-new`), the delete dialog (`#delete-*`).
- **Membership:** `#mem-region`, `#mem-groups`, `#tpl-mem-group`,
  `#tpl-member`, `[data-mem]`, `[data-mem-round]`, `[data-round]`,
  `[data-mem-code]`, `[data-mem-leave]`, `[data-mem-host]`,
  `[data-membership-only]`, `#membership-joined`.
- **Help:** `#support-form`, `#sup-order`.

### Events, timers, requests

Listens: `DOMContentLoaded`; `hashchange`; `change`, `focusin` and
`submit` on the two autosaved forms, and two more `change` listeners
on `#profile-form` (the chicken, the videos box); `click` on every
button it draws or finds; `keydown` in the new-address field;
`cancel` on the delete dialog; `input` in its field.

Sends: `Autoplay.set(on, { from: "account" })`, which fires
`nff:autoplay`, and `showChick()` for the header.

Timers: "Saved" stays 10 s and fades for 600 ms; the copied word
clears after `COPIED_MS`; a download's URL is revoked after 2 s.

Requests: `GET /api/me`, `GET /api/account/orders`,
`GET /api/membership`, `GET /api/dates`, `POST /api/group`,
`PUT /api/account/address`, `PATCH /api/account/profile`,
`POST /api/account/email`, `POST /api/account/support`,
`POST /api/account/delete`,
`POST /api/account/orders/<id>/change`, `/cancel` and `/return`,
`POST /api/membership/leave` and `/remove`. Images load from
`/api/membership/code` and `/api/membership/qr`.

It navigates to `/login/` (with `?next=` or the confirm fragment), to
`/account/#orders` with a reload after leaving a group, and to `/`
after a deletion. It rewrites the URL to drop `email` and `joined`.

It writes two things for the farm's eyes: `console.error("Account
save failed", { field, error })` and "Copy failed".

### Imports and importers

Nothing imports it. Hugo bundles it for the page that sets
`pageScript: "account"`, and it starts itself on `DOMContentLoaded`.

It imports its own `lib/history.mjs`, `lib/membership.mjs`,
`lib/membership-tab.mjs` and `tabs-more.js`; from the order page
`cart/perk-label.js`, `draft.js`, `pickup-days.js` and four
libraries; `news/hide.js`, `session/session.js`, `video/video.js`,
and eight `utils/` modules.

Other pages link into it by hash (`/account/#orders` from the order
page, `#membership` from the header's menu) and by card id (the
emails' `/account/orders/<id>/`).

## 2. The target

`main.js` stays as the root, since the page's front matter names it.
Its work moves into modules beside it. Pure ones go in
`account/lib/`, which the e2e dispatch table maps to the account
page alone.

### Modules

Sizes are code lines, estimated.

Pure, in `account/lib/`:

```
state.mjs        initialState, createStore, loaded,
                 customerSaved, orderReplaced, datesLoaded       50
order-words.mjs  when, at, placed, hour12, statusText,
                 addUrl, orderFromPath                           80
order-card.mjs   pickupNote, refundNote, totalRows, lineRows,
                 actionsOf                                      120
receipts.mjs     receiptRows, venmoReceipt                       50
change.mjs       changeKind, dateOptions, pickupChoices,
                 windowChoices, changeBody, cancelWords         110
profile.mjs      emailParts, creditLine, addressStatus,
                 profileValues, groupLine, addressReady,
                 profileReady, profileBody                       90
autosave.mjs     snapshotOf, shouldSave, failureText, why        40
arrivals.mjs     tabOf, withoutParams, loginUrl, deleteCheck     35
blocks.mjs       groupBlocks, leaves, membersHeading             25
```

`history.mjs`, `membership.mjs`, `membership-tab.mjs` and
`tab-scroll.mjs` stay as they are.

Dumb:

```
dom.js              qs, all, el, clone, write, busyButton        30
errors.js           showErrors, clearErrors                      35
save-line.js        saveLine and its fade                        40
head-view.js        drawHead, drawAddress, drawProfile          110
orders-view.js      drawOrders, the card and its five parts     170
receipts-view.js    drawReceipts, drawReceipt                    75
change-view.js      drawChange, drawPickups, drawWindows,
                    drawCancel, drawReturn                      150
membership-view.js  drawGroups, drawGroup, drawCode, drawHost,
                    drawMembers                                 150
```

Smart:

```
main.js          Account: load, show, wire                      170
tabs.js          Tabs: showTab, say, the hash                    45
arrivals.js      confirmChange, emailChanged, joined, openOrder  60
autosave.js      autosave, saving                                75
settings.js      Settings: address, names, chicken, videos,
                 review                                         140
email-change.js  EmailChange                                     70
delete.js        DeleteAccount                                  100
support.js       Support                                         40
order-actions.js OrderActions: change, cancel, report, the
                 dates, replace                                 170
membership.js    Membership: load, leave, remove, copy          130
downloads.js     download                                        20
```

Twenty-seven new modules, 28 with the root, and about 2,400 lines
for today's 1,407.

### How state moves

```
/api/me, /api/account/orders
  -> main.js   store.set(loaded(got))            lib/state.mjs
               draw the head, forms, orders, receipts

a save       -> settings.js   request
                store.set(customerSaved(answer.customer))
                drawHead or drawAddress

an action    -> order-actions.js   request
                store.set(orderReplaced(answer.order))
                drawOrders, drawReceipts

first Change -> order-actions.js   /api/dates, /api/group
                store.set(datesLoaded(dates, group))
```

- **The store** holds one frozen record: `customer`, `orders`,
  `member`, `credit`, `membership`, `dates`, `roundSeries`,
  `locations`. Views are redrawn by the module that changed it, as
  now. Nothing subscribes.
- **A view is given data and handlers.** `drawOrders(list, orders,
  { onChange, onCancel, onReport })` builds cards from what
  `order-card.mjs` decided and calls back on a press. It asks the
  server nothing.
- **Page data** (`terms`, the public locations, the drop site's
  series) is read once and passed in. The module-level `dropSeries`
  goes.
- **Timers and wired flags** stay in the module that owns them:
  `fades` in `save-line.js`, the delete dialog's elements in
  `delete.js`, the perk tooltips in `settings.js`.

### What stays as it is

The file name `main.js` and its start on `DOMContentLoaded`;
`tabs-more.js`; the four existing libraries; every module imported
from `order/`, `session/`, `news/`, `video/` and `utils/`. No new
package.

## 3. The phases

The rules for every phase are those of
[order-form.md](order-form.md#3-the-phases): one implementer for the
series, criteria tests first from a test agent, one commit and one
pull request per phase, new files within the limits on arrival,
`npm run check` before the commit and the e2e run after. For any
change under `assets/scripts/account/**`, `bin/nff e2e` selects the
36 specs of the account entry. Five specs that reach this page are
not in that entry and are named by hand where they matter:
`email-change`, `orphan-email`, `edit-switch`, `host-member`,
`header-chick`.

### Phase 0: pin what nothing pins

Tests only, from the test agent, passing against today's page. Each
spec joins the account entry of `e2e/dispatch.json`. Without them
phases 2 to 9 move code that no test would catch breaking.

1. A settings field that changes shows "Saving…", then "Saved", and
   the line clears. A refused save shows the server's reason.
2. The names save only once both are filled in.
3. The address saves once the street, town and a five-digit ZIP are
   there, and the status line follows the answer.
4. A chicken picked saves on its own and changes the head's and the
   header's at once.
5. Dismiss hides the review, and it stays hidden after a reload. A
   failed save brings it back.
6. Report a problem lists the order's items, sends the reason and
   the items ticked, and the card then says a problem was reported.
7. A Venmo payment's Receipt opens the receipt card with the payer
   and the PayPal capture.
8. `/account/orders/<id>/` opens Orders with that card focused and
   marked. An id the account lacks says so.
9. `?joined=1` shows the joined banner once, on Membership, and
   drops the flag.
10. Delete with another address typed is refused in words and sends
    nothing.
11. A member's credit shows beside Sign out, and credit kept after
    leaving a group does too.

One behavior is left out on purpose. Help's Send and the Change,
Cancel and Report forms say nothing when the connection is lost.
That is a bug, #831 (Account page: Help, Change, Cancel and Report
say nothing when the connection is lost), and pinning it would pin
the fault. Its fix brings its own tests and lands before phases 4
and 7, which move those four handlers.

### Phase 1: helpers and an order's words

Moves `qs`, `all`, `el`, `clone`, `write`, `busyButton` to `dom.js`;
`when`, `at`, `placed`, `hour12`, `addUrl`, `orderFromPath` to
`lib/order-words.mjs`. The drop site's series becomes an argument.

Criteria (`order-words.mjs`):

1. `when` for on-farm pickup is the way, the day and the window in
   full, or the hours the farm confirmed where the record has them.
2. For a scheduled pickup it is the way, the day, the hours and "at"
   the place, which reads "the drop site" for the drop site's series.
3. A group's round reads as a Group order.
4. A pickup that no longer resolves names the way and the day only.
5. Any other way reads as its name and the day.
6. `statusText` is "Cancellation requested" when one was asked for,
   and otherwise the order's status in `statusOf`'s words.
7. `addUrl` is `/order/?add=` with each line as `SKU:qty`, encoded.
8. `orderFromPath` gives the id from `/account/orders/<id>/`,
   decoded, and an empty string for any other path.

Stay green: `history.test.mjs`, `window-label.test.mjs`.
e2e: `account`, `scheduled-pickup`, `window-label`, `onfarm-times`,
`kept-thursday`.

### Phase 2: the order card

Moves `orderCard`'s decisions to `lib/order-card.mjs` and its
drawing, with `renderOrders`, to `orders-view.js`. Deletes `post()`,
which has no caller.

Criteria (`order-card.mjs`):

1. `pickupNote` for a pickup that no longer resolves is the line
   asking the customer to get in touch.
2. An unanswered question about a pickup time says the farm can't
   make it, with the farm's reason when one was given.
3. An unanswered missed delivery names the day the order is held
   until and the refund on cancelling: what was paid, less refunds,
   less a kept fee.
4. With a fee kept, it says another delivery day carries another
   fee and that the fee is not refunded.
5. An answered question leaves no note.
6. `refundNote` for a cancellation asked for says the refund is on
   its way.
7. For refunds it says "Refunded" when all is back and the amount
   otherwise, with the date of the last one.
8. An unpaid order with an amount due says what is due. An abandoned
   one says it was canceled.
9. `totalRows` has a discount row only with a discount, a delivery
   row only for a delivery ("Free" at zero), the total, and how it
   was paid, payments joined by ", then".
10. `actionsOf` always offers Reorder. It offers Change delivery or
    Change pickup, and Change items, only when the order can change.
11. It offers Cancel order only when the order can be canceled, and
    Report a problem only when it is paid or fulfilled.
12. `lineRows` gives each line its quantity, label, total and the
    link that adds it again.

e2e: `account`, `cancel-order`, `missed-delivery`, `kept-thursday`,
`sku-alias`, `history-download`, and phase 0's specs 6 and 8.

### Phase 3: receipts and downloads

Moves `renderReceipts` and `showReceipt` to `lib/receipts.mjs` and
`receipts-view.js`; `download` to `downloads.js`.

Criteria (`receipts.mjs`):

1. `receiptRows` gives one row for each payment of each order.
2. A payment refunded in full reads "Refunded" and is marked
   cancelled. One refunded in part reads the amount. One with no
   refund reads the order's status.
3. A row links the processor's receipt when the payment has one, our
   own card for a Venmo payment without one, and nothing otherwise.
4. `venmoReceipt` gives the date, the amount, and the payer and
   PayPal capture only where the payment has them.

Stay green: `history.test.mjs`.
e2e: `account`, `history-download`, and phase 0's spec 7.

### Phase 4: changing, canceling, reporting

Moves `openChange`, `drawPickups`, `drawWindows`, `dateList`,
`place`, `openCancel`, `openReturn`, `panel`, `closePanel` and
`replaceOrder` to `lib/change.mjs`, `change-view.js` and
`order-actions.js`.

Criteria (`change.mjs`):

1. `changeKind` tells a delivery, an on-farm pickup, a pickup day
   and a group's round apart.
2. `dateOptions` lists the open dates. A booked date no longer open
   is put first, marked "(as booked)", and chosen.
3. `pickupChoices` for a round offers the group's open rounds. For a
   pickup day it offers every open pickup except the group's.
4. A booked pickup no longer open is added, marked "(as booked)",
   and chosen.
5. `windowChoices` gives the day's windows and keeps the chosen time
   where the day has it, else takes the first.
6. A booked day the schedule no longer has offers only the booked
   time, marked "(as booked)".
7. `changeBody` posts an occurrence for a scheduled pickup and a
   date for the rest, the cooler, gate and notes for a delivery, and
   the window for on-farm pickup.
8. `cancelWords` explains the kept fee when there is one, and thanks
   by whether the order was canceled or only flagged.

Stay green: `scheduled.test.mjs`, `pickup-days.test.mjs`,
`window-label.test.mjs`, `kept-thursday.test.mjs`.
e2e: `account-rounds`, `onfarm-times`, `window-label`, `pickup-days`,
`pickup-days-revision`, `pickup-days-revision-2`, `picker-out`,
`round-card-ring`, `kept-thursday`, `group-delivery-removed`,
`cancel-order`, `busy-buttons`, `edit-switch`.

### Phase 5: autosave

Moves `autosave`, `saving` and `lineFor` to `autosave.js`;
`saveLine` to `save-line.js`; `showErrors` and `clearErrors` to
`errors.js`; the decisions to `lib/autosave.mjs`.

Criteria (`autosave.mjs`):

1. `snapshotOf` records each field's name and value, and for a box
   or radio whether it is checked.
2. `shouldSave` is false when the snapshot matches the one last
   sent, and false while the form is not ready.
3. `failureText` is "We couldn't save that." and the reason, its
   first letter capitalized.
4. `why` is the first field error, else the server's error, else the
   fallback.

e2e: phase 0's specs 1 to 3, `busy-buttons`.

### Phase 6: the head, the address, the settings

Moves `renderHead`, `renderAddress` and `renderProfile` to
`head-view.js`, their decisions to `lib/profile.mjs`, and the saves,
the two `change` listeners and `wireReview` to `settings.js`.

Criteria (`profile.mjs`):

1. `emailParts` splits the address at its last @ and marks a break
   before the @ and before each dot.
2. `creditLine` shows a member's credit, at zero too, and without a
   group shows credit only above zero.
3. `addressStatus` gives the words and tone for approved, pending
   and denied, and nothing for an address with no status.
4. `addressReady` wants a street, a town and five digits of ZIP.
   `profileReady` wants both names.
5. `profileValues` ticks the videos box by the account's choice, or
   by the browser's where the account has made none.
6. A reminder is ticked unless the account turned it off.
7. `groupLine` names the discount group and its percent.
8. `profileBody` carries the names, the phone, the news choice and
   each reminder.

e2e: `account`, `group-credit`, `perk-label`, `perk-revision`,
`info-align`, `overflow`, `header-chick`, and phase 0's specs 3 to
5 and 11.

### Phase 7: email change, deletion, help

Moves `wireEmailChange` to `email-change.js`; `wireDelete`,
`deleteNote` and `deleteDetails` to `delete.js`; `sendSupport` and
`renderSupportOrders` to `support.js`.

Criteria (`arrivals.mjs`, `deleteCheck`):

1. Nothing typed asks for the email address.
2. Another address says it is not this account's.
3. The account's own address passes, whatever its case and the
   spaces around it.

e2e: `email-change`, `orphan-email`, `busy-buttons`, and phase 0's
spec 10.

### Phase 8: membership

Moves `loadMembership`, `renderMembership`, `renderCode`,
`renderGroup`, `renderLeave`, `renderHost`, `renderMembers` and
`wireRemove` to `lib/blocks.mjs`, `membership-view.js` and
`membership.js`.

Criteria (`blocks.mjs`):

1. `groupBlocks` puts the member's own group first, with its host's
   part when they host it, then each other group they host.
2. `leaves` is false with no membership and false for a host who is
   a member only by hosting.
3. `membersHeading` counts the members, and reads "Members" alone
   with none.

Stay green: `membership-tab`, `group-membership`,
`membership-rounds`, `keep-together`.
e2e: `membership`, `membership-layout`, `host-member`,
`pickup-copy-anim`, `tooltip-center`.

### Phase 9: tabs and arrivals

Moves `showTab`, `say` and the hash listener to `tabs.js`;
`confirmChange`, `emailChanged`, `joined` and `openOrder` to
`arrivals.js`; the redirects' URLs to `lib/arrivals.mjs`.

Criteria (`arrivals.mjs`):

1. `tabOf` gives the tab a hash names, and Orders for an unknown or
   empty one.
2. `withoutParams` drops the named parameters and keeps the rest,
   with no question mark when none is left.
3. `loginUrl` carries the path, query and hash to come back to, or
   the confirm fragment when an email-change link is waiting.

e2e: `account-tabs`, `keyboard`, `email-change`, `verify-redirect`,
and phase 0's specs 8 and 9.

### Phase 10: the record and the root

Adds `lib/state.mjs`. `main.js` keeps `fetch`, `show` and `wire`,
each split to the limits, and comes off the legacy lists.

Criteria (`state.mjs`):

1. `loaded` sets the customer, the orders, the member and the
   credit.
2. `customerSaved` replaces the customer and nothing else.
3. `orderReplaced` swaps the order with the same id and keeps the
   list's order.
4. `datesLoaded` adds the group's rounds, its series, and its places
   after the public ones.

e2e: every spec named in this document.

## 4. What must not change

- **No `innerHTML`.** Everything a customer typed reaches the page
  as text. Each view keeps to `textContent`, `setKept` and
  `setWhole`, and keeps which of the three each slot uses today.
- **Requests and their order.** `/api/membership` starts beside the
  orders request and never holds the page. `/api/dates` and
  `/api/group` are asked once, on the first Change panel.
- **The caches other pages read.** `forget()` after a profile save,
  a chicken, a leave and a deletion; `forgetCustomer()` on deletion;
  `remember()` and `forgetJoined()` by the news choice.
- **Addresses other pages link to:** the six tab names in the hash,
  `#order-<id>` on a card, `#receipt-card`.
- **Redirects:** to `/login/` with `?next=` or the confirm fragment,
  and the promise that never settles, which keeps the skeleton up
  until the page has gone.
- **Autosave's timing:** the first focus takes the baseline, a
  change or Enter saves, "Saved" holds 10 s.
- **Focus:** on the first choice or the select of a Change panel,
  the close button of Cancel, the reason of Report, the dialog's
  field on Delete, Yes or the opener in each confirm, the next
  heading after Dismiss.
- **ARIA:** `aria-current` on the tab, `aria-expanded` on each
  opener, `aria-labelledby` ids unique per group, `aria-invalid` on
  the delete field, the labels on Remove and on each add-again link.
- **Wording.** Every string moves byte for byte. Many are drafts and
  several are James's own.
- **The two console lines.**

The largest risk is the thin e2e cover, which phase 0 answers. The
second is `orderCard`: it carries money sentences (the refund on a
missed delivery, the kept fee) that only `missed-delivery` and
`kept-thursday` read, so phase 2's criteria tests are the real
guard there.

## 5. Where the stall valve is needed

- **`main.js`, phases 1 to 9.** Edited while still over the limits.
  One standing entry on #791 (the rule exceptions log), as for
  `order-form.js`.
- **`test/kept-thursday.test.mjs`** names `account/main.js
  openChange` in a comment. Bringing the comment up to date in
  phase 4 touches a test file: modified lines only.
- **Nothing else.** `order/pickup-days.js` and
  `order/cart/perk-label.js` are imported and not edited.

## 6. Found while reading

None of these is fixed inside a move.

- Four forms have no catch for a lost connection: Help's Send, and
  the Change, Cancel and Report forms. `api()` rejects, the button
  goes idle, and the customer is told nothing. Leave, Remove, the
  email change and Delete all catch it. Filed as #831 (Account page:
  Help, Change, Cancel and Report say nothing when the connection is
  lost).
- `post()` has no caller (deleted in phase 2).
- `this.avatars` is assigned and never read.
- `dropSeries` is a module variable the constructor sets (an
  argument from phase 1).
- `#profile-form` has three `change` listeners, each ignoring the
  others' fields.
- The eleven behaviors of phase 0 have no e2e spec, or only part of
  one.
