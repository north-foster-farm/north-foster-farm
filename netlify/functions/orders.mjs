// POST /api/orders: validate, recompute every figure, revalidate the
// date, then take the payment and record the order (lib/checkout.mjs).
// Nothing is recorded until the money is in.
//
// The body is the order plus `payment`:
//   { method: "card" | "applepay" | "googlepay" | "cashapp",
//     sourceId, verificationToken? }           one request, paid
//   { method: "venmo", stage: "create" }       -> { paypalOrderId }
//   { method: "venmo", stage: "capture", paypalOrderId }   paid
// and `attempt`, counted up by the page after a decline so the next
// try gets fresh idempotency keys.
//
// Responses the client acts on:
//   200 paid (or, for Venmo's first stage, the PayPal order)
//   402 declined: { declined, code, message }, try another way
//   409 stale date, with a fresh list
//   422 validation errors, or a total that no longer matches
//   503 transient failure, safe to retry     502 permanent
//   429 too many tries from one address      204 dropped (honeypot)

import { createHash } from "node:crypto";

import catalog from "../../data/catalog.json" with { type: "json" };
import terms from "./lib/terms.mjs";
import discountCodes from "../../data/discount-codes.json" with {
  type: "json",
};
import { indexCatalog } from "../../assets/scripts/order/lib/catalog.mjs";
import { lockOn } from "../../assets/scripts/order/lib/totals.mjs";
import { validateOrder } from "../../assets/scripts/order/lib/validate.mjs";
import { parts, today } from "../../assets/scripts/order/lib/zoned.mjs";
import { sessionFrom } from "./lib/auth.mjs";
import {
  METHODS, announceNew, finishVenmo, ownRecord, payWithCredit,
  payWithSquare, startVenmo,
} from "./lib/checkout.mjs";
import { now as clock, real } from "./lib/clock.mjs";
import {
  balanceOf, creditBalance, getLedger, heldBy, restoreCredit, spendCredit,
} from "./lib/credit.mjs";
import { json, ORDER_BUDGET_MS, readJson } from "./lib/http.mjs";
import { alert, count } from "./lib/health.mjs";
import { log, withLog } from "./lib/log.mjs";
import { sendMail } from "./lib/mail.mjs";
import { gate } from "./lib/maintenance.mjs";
import { DECLINE_MESSAGES as PAYPAL_DECLINES } from "./lib/paypal.mjs";
import {
  INVALID_CODE, findGroupByCode, groupCodeOf, groupOf, memberKeyOf,
  memberTerms, roundFor,
} from "./lib/groups.mjs";
import {
  PASS_MESSAGES, getPass, holdPass, passCodeOf, passProblem, releasePass,
  waivesFee,
} from "./lib/passes.mjs";
import { PAYMENTS_OFF, paymentsOff } from "./lib/payments.mjs";
import { pickupSchedule } from "./lib/pickups.mjs";
import {
  getOrder, orderForSubmission, paymentsOf, reserveOrderId, submissionKey,
} from "./lib/records.mjs";
import {
  DECLINE_MESSAGES as SQUARE_DECLINES, receiptLink,
} from "./lib/square.mjs";
import { checkLines } from "./lib/stock.mjs";
import { limitExempt } from "./lib/limit-exempt.mjs";
import { deployContext, stores as defaultStores } from "./lib/store.mjs";

const index = indexCatalog(catalog);

const KEY = /^[A-Za-z0-9-]{16,64}$/;
const MAX_ATTEMPT = 50;

// Per-instance, best effort. Enough to blunt a runaway script.
const RATE = { windowMs: 10 * 60_000, max: 12 };
const hits = new Map();

const rateLimited = (ip, now) => {
  if (!ip) return false;

  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE.windowMs);

  recent.push(now);
  hits.set(ip, recent);

  return recent.length > RATE.max;
};

// Human-readable, and the same for every retry of one submission:
// `NFF-YYMM-` and six letters and digits, about a billion a month.
// Ids before #253 had four, and stay valid everywhere (an id is only
// ever looked up whole). `draw` is the nth candidate, for when an
// earlier one is taken (lib/records.mjs, reserveOrderId).
export const ID_LENGTH = 6;

export const orderId = (key, now, draw = 0) => {
  const p = parts(now, terms.timeZone);
  const yymm = `${String(p.year).slice(2)}${String(p.month).padStart(2, "0")}`;
  const hash = createHash("sha256")
    .update(draw ? `${key}#${draw}` : key)
    .digest("hex");
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let tail = "";

  for (let i = 0; i < ID_LENGTH; i++) {
    tail += alphabet[parseInt(hash.slice(i * 2, i * 2 + 2), 16) % 32];
  }

  return `NFF-${yymm}-${tail}`;
};

