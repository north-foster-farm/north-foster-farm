# The server on Hono

The milestone plan for #778 (Rewrite the server on Hono, with
validation and a quality stack). Every phase issue in the Server on
Hono milestone is cut from this file. Written 2026-11-22 from the
rollout plan James accepted; points still open are marked
**provisional** and gathered under "Open points".

## What is decided

James, 2026-11-21:

- **Hono.** Every new dependency the rewrite needs is approved, at
  the latest stable release, held back only for a written reason.
- **One framework for a request that reaches our code.** Hono owns
  validation, error bodies, status codes and required headers,
  sessions, CSRF, body limits, timeouts, request ids, the masked log
  line, and the API's security and cache headers. Netlify keeps what
  never reaches our code: static pages' headers, compression, CDN
  redirects, the staging gate and coarse rate limiting. One data file
  holds the header policy for both.
- **Valibot** for schemas, shared across the HTTP boundary: one
  schema per endpoint, imported by the page's script and by the
  function.
- **Enforced by the build, not by agents.** A handler takes input
  only through one wrapper, and a check in lint-and-test and the
  commit hook fails a function that reads input any other way.

James, 2026-11-22, took every recommendation in section 7 of the
rollout plan:

1. Build on Hono 4.13.x now, shaped so version 5 is one small pull
   request.
2. Three functions: `api`, `webhooks`, `staging`.
3. Linter and TypeScript version: see "Open points". The plan
   recommended TypeScript 7 with Oxlint. This file is written on
   TypeScript 6.0.3 with ESLint. **Provisional.**
4. Prettier formats every TypeScript file from its first commit.
5. Exact versions in `package.json` and the 7-day cooldown stay.
   "Not pinned" means never held back: each package is adopted at
   its newest release at least 7 days old, and holding one back
   takes a written reason in `docs/security.md`.
6. The RFC 9457 error body carries the old `errors` map as an
   extension member until phase 7 removes it.
7. A JSON body with a key its schema does not name is refused. A
   query string's unknown keys are ignored.
8. One coarse Netlify rate limit on `api`, per address, set at twice
   the e2e suite's measured peak. Wrong-method and unknown-path
   requests reach Hono for their 405 and JSON 404.
9. OpenAPI in phase 8: `openapi.json` generated, committed, checked
   for drift in CI, never served.
10. A 401 answers with a scheme of our own, which tells a client to
    sign in:
    `WWW-Authenticate: Session realm="North Foster Farm"`.
11. `// @ts-check` on the 11 page scripts that call the API, as each
    endpoint is ported.

The quality rules are those of #782 (Quality gates in the build for
new and changed code), so site and server share one configuration:
functions of 25 lines or fewer, nesting of 2, 4 parameters, cognitive
complexity 15, files of 300 lines or fewer. A touched file meets
every rule, whole. An exception is the last resort and is logged on
#791 (Rule exceptions log).

## The shape of the server

### Three apps

- `api.mts`: the customer API under `/api/` and the group link
  `/vff`. One typed client, one warm instance, one coarse rate
  limit.
- `webhooks.mts`: Square, PayPal and Resend. A raw body, a
  signature, no session.
- `staging.mts`: the gate's sign-in routes and the staging tools.
  Every route answers 404 in production.

The scheduled `jobs` and `backup` take no request and stay plain
functions. The edge gate filters requests and routes nothing, so it
stays a plain edge function in front of everything.

### Layout (a draft; phase 2 settles it)

```
netlify/functions/
  api.mts  webhooks.mts  staging.mts   handle(app), one line each
  jobs.mts  backup.mts                 scheduled, no request
  lib/
    app/
      factory.mts     createFactory<Env>(); initApp installs deps
      input.mts       input(target, schema) and input.none()
      errors.mts      onError, notFound, the RFC 9457 body
      headers.mts     secureHeaders and no-store, from the data file
      middleware/     request id, log, maintenance, same-site,
                      rate limit, session
    routes/           one small app per area, mounted with app.route
    ...               the libraries, converting as their routes do
assets/scripts/schemas/
  fields.mts          email, ZIP, phone, order id, SKU, token, money
  <endpoint>.mts      one per endpoint, for the page and the function
data/headers.json     the header policy, for Netlify and for Hono
```

