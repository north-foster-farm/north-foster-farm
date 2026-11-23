# Untangling the server libraries' import cycles

The design for #925, read from `next` at `20328c42`. It serves #782
step 8 (quality gates in the build: dependency-cruiser's
`no-circular`) and comes before the libraries convert under #778
(the server on Hono, `docs/server-on-hono.md`), so that series starts
on a graph with no cycles. The rules common to every phase are in
[order-form.md](order-form.md#3-the-phases). Section 3 names what
differs for the server.

The work is small for what it removes. Eleven import edges carry
every cycle. Each one carries a handful of names, and each name is a
pure helper or a thin wrapper that sits in the wrong file. Moving
those names, and nothing else, leaves no cycle. No function's body
changes.

## 1. The graph today

### How it was measured

#925 counts 34 cycles, dependency-cruiser's figure from #782 step 8.
Step 8 is not on `next` yet. Neither dependency-cruiser,
`lint:cycles`, `.dependency-cruiser-known-violations.json` nor
`test/quality-cycles-known.test.mjs` is there. Only the criteria
are, held out as `test/quality-cycles.criteria.mjs`. So the figures
here come from the import lines, read by hand: every static `import`
and `export ... from` and every `import()` of a relative path under
`netlify/functions/`. dependency-cruiser follows both kinds.

The 34 depends on how the tool reports each cycle, so it shifts as
edges are cut. The figures below depend only on the graph:

- **Four tangles** (strongly connected sets), of 14, 8, 2 and 2
  modules. 26 modules sit on a cycle, 25 in `lib/` and one function
  file.
- **56 edges** inside them: 36, 16, 2 and 2.
- **11 edges** to cut: 4, 5, 1 and 1. Every cycle runs through at
  least one of them.
- `bin/` has none. Nothing in `bin/` sits on a cycle, and nothing in
  `lib/` imports from `bin/`.

### The core: logging, storage, health, sign-in and records

The issue lists this as two groups. They are one tangle of 14
modules: `log`, `clock`, `store`, `health`, `mail`, `breaker`,
`resend-guard`, `maintenance`, `auth`, `auth-records`, `records`,
`address-key`, `templates` and `pickups`.

Its 36 edges, with the four to cut marked:

```
log           -> clock (within)                        CUT
              -> health, store (import(), alertCrash)  CUT x2
clock         -> store (deployContext)
store         -> log
health        -> mail, maintenance, log, templates
mail          -> breaker, clock, resend-guard, store
breaker       -> health (ping)                         CUT
              -> log, resend-guard
resend-guard  -> store
maintenance   -> auth, mail, log, templates
auth          -> auth-records, clock, mail, records, templates
auth-records  -> log
records       -> auth-records, address-key, clock
address-key   -> log, store
templates     -> pickups, clock, records
pickups       -> log
```

There are two causes.

**`log.mjs` is a leaf with a wrapper inside it.** Of its 319 lines,
about 225 are the masked line, the buffer and the shipment to Axiom,
and need nothing from `lib/`. The other 95 or so are `withLog`,
which runs each request inside `clock.within`, and `alertCrash`,
which on a crash loads `health.mjs` and `store.mjs` with `import()`
to raise the alert. Since 32 libraries import `log`, the wrapper's three
edges tie all of them to `health`, and from there to `mail`,
`maintenance`, `auth` and `templates`. The `import()` is there, its
comment says, because `health` "logs through this module". That
holds off the load-order fault but not the cycle.

**`breaker.mjs` imports `ping` from `health.mjs`.** The breaker
guards each send in `mail`, and `health` sends its alerts through
`mail`. `ping` is a 25-line fetch to healthchecks.io and needs only
`log`.

### Accounts and order edits

Eight modules: `account`, `admin`, `amend`, `edit`, `jobs`, `rounds`,
`farm-orders`, and the function file `netlify/functions/orders.mjs`.

Its 16 edges, with the five to cut marked:

```
account      -> amend (holderOf)                       CUT
             -> jobs (cutoffAt)                        CUT
             -> admin (cancelOrder)
admin        -> amend (holderOf)                       CUT
             -> farm-orders (paymentPending)           CUT
amend        -> edit (planEdit)
edit         -> account (applyChange, canChange,
                planChange, publicOrder)
             -> admin (refundOrder)
jobs         -> admin (cancelOrder, listMessages,
                missedUntold, tellMissed)
             -> edit (finishEditVenmo)
             -> rounds (workRounds)
rounds       -> account (applyChange, planChange)
farm-orders  -> ../orders.mjs (orderId)                CUT
             -> account (publicOrder), edit (KEY)
orders.mjs   -> account (saveCart)
```

`account` and `admin` sit low in this tangle: the high modules
(`edit`, `jobs`, `rounds`, `farm-orders`) call them. Each cut edge
runs the other way, and each carries a helper that belongs lower:

- `holderOf` (`amend.mjs`, 2 lines) reads `order.square`.
- `cutoffAt` (`jobs.mjs`, 8 lines) is a date sum over
  `assets/scripts/order/lib/` and `terms`.
- `paymentPending` (`farm-orders.mjs`, 5 lines) reads one Blobs key,
  `pay-pending/<id>`, against `PENDING_MS`.
- `orderId` (`orders.mjs`, 15 lines) hashes the key into
  `NFF-YYMM-XXXXXX`. It is the one place a library imports a
  function file.

### The fakes

`fake-square.mjs` imports ten names from `square.mjs`, and
`square.mjs` imports the fake as `* as fake` to hand it each call
when `SQUARE_ENV=fake`. PayPal has the same pair with four names.
The names the fakes take are the shapes, with no call in them:

- **Square:** `SquareError`, `DECLINE_MESSAGES`, `failure`,
  `buildOrder`, `buildChangeOrder`, `customerView`, `paymentRecord`,
  `paymentView`, `refundRecord`, `replaceableReference`.
- **PayPal:** `PayPalError`, `captureOf`, `orderOf`, `refundOf`.

### Tests and importers

- `withLog` is imported by every one of the 24 function files and
  by two tests, `test/health.test.mjs` (with `alertCrash`) and
  `test/log-slow.test.mjs`. Nothing in `bin/` imports either.
- `ping`: `jobs.mjs`, `breaker.mjs`, `backup.mjs` (the function),
  `test/health.test.mjs`, `test/morning-ping.test.mjs`.
- `cutoffAt`: `account.mjs`, `test/jobs.test.mjs`.
- `holderOf`: `account.mjs`, `admin.mjs`,
  `test/account-change-holder.test.mjs`.
- `paymentPending`: `admin.mjs`, `test/farm-orders.test.mjs`.
- `orderId`: `farm-orders.mjs`, `test/orders.test.mjs`.
- No test mocks a module (`mock.module` appears nowhere), so a
  re-export is as good as the original to every caller.

## 2. The target

### The rule

A library imports only libraries below it. The order, lowest first:

```
leaves     log, mask, order-id, gate, http, site, terms, company,
           alerts-guide, and the new pure modules below
storage    store, clock, resend-guard, ping
records    auth-records, address-key, records, pickups, describe
words      templates
sending    breaker, mail
people     auth, maintenance
watching   health
requests   with-log
vendors    square-shapes, paypal-shapes, fake, fake-square,
           fake-paypal, square, paypal
orders     ... checkout, payments, admin, account
changes    amend, edit, rounds, farm-orders
running    jobs, e2e
functions  netlify/functions/*.mjs
```

The table is the order the moves leave, not a new framework. Nothing
enforces the layers by name. dependency-cruiser's `no-circular`
enforces their effect, and the phases' tests pin the cut edges so
none comes back by another name.

### New modules

All in `netlify/functions/lib/`. Sizes are lines, estimated.

```
with-log.mjs       withLog, alertCrash, where                   95
ping.mjs           ping, PING_TIMEOUT                           30
cutoff.mjs         cutoffAt                                     20
pay-pending.mjs    PENDING_MS, pendingKey, paymentPending       25
square-shapes.mjs  SquareError, DECLINE_MESSAGES, failure,
                   money, SITE_VERSION, SOURCE_NAME,
                   FRIENDS_SQUARE_NAME, ORDER_METADATA, e164,
                   stateFor, staffNote, fulfillment,
                   orderMetadata, buildOrder, SITE_REFERENCE,
                   replaceableReference, customerView,
                   buildChangeOrder, receiptLink, paymentRecord,
                   refundRecord, paymentView                   420
paypal-shapes.mjs  PayPalError, captureOf, orderOf, refundOf    60
```

Six new modules, and about 650 lines moved, none written anew.

`orderId` and `ID_LENGTH` join `ORDER_ID` in the existing
`order-id.mjs`, and `holderOf` joins the order readers in
`records.mjs` (`paymentsOf`, `paymentRef`, `questionOpen`).

`square-shapes.mjs` takes every private helper `buildOrder` and
`buildChangeOrder` reach (`money`, `stateFor`, `staffNote`,
`fulfillment`), and the constants they read. The implementer lists
them from the code. If one is also used by a call that stays in
`square.mjs`, `square.mjs` imports it from the shapes.

If #795 (Hono phase 1: TypeScript) has landed when a phase starts,
its new modules are `.mts`, typed, since #795's test lets the count
of `.mjs` files only fall. `.mjs` and `.mts` import each other
freely.

### What moves where

```
name                  from                 to                 kept by
withLog, alertCrash   log.mjs              with-log.mjs       none
where (private)       log.mjs              with-log.mjs       -
ping, PING_TIMEOUT    health.mjs           ping.mjs           health
cutoffAt              jobs.mjs             cutoff.mjs         jobs
holderOf              amend.mjs            records.mjs        amend
paymentPending,
PENDING_MS            farm-orders.mjs      pay-pending.mjs    farm-orders
pendingKey (private)  farm-orders.mjs      pay-pending.mjs    -
orderId, ID_LENGTH    ../orders.mjs        order-id.mjs       orders.mjs
the Square shapes     square.mjs           square-shapes.mjs  square
the PayPal shapes     paypal.mjs           paypal-shapes.mjs  paypal
```

"Kept by" is the module that re-exports the name, so its importers,
tests included, are not edited. A re-export is an import edge, so it
is safe only from a module above the new home. `log.mjs` cannot keep
`withLog` that way: `log` would import `with-log`, which imports
`log`. So the 24 function files and the two tests change one import
line each (phase 2). It is the one move every caller sees.

Then the importers that made the cycles point at the new homes:

- `breaker.mjs` imports `ping` from `ping.mjs`;
- `account.mjs` imports `holderOf` from `records.mjs` and `cutoffAt`
  from `cutoff.mjs`;
- `admin.mjs` imports `holderOf` from `records.mjs` and
  `paymentPending` from `pay-pending.mjs`;
- `farm-orders.mjs` imports `orderId` from `order-id.mjs`, and its
  claim helpers take `pendingKey` and `PENDING_MS` from
  `pay-pending.mjs`;
- `fake-square.mjs` and `fake-paypal.mjs` import from the shapes.

### What stays as it is

- `log.mjs` keeps `scrub`, `log`, `pending`, `FIXED`, `MAP`,
  `shape`, `configured`, `flush`, `trimStack`, `SLOW_MS`, `testOf`,
  and the one `buffer`. It imports nothing from `lib/`.
- `withLog`'s signature: `(name, handler, { onCrash, flushImpl,
  now })`, and the one-argument form, which names the function
  "unnamed".
- `alertCrash` keeps loading `health.mjs` and `store.mjs` with
  `import()`. A static import would make no cycle now, but it would
  load `health`, `mail`, `maintenance`, `auth` and `templates`
  (2,408 lines alone) at the cold start of every function that does
  not load them already. Today such a function loads them only on a
  crash.
- `square.mjs` keeps every call, `settings`, `isFake` and the
  `fake` driver. `paypal.mjs` keeps its token cache, `tokens`, and
  `forgetTokens`.
- Every body, log event, Blobs key, alert kind and string.

## 3. The phases

The rules are those of
[order-form.md](order-form.md#3-the-phases), with these for the
server:

- **e2e.** `netlify/functions/**` is `shared` in
  `e2e/dispatch.json`, so `bin/nff e2e` runs every spec, in Actions,
  against a local build with fake payments, at most one run an hour.
  The specs named under a phase are the ones to read first.
- **No `Record-shape` change.** Phases 2, 4 and 5 touch files that
  `bin/check-record-shape.mjs` lists (`store`, `records`, `account`,
  `admin`, `edit`), so each carries `Record-shape: none`.
- **The baseline shrinks with each phase.** Once step 8 is on
  `next`, a phase deletes the entries it ends from
  `.dependency-cruiser-known-violations.json` in the same commit,
  since `test/quality-cycles-known.test.mjs` fails on an entry that
  no longer occurs. The series does not wait for step 8. A phase
  that lands first leaves step 8 a smaller baseline to record.
- **The criteria tests read imports.** The test agent keeps one
  file, `test/server-imports.test.mjs`. It reads a module's import
  specifiers (static, `export ... from` and `import()`), resolves
  them, and asserts the edges named below. It uses no dependency.
  A box marked (test) is one test there, or a binding test (`assert
  .equal(a.name, b.name)`) beside it. A box marked (guard) is a
  check that already exists.

The order runs from the least shared code to the most: the fakes
first, because only `SQUARE_ENV=fake` runs them, and the hub last of
the core, because every function loads it.

### Phase 1: the fakes

Moves the Square shapes to `square-shapes.mjs` and the PayPal shapes
to `paypal-shapes.mjs`. `square.mjs` and `paypal.mjs` re-export them.
The fakes import from the shapes.

The fakes change by their import lines. No answer, recording or
fixture changes, so there is nothing for `bin/fixtures/record`.

Done when:

- [ ] `fake-square.mjs` imports nothing from `square.mjs`, and
  `fake-paypal.mjs` nothing from `paypal.mjs` (test)
- [ ] `square-shapes.mjs` and `paypal-shapes.mjs` import none of
  `fake*`, `http`, `recorder`, `store` and `clock`: no call can sit
  in them (test)
- [ ] Each moved name read from `square.mjs` or `paypal.mjs` is the
  same binding as in the shapes, so `instanceof SquareError` holds
  for an error the fake throws (test)
- [ ] The names `square.mjs` and `paypal.mjs` export are the same
  set as before (test: the list, written out)
- [ ] `square.test`, `square-replay.test`, `paypal.test`,
  `paypal-recorder.test`, `fake.test`, `fake-paypal.test` and
  `fake-paypal-webhook.test` pass unedited (guard)
- [ ] The fakes' two entries are gone from the baseline (guard)

e2e: `fake-payments`, `payment`, `orders-api`, `wallets`,
`venmo-paid`, `square-fulfilment`, `farm-refund`.

### Phase 2: `log.mjs` a leaf

Moves `withLog`, `alertCrash` and `where` to `with-log.mjs`. The 24
function files and the two tests import `withLog` (and
`alertCrash`) from there. The test edits are one import line each,
with no expectation changed, in the test agent's patch. The comment
in `clock.mjs` that names "lib/log.mjs, withLog" moves with it.

Done when:

- [ ] `log.mjs` imports nothing from `lib/`, statically or with
  `import()` (test)
- [ ] `log.mjs` no longer exports `withLog` or `alertCrash`, and
  `with-log.mjs` does (test)
- [ ] Every function file that wraps its handler imports `withLog`
  from `lib/with-log.mjs` (test: each file under
  `netlify/functions/` that names `withLog`)
- [ ] `with-log.mjs` reaches `health.mjs` and `store.mjs` only
  through `import()` (test)
- [ ] `withLog` flushes the lines `log` buffered during the handler,
  so there is one buffer, `log.mjs`'s (test: a line logged inside a
  wrapped handler reaches `flushImpl`, and `pending()` is 0 after)
- [ ] `health.test` and `log-slow.test` pass, changed by their
  import lines only, and `log-fields.test`, `clock.test` and
  `staging.test` pass unedited (guard)
- [ ] The baseline holds no entry that runs through `log.mjs`
  (guard)

e2e: the full suite. Read first: `maintenance`, `rate-limit`,
`orders-api`, `staging-toolbar` (the clock cookie through
`within`).

### Phase 3: `ping` below the breaker

Moves `ping` and `PING_TIMEOUT` to `ping.mjs`. `health.mjs`
re-exports both. `breaker.mjs` imports `ping` from `ping.mjs`.

After it the core has no cycle.

Done when:

- [ ] `breaker.mjs` imports nothing from `health.mjs` (test)
- [ ] `ping.mjs` imports only `log.mjs` from `lib/` (test)
- [ ] `health.ping` and `health.PING_TIMEOUT` are the same bindings
  as `ping.mjs`'s (test)
- [ ] No module among the 14 of the core reaches itself through its
  imports (test: a walk of the graph from each)
- [ ] `breaker.test`, `health.test`, `morning-ping.test`,
  `quiet-morning.test`, `mail.test` and `maintenance.test` pass
  unedited (guard)
- [ ] The baseline holds only the accounts' entries (guard)

e2e: the full suite. Read first: `customer-emails`,
`contact-send`, `maintenance`.

### Phase 4: accounts above admin

Moves `holderOf` to `records.mjs` (`amend.mjs` re-exports it),
`cutoffAt` to `cutoff.mjs` (`jobs.mjs` re-exports it), and
`paymentPending`, `PENDING_MS` and `pendingKey` to
`pay-pending.mjs` (`farm-orders.mjs` re-exports the first two).
`account.mjs` and `admin.mjs` import from the new homes.

After it the accounts have no cycle, though `farm-orders.mjs` still
imports `orders.mjs`.

Done when:

- [ ] `account.mjs` imports nothing from `amend.mjs` or `jobs.mjs`
  (test)
- [ ] `admin.mjs` imports nothing from `amend.mjs` or
  `farm-orders.mjs` (test)
- [ ] `cutoff.mjs` and `pay-pending.mjs` import nothing from `lib/`
  but `terms.mjs` and `clock.mjs` (test)
- [ ] The re-exported names are the same bindings as at their new
  homes (test)
- [ ] `pay-pending/<id>` is still the key a claim writes and
  `paymentPending` reads (test: a claim from `farm-orders.mjs` is
  seen as pending by `pay-pending.mjs`, and not after
  `PENDING_MS`)
- [ ] `account.test`, `account-change-holder.test`, `admin.test`,
  `amend.test`, `jobs.test`, `farm-orders.test`, `edit.test` and
  `edit-switch-cancel.test` pass unedited (guard)

e2e: the full suite. Read first: `cancel-order`, `edit-order`,
`edit-switch`, `farm-refund`, `account-rounds`, `account`.

### Phase 5: no library imports a function

Before it, the fix for `ORDER_ID` (section 6) lands as its own
commit, since this phase moves code into the same file.

Moves `orderId` and `ID_LENGTH` to `order-id.mjs`. `orders.mjs`
re-exports both. `farm-orders.mjs` imports `orderId` from
`order-id.mjs`.

Done when:

- [ ] No module under `lib/` imports a file outside `lib/` in
  `netlify/functions/` (test)
- [ ] `order-id.mjs` imports nothing from `lib/` (test)
- [ ] `orders.orderId` is the same binding as `order-id.mjs`'s
  (test)
- [ ] `orders.test`, `farm-orders.test` and `records.test` pass
  unedited (guard)
- [ ] The baseline is empty (guard)

e2e: the full suite. Read first: `orders-api`, `payment`,
`farm-refund`.

### Phase 6: retire the baseline

Deletes `.dependency-cruiser-known-violations.json`, drops
`--ignore-known` from `lint:cycles`, retires
`test/quality-cycles-known.test.mjs`, and marks #925's entry on #791
resolved. If step 8 is still unlanded, this phase is folded into
step 8 instead: it lands with no baseline at all.

Done when:

- [ ] `npm run lint:cycles` runs with no `--ignore-known`, and the
  file is gone (test, by the step 8 criteria that read the script)
- [ ] A cycle seeded between two server libraries fails `npm run
  lint` (guard: `test/quality-cycles.criteria.mjs`, once renamed
  `.test.mjs` by step 8)
- [ ] The #791 entry is marked resolved, with this phase's pull
  request named
- [ ] #925's boxes are ticked and the issue is closed

No e2e: no server code changes.

## 4. What must not change

Each item names how it is checked.

- **Every name each edited module exports,** by name and binding,
  `withLog` and `alertCrash` leaving `log.mjs` excepted. Checked by
  the binding tests and the export lists in phases 1 to 5, and by
  the existing unit tests passing unedited.
- **One log buffer.** `withLog` must flush `log.mjs`'s buffer, never
  a copy. Two buffers would lose every line from the console's
  shipment to Axiom without a failing request. Phase 2's flush test.
- **What loads at a cold start.** `health` and `store` stay behind
  `import()` in `with-log.mjs`. Phase 2's test, which fails on a
  static import.
- **`withLog`'s behavior:** the lines `function.slow`,
  `function.crashed` and `function.crash_alert_failed`, their fields,
  the 5,000 ms threshold, the mute key `function.crashed/<name>`, the
  rethrow, the flush in `finally`, and `within` around the handler
  (the staging clock and the outbox's session tag). `health.test`
  and `log-slow.test`.
- **`instanceof`.** `SquareError` and `PayPalError` are each one
  class, thrown by the fake and the real driver alike. `checkout`,
  `edit` and `admin` read `instanceof` and `declined`. Phase 1's
  binding test.
- **The fakes' answers** stay byte for byte: the shapes move, the
  recordings do not. `fake-payments` and the other e2e specs, which
  run with fake payments.
- **Blobs keys and record shapes:** `pay-pending/<id>`,
  `health/<name>`, `breaker/*`. `Record-shape: none`, and phase 4's
  key test.
- **No new import above.** A moved name's new home imports only
  modules below it. Each phase's "imports nothing from" tests.
- **Wording.** No string moves except inside the shapes, byte for
  byte. `templates.mjs` is not edited.

## 5. Risks

- **The baseline's entries move as edges are cut.** dependency-
  cruiser reports a cycle by its path, so when a phase cuts one edge,
  another entry's path may change and count as new. A phase then
  regenerates the baseline. Its diff may only delete entries, or
  reroute one among modules already listed, never name a new pair.
  The reviewer reads that diff. Ending each tangle within one or two
  phases keeps this short.
- **A lost buffer in phase 2** is silent: requests succeed and Axiom
  goes quiet. The flush test is the guard. After landing on
  `staging`, the coordinator checks that `function.slow` and
  `jobs.run` lines still reach Axiom.
- **A cold start that grows.** Making `alertCrash`'s imports static
  would look tidier and cost the light functions (`dates`, `events`
  and the like) a load of the core.
  Phase 2's test forbids it.
- **Phase 2 touches 24 function files at once,** each by one line,
  and each in a #778 port's path. It lands as one commit. A #778
  port open at the same time rebases over one import line.
- **The shapes move 420 lines.** A missed private helper is a
  `ReferenceError` only when the fake builds that shape. The fakes'
  unit tests and the payment specs cover `buildOrder`,
  `buildChangeOrder` and each record. A lint `no-undef` pass catches
  the rest before the commit.

## 6. Found while reading

None of these is fixed inside a move.

- **`ORDER_ID` matches only the old ids.** `order-id.mjs` holds
  `/^NFF-\d{4}-[A-Z0-9]{4}$/` and says "four characters", but ids
  have had six since #253 (`ID_LENGTH = 6`, `orders.mjs`). Three
  readers test it: `jobs.leftOpen`, so the daily Square sweep never
  cancels an abandoned Square order that carries a new id;
  `drift.mjs`'s webhook check, which answers "not a website order"
  for any new id and skips the drift check; and `store.maskKey`,
  which masks a key part holding a new id as `***` (the safe way).
  The tests use four-character ids (`jobs.test.mjs`, around line
  1290), so nothing catches it. `square.mjs`'s `SITE_REFERENCE` has
  the same `{4}`. This is a behavior fix and lands first, with
  tests, before phase 5.
- `clock.mjs`, `fake.mjs` and `resend-guard.mjs` import `store.mjs`
  for `deployContext` alone, a 2-line read of the environment. It
  makes no cycle once `log.mjs` is a leaf, so this series leaves it.
- `alertCrash`'s comment gives the cycle as the reason for its
  `import()`. After phase 2 the reason is the cold start, and the
  comment says so.
- `editOpen` in `jobs.mjs` is `cutoffAt` and a status check. It
  stays in `jobs.mjs`, importing `cutoffAt`.
- The issue's text says the 34 cycles are held in
  `.dependency-cruiser-known-violations.json`. That file is not on
  `next` at `20328c42`. It comes with #782 step 8.

## 7. The issues to file

For the coordinator, in this order. Each is one pull request.

1. **`ORDER_ID` matches only four-character order ids** (section 6).
   A bug fix with tests, ahead of the series.
2. **#925 phase 1:** move Square's and PayPal's shapes out of the
   drivers.
3. **#925 phase 2:** move `withLog` to `lib/with-log.mjs`, so
   `log.mjs` imports nothing.
4. **#925 phase 3:** move `ping` to `lib/ping.mjs`, below the
   breaker.
5. **#925 phase 4:** move `holderOf`, `cutoffAt` and
   `paymentPending` below `account` and `admin`.
6. **#925 phase 5:** move `orderId` into `lib/order-id.mjs`.
7. **#925 phase 6:** retire the cycle baseline (or fold it into #782
   step 8 if that has not landed).

Each phase issue copies its "Done when" list from section 3.