// What the page shows once the order is paid: the payment just taken.
// Only ever this submission's own record (checked by `own` first).
const paidResponse = (order) => {
  const p = paymentsOf(order).at(-1) || {};

  return json(200, {
    orderId: order.id,
    status: order.status,
    totals: order.totals,
    fulfilment: order.fulfilment,
    lines: order.lines,
    customer: {
      firstName: order.customer.firstName || "",
      name: order.customer.name,
      email: order.customer.email,
    },
    payment: {
      via: p.via,
      method: p.method,
      brand: p.brand || null,
      last4: p.last4 || null,
      wallet: p.wallet || null,
      receiptUrl: receiptLink(p.receiptUrl),
    },
  });
};

// Another submission's record turned up (#253), and the farm has been
// alerted. Not retryable, and no order id: the one at hand is someone
// else's.
const collided = () => json(502, {
  retryable: false,
  message: "Something went wrong taking your payment.",
});

export const handle = async (req, {
  stores = defaultStores(),
  mail = sendMail,
  env = process.env,
  now = clock(),
  ip = "",
  square,
  paypal,
  fetchImpl,
  sleep,
  newId = orderId,
  // The request ends here, well inside Netlify's 10 s: every call to
  // a processor shares it (lib/http.mjs).
  deadline = Date.now() + ORDER_BUDGET_MS,
  // Where the emails of a paid order are sent from, once the record is
  // written: the platform's waitUntil for the real function, so they go
  // after the answer; here they are awaited, which tests rely on.
  after = (work) => work,
} = {}) => {
  const payload = await readJson(req);

  if (!payload || typeof payload !== "object") {
    return json(400, { errors: { body: "Expected a JSON body." } });
  }
  if (payload.website) return new Response(null, { status: 204 });

  // A preview takes no payment, so it takes no order: say so, rather
  // than failing on the first missing key (a 502 and an alert).
  if (paymentsOff(env)) {
    return json(403, {
      paymentsOff: true, message: PAYMENTS_OFF, error: PAYMENTS_OFF,
    });
  }

  // Maintenance (#267) refuses a new order. Two things still go
  // through, because money has moved or is about to: a Venmo capture
  // the customer already approved, and the record of a submission
  // that was paid before the flip (checked below).
  const closed = await gate(stores, { req, env, now, area: "order" });
  const capturing = !!payload.payment && payload.payment.method === "venmo"
    && payload.payment.stage === "capture";

  // A customer can reach the limit through a run of declines, so it is
  // said plainly: a silent answer here read as a placed order.
  if (!closed && !limitExempt(req, env)
    && rateLimited(ip, real(now).getTime())) {
    return new Response(JSON.stringify({
      message: "There have been too many tries to place your order. " +
        "Wait a few minutes and try again.",
    }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(RATE.windowMs / 1000),
      },
    });
  }

  const key = String(payload.idempotencyKey || "");

  if (!KEY.test(key)) {
    return json(422, { errors: { idempotencyKey: "Missing submission key." } });
  }

  // The emails wait on the answer, not the other way round (#268); the
  // jobs send any that this does not.
  const announce = async (record) => {
    await after(announceNew(stores, record, { mail, env, now }));

    return record;
  };

  // Nothing goes back to the page but this submission's own record;
  // another's is refused and the farm alerted (#253).
  const own = async (record) => {
    try {
      return paidResponse(await ownRecord(stores, record, key, {
        stage: "answer", env, mail, now,
      }));
    } catch (error) {
      if (error && error.name === "OrderCollisionError") return collided();
      throw error;
    }
  };

  // A submission already paid is answered with its record, whatever
  // changed since (the stock, the date, a new attempt's fresh keys):
  // it is never charged again.
  const prior = await orderForSubmission(stores, key);

  if (prior) return own(prior);
  if (closed && !capturing) return closed;

  const attempt = Number.isInteger(payload.attempt)
    && payload.attempt >= 1 && payload.attempt <= MAX_ATTEMPT
    ? payload.attempt
    : 1;
  const payment = payload.payment && typeof payload.payment === "object"
    ? payload.payment
    : {};
  const method = String(payment.method || "");

  if (!METHODS[method]) {
    return json(422, { errors: { payment: "Choose how to pay." } });
  }

  // A signed-in customer's discount group comes from their record,
  // never from the payload.
  const session = await sessionFrom(stores, req, { now });
  const group = session && session.customer
    ? session.customer.discountGroup || null
    : null;
  // A buying group (#471): the code the page applied, checked again
  // here, or the signed-in customer's own membership. A code that no
  // longer works is answered first, like a refused pass, so the page
  // drops it and the order is priced and placed as anyone's.
  const groupCode = groupCodeOf(payload.groupCode);
  const buying = groupCode
    ? await findGroupByCode(stores, groupCode)
    : (session ? groupOf(memberKeyOf(session.customer)) : null);

  if (groupCode && !buying) {
    return json(422, { errors: { groupCode: INVALID_CODE } });
  }
  // Credit (#471) spends only when signed in: the account
  // is what says the credit is theirs. As much as the order needs
  // comes off, and the rest of the total is paid as usual.
  // A retry of this submission (a timeout kept the spend for it)
  // already holds credit against the id it reserved; that hold counts
  // as available, or the retry would price the order without it and
  // the hold would be lost (security re-re-review, 6427102482).
  // Credit is the account's (James, #495 decision 6): a member who
  // left or was removed spends it on any signed-in order, with or
  // without a group, until it expires.
  const reserved = session
    ? await stores.orders.get(submissionKey(key)) : null;
  const ledger = session
    ? await getLedger(stores, session.email) : null;
  const creditAvailable = ledger
    ? balanceOf(ledger, now)
      + (reserved && reserved.id ? heldBy(ledger, reserved.id) : 0)
    : 0;
  // A pass (#182) lifts the delivery minimum for this one order, and
  // the fee if it was issued so. It is checked against the order's
  // email, held for this submission (its key: the id is reserved
  // later, #253) while it is paid, and used up by the paid record. A
  // standing one is neither held nor used up.
  const passCode = passCodeOf(payload.pass);
  const pass = passCode ? await getPass(stores, passCode) : null;
  const problem = passCode
    ? passProblem(pass, {
      email: (payload.customer || {}).email, holder: key, now,
    })
    : null;

  // A code the page applied and the server refuses is answered first,
  // whatever else the order needs, as `errors.pass`: the page shows it
  // by the code box and drops the code. Answered later, a fee the page
  // took off came back as a changed total and Pay looped (QA, #182).
  // A pickup ignores a code; it lifts nothing there.
  if (problem && (payload.fulfilment || {}).method === "delivery") {
    return json(422, { errors: { pass: PASS_MESSAGES[problem] } });
  }

  const result = validateOrder(payload, {
    index, terms: memberTerms(terms, buying), now, group,
    codes: discountCodes.codes,
    // The lock holds through its last day, by the order's day in the
    // farm's zone, as the prices in force are chosen.
    lock: buying
      ? lockOn(buying.priceLock || null, today(now, terms.timeZone))
      : null,
    deliverTo: buying ? terms.model.location(buying.location) || null : null,
    credit: creditAvailable,
    schedule: pickupSchedule(env),
    waive: {
      minimum: !!passCode && !problem,
      fee: !!passCode && !problem && waivesFee(pass),
    },
  });

  if (!result.ok) {
    return json(result.status, {
      errors: result.errors,
      dates: result.dates || undefined,
    });
  }

  // The catalog said it was in stock at build time; the count says
  // whether it still is. Field errors, like the validator's, plus the
  // fresh availability so the page can bring the cart into line.
  const stock = await checkLines(stores, result.order.lines, {
    env, deadline,
  });

  if (!stock.ok) {
    return json(422, { errors: stock.errors, stock: stock.items });
  }

  // The customer authorised the figure on their screen. If ours
  // differs (a price changed under them, a group they did not know
  // of) they see the new total and decide again; nothing is charged.
  if (result.order.flags.totalMismatch) {
    // No id yet: one is reserved only for an order about to be paid.
    log.warn({
      event: "order.total_mismatch",
      claimed: payload.claimedTotal,
      computed: result.order.totals.total,
    });

    return json(422, {
      errors: {
        total: "The total changed while you were on this page. Check " +
          "it and pay again.",
      },
      totals: result.order.totals,
    });
  }

  // The id is this submission's before Square or PayPal hears of it, so
  // two customers can never share one (#253).
  let id;

  try {
    id = await reserveOrderId(stores, key, (n) => newId(key, now, n), now);
  } catch (error) {
    log.error({ event: "order.reserve_failed", error: String(error) });
    await alert(stores, "order.reserve_failed", {
      payment: method, error: String(error),
    }, { env, mail, now });

    return json(503, {
      retryable: true,
      message: "We couldn't reach our payment system. Nothing was " +
        "charged. Please try again in a moment.",
    });
  }

  // Paid already, and the answer was lost: the page may have moved on
  // to a new attempt, whose fresh keys would charge again. The record
  // is the answer; nothing is charged twice.
  const recorded = await getOrder(stores, id);

  if (recorded) return own(recorded);

  // Every way is booked by paying: a window the schedule offers needs
  // no second yes from the farm (W11d).
  const waived = result.order.flags.minimumWaived
    || !!result.order.totals.feeWaived;

  // Held by a swap (#301): another submission that took the pass in
  // the meantime wins, and this one is refused like any spent code.
  if (waived && !pass.standing
    && !(await holdPass(stores, pass, key, now))) {
    return json(422, {
      errors: { pass: PASS_MESSAGES.held },
    });
  }

  const order = {
    id,
    submittedAt: now.toISOString(),
    ...result.order,
    pass: waived ? pass.code : null,
    passWaivesFee: waived && waivesFee(pass),
    // The group tag (#471): which group, the round the order falls in,
    // and whether the code or the account brought it. Null for every
    // other order, so nothing else changes.
    group: buying
      ? {
        key: buying.key,
        round: roundFor(buying, terms, result.order.fulfilment.date),
        viaCode: !!groupCode,
        // The code came by the group's link, not typed: the join log's
        // path (#495). Only ever true, so other tags are as they were.
        ...(groupCode && payload.groupLink === true ? { viaLink: true } : {}),
      }
      : null,
    // Whose credit the order spends (security review, 6425904452):
    // the signed-in account's, never the email typed on the form.
    ...(result.order.totals.credit > 0 && session
      ? { creditFrom: session.email } : {}),
    fulfilment: { ...result.order.fulfilment, state: "agreed" },
    meta: {
      formVersion: catalog.version,
      idempotencyKey: key,
      attempt,
    },
  };
  const options = {
    env, mail, now, fetchImpl, sleep, square, paypal, deadline,
  };

  // The credit comes off the ledger before any money moves (security
  // review, 6425904452): a conditional write keyed on the order, so
  // two checkouts at once can spend the same balance only once, and a
  // balance that fell short since the page looked answers "the total
  // changed" with nothing charged. Venmo's first step takes no money,
  // so the spend waits for its capture.
  const credit = order.totals.credit || 0;
  const spendsNow = credit > 0 && order.creditFrom
    && !(method === "venmo" && String(payment.stage || "") === "create");
  let spent = false;

  if (credit > 0 && !order.creditFrom) {
    return json(422, { errors: { payment: "Sign in to use your credit." } });
  }
  if (spendsNow) {
    try {
      await spendCredit(stores, order.creditFrom, {
        orderId: id, amount: credit, now,
      });
      spent = true;
    } catch (error) {
      log.warn({
        event: "credit.short", id, credit,
        error: String(error && error.message),
      });

      const fresh = validateOrder(payload, {
        index, terms: memberTerms(terms, buying), now, group,
        codes: discountCodes.codes,
        lock: buying
          ? lockOn(buying.priceLock || null, today(now, terms.timeZone))
          : null,
        deliverTo: buying ? terms.model.location(buying.location) || null
          : null,
        credit: await creditBalance(stores, order.creditFrom, now),
        schedule: pickupSchedule(env),
        waive: {
          minimum: !!passCode && !problem,
          fee: !!passCode && !problem && waivesFee(pass),
        },
      });

      return json(422, {
        errors: {
          total: "The total changed while you were on this page. Check " +
            "it and pay again.",
        },
        totals: fresh.ok ? fresh.order.totals : order.totals,
      });
    }
  }
  // A payment that certainly took no money gives the credit back.
  const giveBack = async () => {
    if (!spent) return;
    await restoreCredit(stores, order.creditFrom, {
      orderId: id, amount: credit, now,
    }).catch((e) => log.warn({
      event: "credit.restore_failed", id, error: String(e.message),
    }));
  };

  try {
    // Credit covered the whole order (#471): nothing to charge, so no
    // card and no Venmo. The page says so with method `credit`; the
    // totals, not the page, decide, so a card on a covered order is
    // never charged and credit alone never pays an order with money
    // due.
    const covered = order.totals.total === 0 && order.totals.credit > 0;

    if (covered || method === "credit") {
      if (!covered) {
        await giveBack();

        return json(422, { errors: { payment: "Choose how to pay." } });
      }

      return own(await announce(await payWithCredit(stores, order, {
        key, attempt,
      }, options)));
    }

    if (method === "venmo") {
      const stage = String(payment.stage || "");

      if (stage === "create") {
        const started = await startVenmo(stores, order, {
          key, attempt,
        }, options);

        // An earlier attempt of this submission was paid after all.
        if (started.paid) return own(await announce(started.paid));

        return json(200, {
          orderId: order.id, paypalOrderId: started.paypalOrderId,
        });
      }
      if (stage === "capture") {
        const paypalOrderId = String(payment.paypalOrderId || "");

        if (!paypalOrderId) {
          await giveBack();

          return json(422, {
            errors: { payment: "Missing the PayPal order." },
          });
        }

        return own(await announce(await finishVenmo(stores, order, {
          key, attempt, paypalOrderId,
        }, options)));
      }

      await giveBack();

      return json(422, { errors: {
        payment: "The Venmo payment didn't come through. Start it again.",
      } });
    }

    const sourceId = String(payment.sourceId || "");

    if (!sourceId) {
      await giveBack();

      return json(422, { errors: { payment: "Enter your card details." } });
    }

    return own(await announce(await payWithSquare(stores, order, {
      key, attempt, method, sourceId,
      verificationToken: payment.verificationToken
        ? String(payment.verificationToken)
        : undefined,
    }, options)));
  } catch (error) {
    const retryable = !!(error && error.retryable);
    const declined = !!(error && error.declined);
    const code = (error && error.code) || null;

    if (declined) {
      log.info({
        event: "payment.declined", id: order.id, method, code, attempt,
      });
      await count(stores, "declined", now);

      // A decline is the one failure that certainly took no money, so
      // the pass goes back on offer now rather than when the hold runs
      // out (QA, #182). Every other failure keeps the hold: a timeout
      // may have charged after all, and this submission's retry, with
      // the same key, holds the pass still (security review).
      if (order.pass && !pass.standing) {
        await releasePass(stores, order.pass, key).catch((e) => log.warn({
          event: "pass.release_failed", id: order.id,
          error: String(e.message),
        }));
      }

      await giveBack();

      return json(402, {
        declined: true,
        code,
        message: SQUARE_DECLINES[code] || PAYPAL_DECLINES[code]
          || "The payment didn't go through. Try another way to pay.",
      });
    }
    if (error && error.name === "CheckoutError") {
      // A payment the checkout refused before taking money; a
      // timeout or an unknown failure keeps the spend, since the
      // retry under the same key may find the money taken.
      await giveBack();

      return json(409, { errors: { payment: error.message }, code });
    }
    if (error && error.name === "OrderCollisionError") return collided();

    log.error({
      event: "order.failed",
      retryable,
      error: String(error && error.message),
      detail: error && error.detail,
      order,
    });
    // The customer's page retries a retryable failure and shows the
    // failure card otherwise; either way the farm hears now.
    await alert(stores, "order.create_failed", {
      id: order.id,
      retryable,
      method: order.fulfilment.method,
      payment: method,
      total: order.totals.total,
      error: String(error && error.message),
      detail: error && error.detail ? JSON.stringify(error.detail).slice(0, 500)
        : null,
    }, { env, mail, now });

    // Outside production the answer carries the processor's own
    // error, so a sandbox failure can be read from the response. Both
    // must say so: a production deploy missing SQUARE_ENV is still
    // production, and its customers get no processor detail.
    const sandbox = env.SQUARE_ENV !== "production"
      && deployContext(env) !== "production";

    // A failure that will not be retried took no money for good (a
    // retryable one may have, and its retry settles it), so the
    // credit goes back.
    if (!retryable) await giveBack();

    return json(retryable ? 503 : 502, {
      retryable,
      orderId: order.id,
      message: retryable
        ? "We couldn't reach our payment system. Please try again in a " +
          "moment. A retry never charges you twice."
        : "Something went wrong taking your payment.",
      detail: sandbox
        ? { error: String(error.message), processor: error.detail }
        : undefined,
    });
  }
};

export default withLog("orders", async (req, context) =>
  handle(req, {
    ip: context && context.ip,
    // Sent after the answer where the platform can; where it cannot,
    // the jobs send them within the quarter hour.
    after: (work) => {
      if (context && typeof context.waitUntil === "function") {
        context.waitUntil(work);
      }
    },
  }));

export const config = {
  path: "/api/orders",
  method: "POST",
};