Hono's code sits inside `lib/` because Netlify already treats that
folder as no function. The schemas sit in `assets/` because Hugo
bundles from there and the functions already import from it
(`order/lib/validate.mjs`).

### A request's path through `api`

In order (a draft; phase 2 fixes it with a test per step):

1. **Request id.** Hono's `requestId()` with Netlify's own id as its
   generator. It goes on every log line, in `X-Request-Id` and in
   the error body.
2. **Log.** Today's `withLog` as one middleware: the masked line,
   the Axiom line, the crash alert. Hono's `logger()` is not used,
   since it prints an unmasked line.
3. **Headers.** `secureHeaders()` from `data/headers.json`, and
   `Cache-Control: no-store`.
4. **Body limit.** `bodyLimit()`: a 413 in our error shape.
5. **Timeout.** `timeout()`: a 504 in our error shape. Not on
   `POST /api/orders`, whose own budget in `lib/checkout` exists so
   that no answer leaves while a payment is in flight.
6. **Maintenance.** Today's switch.
7. **Same-site and same-origin,** on every state-changing route.
   Hono's `csrf()` skips JSON by design, so today's check moves as
   it is.
8. **Exact rate limit,** per route. The eight hand-written limiters
   become one middleware that keeps each window, count, what is
   counted (every try, or misses only) and message.
9. **Session,** per route group. Sessions live in Blobs, so this is
   our middleware, made with the factory. A missing session is a
   401 with its `WWW-Authenticate`.
10. **Input.** `input(target, schema)`. The handler reads
    `c.req.valid()` and nothing else.

Then the handler: read the validated input, call the library
function that does the work, answer with `c.json(body, status)`.

### Input

`input(target, schema)` wraps `hono/validator` with
`@hono/standard-validator` and the endpoint's Valibot schema. Only
`input.mts` imports the validator, so changing it costs one line.
The target is the query, the path, the JSON body, a form, a cookie
or a header.

Field schemas live in one file and feed every endpoint schema, the
page's forms and the CLI's arguments. Each one:

- decodes once, trims, normalizes (an email address lowercased, a
  ZIP as digits) and refuses control characters;
- never coerces: a JSON number must already be a number, and a query
  or form value must be digits from end to end before it becomes
  one;
- yields a branded type (`Email`, `OrderId`, `Sku`, `Token`) that
  only its schema can make;
- gives a message that never repeats the value it refuses.

Unvalidated input is a build failure three ways:

1. A handler's only input is `c.req.valid()`, typed from the schema,
   and the libraries take those types.
2. A function that builds a storage key takes an `Email`, so a raw
   string does not compile. That is the fault behind #758 (plus
   addresses in storage keys).
3. A test reads every route file and fails on `c.req.json()`,
   `c.req.query()`, a header read or `new URL(` outside the wrapper.
   A second test walks the app's routes and fails on one with
   neither a schema nor `input.none()`. Both ship with fixtures that
   fail them.

### Errors

`app.onError` and `app.notFound` turn every failure into one body,
RFC 9457 `application/problem+json`: `title`, `detail`, the request
id, and `invalid-params` naming each failed field. A handler throws
`HTTPException`; nothing builds an error response by hand. The body
is ours, about 40 lines.

- A bad parameter is a 400 (a 422 for a well-formed request whose
  field is invalid), never a 404 or a 500.
- A wrong method is a 405 with `Allow`, from Hono's
  `methodNotAllowed()`. For that, no Hono function sets `method` in
  its `config`.
- An unknown path under `/api/` is a JSON 404.
- A record that is not there is `c.json(..., 404)`, never
  `c.notFound()`, so the typed client sees the status.
- Until phase 7 the body also carries the old
  `errors: { field: message }` map, for a tab left open across a
  deploy.

### Headers

Netlify's `[[headers]]` rules never reach a function's response.
#781 (Function responses lack the site's security headers) confirmed
it on production. `data/headers.json` holds the policy once: the
parts both sides share (HSTS, `nosniff`, `Referrer-Policy`,
`Permissions-Policy`) and two CSPs, the pages' and a tight one for
the API and the HTML the functions write. Hono imports the file.
Hugo renders Netlify's `_headers` from it in the same build. If
`netlify dev` cannot read that file, the fallback is a test that
fails when `netlify.toml` and the data file disagree.

### Rate limits

Two jobs. Netlify refuses a flood before a function runs, through
one `rateLimit` in `api`'s `config`. Hono's middleware keeps the
exact limits, which cannot move to Netlify: its window is 180
seconds at most, ours are 5 and 10 minutes, and three count only
misses. A request Netlify refuses never reaches Hono, so the page's
API helper reads a 429 with no JSON body as "too many tries".

### The page

The page's one API helper (`assets/scripts/utils/api.js`) becomes
Hono's typed client, `hc`. It imports the app's type with
`import type`, which esbuild erases, so no server code reaches the
page. Each form validates with its endpoint's schema before it
sends: a missing value becomes an empty string or the field's
default, never null, and each error shows beside its field at once.

### Tests

A unit test that calls a handler changes how it calls it, from
`handle(new Request(...), deps)` to `app.request(path, init, deps)`,
and keeps what it expects. The third argument carries the fake
stores, clock and mail. That is a change to how a test runs, which
an implementer may make.

Three expectations do change, each by the spec of #778 (the server
on Hono): an error body becomes the RFC 9457 shape, a wrong method
becomes a 405 with `Allow`, and a bad parameter that got a 404 or a
500 gets a 400.
Those changes go to a test agent, and each phase's criteria tests
are written first, from its "Done when" list, one test per
criterion.

The e2e specs drive the same URLs and need no change beyond the few
that read an error body.

### TypeScript

- **No build step.** Netlify builds `.mts` functions as they are.
  Node 24 runs TypeScript unflagged, so `bin/nff` and `node --test`
  load the same files. Hugo's `js.Build` transpiles for the page.
  `tsc --noEmit` only checks.
- **Files are `.mts`,** an ES module wherever it sits. When a
  JavaScript and a TypeScript function share a name, Netlify deploys
  the JavaScript one, so a route's old file is deleted in the pull
  request that ports it.
- **Strict from the first file:** `strict`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitReturns`, `noFallthroughCasesInSwitch`,
  `noImplicitOverride`, `noPropertyAccessFromIndexSignature`,
  `verbatimModuleSyntax` and `erasableSyntaxOnly`. No `any`, no
  `@ts-ignore`.
- **Libraries convert with their routes.** `.mjs` and `.mts` import
  each other freely, so nothing converts in one sweep. A count of
  `.mjs` files under `netlify/functions` and `bin` that can only
  fall keeps the direction.

### Hono's own rules

- No controllers: the handler is written after the path, so the
  path's parameters and the validated input are inferred.
- `app.route()` mounts one small app per area.
- Routes are chained (`new Hono().get(...).post(...)`), because the
  typed client and `testClient` read the type that flows through the
  chain. A handler writes its status out and uses `async` and
  `await`.
- `createFactory<Env>()` declares once what a route can reach.
- Hono answers a HEAD from the GET route, and `strict: false` treats
  a trailing slash as the same path.

For version 5, three things stay in one file each: the adapter
import (`@hono/netlify`, already, never the deprecated
`hono/netlify`), the signature of `app.onError`, and any raw
`c.req.json()`, which only the wrapper may call.

## How every port lands

Each pull request ports whole routes.

1. A test agent writes the phase's criteria tests from its "Done
   when" list, and finds each existing test the spec retires.
2. The route joins a Hono app. Its path moves from the old
   function's `config.path` to the new one's.
3. The old file is deleted when its last route leaves.
4. The library the route uses converts to TypeScript in the same
   pull request.
5. The page script that calls the route takes `// @ts-check`, the
   typed client and the endpoint's schema.

The URL never changes, so any release can ship between two pull
requests and there is no long-lived branch. A test fails when two
functions claim one path, or when a function claims a path its app
has no route for, which ends the fault of #577 (a function deployed
with no route). No phase changes a stored record's shape, so every
commit carries `Record-shape: none`.

Out of scope: Hugo's templates and content, the page scripts beyond
the API helper and the forms' validation, stored records, and the
dashboard.

## The phases

Each phase is one issue in the Server on Hono milestone. The issue's
"Done when" list is the live one; this file holds the plan it came
from.

### Phase 1: TypeScript and the server's lint rules (#795)

No endpoint is touched. It lands first so every later line is
written under it. It builds on three steps of #782 (Quality gates in
the build for new and changed code): the frame and James's limits
(step 3), Prettier (step 5), and SonarJS with TypeScript's checker
(step 7).

Done when:

- `tsconfig.json` holds the strict flags this plan lists under
  TypeScript, `npm run typecheck` runs inside `npm run lint`, and it
  passes over every `.mts` file and every script marked
  `// @ts-check` (test: a fixture with an
  implicit `any`, and one with an unchecked index, each fail it)
- ESLint runs typescript-eslint's type-aware rules over every
  TypeScript file with warnings as errors: `no-floating-promises`,
  `no-misused-promises`, the `no-unsafe-*` family,
  `strict-boolean-expressions`, `switch-exhaustiveness-check`,
  `no-explicit-any` (test: a fixture with a floating promise fails;
  one passing an `any` to a typed parameter fails)
- A new TypeScript file is held to James's limits and to Prettier
  from its first commit, on no legacy list (test: a fixture over
  each limit fails; an unformatted fixture fails)
- The count of `.mjs` files under `netlify/functions` and `bin` can
  only fall (test)
- `docs/security.md` (dependency policy, points 1 and 5) says what
  is now true: exact versions and the cooldown stay, a package is
  never held back without a written reason, and TypeScript's hold
  at 6.0.3 is written there with its reason
- The site's `CLAUDE.md` names the TypeScript setup and the new
  commands
- GitHub's dependency review runs on every pull request and names
  each new package and its license (a `.github` change, for James's
  approval in the pull request)

### Phase 2: the app, the input wrapper and the first routes (#796)

The factory, the middleware, the header policy's data file,
Netlify's coarse limit, the error shape and the two input tests.
Then four read-only routes: `GET /api/dates`, `/api/events` and
`/api/checkout/config` take no input and write nothing, and every
order-page load exercises them, so the e2e suite proves the adapter
at once. `GET /api/pass` is the first real schema, with strict query
text. This phase closes #781 (Function responses lack the site's
security headers).

Done when:

- `GET /api/dates`, `/api/events`, `/api/checkout/config` and
  `/api/pass` answer through `api.mts` at the same URLs, and their
  four old function files are gone (test, per route: the answer is
  what it was)
- Every error is one shape, RFC 9457 `application/problem+json`
  with `title`, `detail` and `invalid-params`, and carries the old
  `errors` map beside it (test)
- A wrong method gets a 405 with `Allow`, a missing session a 401
  with `WWW-Authenticate`, an unknown path under `/api/` a JSON 404
  (test, each)
- `/api/pass` refuses a missing, empty, over-long or
  control-character `code` with a 400 that names the field, never a
  404 or a 500 (test)
- A handler reads input only through the wrapper (test: fixture
  routes that call `c.req.json()`, `c.req.query()`, read a header
  and parse the URL each fail the check)
- Every route declares a schema or `input.none()` (test: a fixture
  route with neither fails)
- A JSON body with a key its schema does not name is refused, and a
  query string's unknown keys are ignored (test)
- No path is claimed by two functions, and every path a function
  claims is a route in its app (test)
- The header policy is one data file: every function response, JSON
  and HTML, carries its values, and so does Netlify's config for
  the static pages (test: each side equals the file)
- No Hono function declares `method` in its `config`, and `api`
  declares the coarse `rateLimit` (test)
- The page's API helper reads Netlify's own 429, which has no JSON
  body, as "too many tries" (test)
- A body over the limit gets a 413, and a request over its time a
  504, both in the error shape; `POST /api/orders` is under no
  timeout but its own budget (test, each)
- The request id is on every log line, in `X-Request-Id` and in the
  error body (test)
- A crash still alerts as `function.crashed`, and a refused message
  never repeats the value (test, each)
- The page's API helper is the typed client, and a call with a
  wrong path or field fails `typecheck` (test)
- Posted on the pull request: the page bundle's size before and
  after, `api`'s bundle size and cold start on staging beside
  `orders` today, the e2e suite's peak request rate beside the
  coarse limit, and whether the CDN compresses a function's
  response

### Phase 3: public forms and codes (#797)

Contact, farm news, the health beacon, the group code, join, invite,
the maintenance switch and `/vff`. Small bodies, each with a form
that takes the shared schema, so client-side validation is proved
here. The schemas are written from the rows of the audit table
that #778 (the server on Hono) asks the security lane for.

Done when:

- Each route answers through `api.mts` at the same URL, and its old
  function file is gone (test, per route)
- Every parameter of each endpoint is decoded once, sanitized and
  validated, and a bad one gets a 400 or 422 that names the field
  (test, per endpoint)
- Types are strict: a null or missing required value, a JSON field
  of the wrong type and a text value that does not parse strictly
  are each refused with a 400 (test, per endpoint)
- Each form validates with its endpoint's schema before sending,
  sends no null, and shows each error beside its field at once
  (test, per form: contact, farm news, group code, join, invite)
- The exact rate limiters are one Hono middleware, and each limit
  keeps its window, its count, what it counts (every try, or misses
  only) and its message (test, per limit)
- A filled honeypot and an address that is not on a list get the
  answers they get today (test)
- The pull request lists every customer-facing line it adds or
  changes as a draft

### Phase 4: sign-in, account and membership (#798)

`auth` (5 routes), `account` (13) and `membership` (5). The session
middleware and the cookie helper carry their full load: 23 routes,
the path parameter, the emailed links. `hono/cookie` replaces the
hand-written cookie parsing and `Set-Cookie` strings; names and
attributes stay as they are.

Done when:

- Each route answers through `api.mts` at the same URL, and the
  three old function files are gone (test, per route)
- Every parameter is decoded once, sanitized and validated, the
  order id in the path included: a malformed id gets a 400, never a
  404 (test, per endpoint)
- Types are strict, as in phase 3 (test, per endpoint)
- The session, stamp and clear cookies are set attribute for
  attribute as today (test)
- A sign-in, change-of-address and join link still works in one
  click, with `?via=link` or a tracker's parameter on it (test)
- Same-site and same-origin refusals hold on every state-changing
  route (test)
- Each form validates with its endpoint's schema before sending,
  sends no null, and shows each error beside its field (test, per
  form: sign-in, profile, address, new email address, support,
  delete account, remove a member)

### Phase 5: orders, stock and the payment webhooks (#799)

Last among the customer routes because it moves money. By then the
customer, address and line schemas have run in production under
account edits, and the wrapper has three phases behind it. The
webhooks keep their order: signature over the raw body first, the
event's schema second. The handler in `orders.mjs` runs to about 550
lines, so porting it under the 25-line limit means splitting it; its
design is written in Markdown first.

Done when:

- `POST /api/orders` and `GET /api/stock` answer through `api.mts`,
  and every response the page acts on (200, 204, 402, 409, 422,
  429, 502, 503) is what it was (test, each)
- The order's Valibot schema replaces `validateOrder`, and the order
  form and the function import the same file (test: one bad order
  is refused the same way by both)
- Types are strict on every field of the order and its payment
  (test)
- Nothing is recorded until the money is in, a retried submission
  is never charged twice, and the request budget holds (test: the
  existing checkout, payment and idempotency tests pass with no
  expectation changed)
- The three webhooks answer through `webhooks.mts`; each checks its
  signature over the raw body before anything is parsed, then
  validates the event (test: an unsigned, a forged and a replayed
  delivery change no record)
- Every recorded fixture of Square, PayPal and Resend parses under
  its schema (test)
- The order form validates with the schema before sending and shows
  each error beside its field (test)
- The full e2e suite passes once on staging for the release
  candidate

### Phase 6: staging tools and the access gate (#800)

31 routes that never answer in production. Independent of phases 3
to 5, so a second lane can take it alongside.

Done when:

- The 26 staging routes and 5 gate routes answer through
  `staging.mts` at the same URLs, and the two old function files
  are gone (test, per area)
- Every route is a 404 in production, and with neither token set
  (test)
- Each way in opens only its areas, and the bearer token is
  compared in constant time (test)
- Every parameter is decoded once, sanitized and validated, with
  strict types (test, per area)
- The edge gate is TypeScript, reads its cookie and token through
  the schemas, and still fails closed (test)
- `check:staging` passes: no staging tool in production's build

### Phase 7: the CLI and the last libraries (#801)

`bin/nff` is 2,645 lines with 78 command labels and one hand-written
flag loop; numbers go through `Number()`. It becomes a short
launcher over command modules in TypeScript, each within the size
limits, with its design written in Markdown first.

Done when:

- Every `bin/nff` command parses its arguments with a schema built
  from the server's field schemas, and a bad one exits non-zero
  with a message naming the argument before any store is opened
  (test, per command group)
- No argument passes through `Number()` or `parseInt` (test)
- `bin/nff` is a launcher over TypeScript command modules, and its
  usage text and shell completion are unchanged (test)
- `jobs` and `backup` are `.mts`, no `.mjs` remains under
  `netlify/functions`, and `json` and `readJson` are gone from
  `lib/http`
- The old `errors` map is gone from the error body, and the page
  reads `invalid-params` alone (test)
- The parameter rule is in the site's `CLAUDE.md` and in qa's and
  security's review briefs, and the stopgap paragraph in the
  bullpen's common rules points to the build check

### Phase 8: the OpenAPI document and Hono 5 (#802)

Optional, after the rest. `hono-openapi` reads any Standard Schema
library, Valibot included; its peer range was `^4.11.2` when the
plan was written, so the document waits until it accepts Hono 5 or
the app has settled on 4.

Done when:

- A script generates `openapi.json` from the routes and their
  schemas, the file is committed, and CI fails when the committed
  copy differs (test)
- No deploy serves the document (test)
- The app runs on Hono 5 once 5.0 has been stable for 7 days: the
  adapter import, the `onError` signature, and every test green

## What moves, and when

22 HTTP functions with 79 routes, 2 scheduled functions and 1 edge
function, as counted on 2026-11-21.

Phase 2:

- `dates`, `events`, `checkout`: `GET /api/dates`, `/api/events`,
  `/api/checkout/config`. No input.
- `passes`: `GET /api/pass`. Query: `code`, `holder`.

Phase 3:

- `contact`: `POST /api/contact`. JSON: `name`, `email`, `message`,
  `orderId`, `website`. `x-staging-token`.
- `news`: `POST /api/news/subscribe`, `GET /api/news/confirm`,
  `POST /api/news/unsubscribe`. JSON: `email`, `firstName`, `token`.
  Query: `token`. `Referer`.
- `health`: `GET` and `POST /api/health`. JSON: `kind` and the
  beacon's fields. `User-Agent`.
- `group`: `POST /api/group`. JSON: `code`. Session cookie.
- `join`: `POST /api/join/check`, `/api/join/request`, `/api/join`.
  JSON: `token`, `email`, `firstName`, `lastName`, `news`,
  `website`.
- `invite`: `POST /api/invite/check`, `/api/invite/request`. JSON:
  `token`, `email`, `website`.
- `maintenance`: `GET /api/maintenance`; `GET` and `POST
  /api/maintenance/{on,off}`. Path: the action. Query: `sig`.
- `group-link`: `GET /vff`. The path.

Phase 4:

- `auth`: `POST /api/auth/request`, `GET` and `POST
  /api/auth/verify`, `POST /api/auth/signout`, `GET /api/me`. JSON:
  `email`, `next`, `cart`, `website`, or `token`. Query: `token`.
  Session cookies.
- `account`: `GET /api/account/orders`; `GET` and `PUT
  /api/account/cart`; `POST
  /api/account/orders/:id/{cancel,change,edit,pay,return}`; `PATCH
  /api/account/profile`; `PUT /api/account/address`; `POST
  /api/account/{email,support,delete}`. Path: `id`. JSON bodies,
  one shape per route. Session and stock-scope cookies.
- `membership`: `GET /api/membership`, `/api/membership/qr`,
  `/api/membership/code`; `POST /api/membership/remove`,
  `/api/membership/leave`. Query: `group`, `download`. JSON:
  `group`, `email`. Session cookie.

Phase 5:

- `orders`: `POST /api/orders`. JSON: the order as `validateOrder`
  reads it, `payment` (`method`, `sourceId`, `verificationToken`,
  `stage`, `paypalOrderId`), `attempt`, `idempotencyKey`,
  `website`. Session and stock-scope cookies, `x-staging-token`.
- `stock`: `GET /api/stock`. Stock-scope cookie.
- `square-webhook`, `paypal-webhook`, `resend-webhook`: `POST
  /api/square/webhook`, `/api/paypal/webhook`,
  `/api/resend/webhook`. The raw body and each provider's signature
  headers.

Phase 6:

- `gate`: `GET /api/gate/signin`, `/api/gate/verify`,
  `/api/gate/me`; `POST /api/gate/request`, `/api/gate/signout`.
  Query: `next`, `token`. Form or JSON: `email`, `next`, `website`.
  Gate cookie.
- `staging`: 26 routes under `/api/staging/` (outbox, sent, clock,
  jobs, email library and review, signatures, slips, e2e, throw).
  Path ids and names. Query: `format`, `date`. JSON bodies. Bearer
  token, gate and clock cookies.
- The edge `gate`: every request. Gate and machine cookies,
  `Authorization`, `x-staging-token`, `Accept`, the path.

Phase 7:

- `jobs` and `backup`, scheduled.
- `bin/nff`, by area: customers; orders and money; catalog and
  schedule; groups and perks; mail and news; operations; tooling.
  It imports 35 of the 85 server libraries.

## Open points

- **TypeScript 6.0.3 with ESLint is provisional.** SonarJS
  (`eslint-plugin-sonarjs` 4.2.2), which gives #782 (Quality gates
  in the build for new and changed code) its cognitive complexity
  rule, depends on TypeScript below 6.1 and crashes on load beside
  TypeScript 7.
  typescript-eslint needs the same. So this plan holds TypeScript
  at 6.0.3, with ESLint the one linter for site and server, until
  James confirms or picks otherwise. The alternative is TypeScript
  7 with Oxlint and no SonarJS. If he picks it, phase 1's lint
  rules change tool and nothing else in this file does.
- **Server files and the size limits.** Until James answers choice
  5 of the proposal on #782 (Quality gates in the build for new and
  changed code), a server file a change touches is held to
  every rule, whole, or takes the stall valve, logged on #791 (Rule
  exceptions log).
- **Hono 5** is at release candidate with no date. The plan builds
  on 4.13.x.
- **The Hugo bundle is unproven.** Hugo 0.164.0 must bundle a
  `.mts` schema, Valibot and `hono/client` into the page script
  under the site's CSP. Phase 2 proves it before any form depends
  on it.
- **CDN caching of read-only answers** (`/api/checkout/config`,
  `/api/dates`, `/api/events`) would save invocations. It is left
  out, since `netlify.toml` says API answers are never cached, and
  is a later question for James.
- **The audit is still owed.** The audit table of #778 (the server
  on Hono), every parameter and what is done to it today, is the
  security lane's. Phases 3 to
  6 write their schemas from its rows.

## Sources

The rollout plan, with every doc it cites and the date each was
read:
<https://github.com/north-foster-farm/north-foster-farm/issues/778#issuecomment-7074201944>.
The quality gates proposal:
<https://github.com/north-foster-farm/north-foster-farm/issues/782#issuecomment-7075114694>.
