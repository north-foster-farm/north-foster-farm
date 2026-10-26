import { current, indexCatalog } from "./lib/catalog.mjs";
import { buildModel } from "./lib/events.mjs";
import { moneyOn } from "./lib/money-on.mjs";
import {
  draftOccurrence, dropOnly, dropSeriesCode, fulfilmentDate, locationCount,
  placesFact,
} from "./lib/scheduled.mjs";
import { groupFromQuery, withPlaces } from "./lib/group.mjs";
import { linkedMethod, withoutParam } from "./lib/query.mjs";
import { sentence } from "./lib/sentence.mjs";
import { summarize } from "./lib/summary.mjs";
import {
  computeTotals, dollars, lockOn, meetsMinimum, toCents,
} from "./lib/totals.mjs";
import {
  disallowedFor, normalizeCode, phoneOk, validateOrder, zipInfo,
} from "./lib/validate.mjs";
import { pickupTimes, windowLabel } from "./lib/schedule.mjs";
import { label, today } from "./lib/zoned.mjs";
import { Cart, JOKE_CODE } from "./cart/cart.js";
import { celebrate } from "./celebrate.js";
import { DateLists } from "./date-lists.js";
import { Draft } from "./draft.js";
import { Errors } from "./errors.js";
import { Lapsed } from "./lapsed.js";
import { Payment } from "./pay.js";
import { Pending } from "./pending.js";
import { crumb } from "./report.js";
import { wireSwitch } from "./restock.js";
import { Stock } from "./stock.js";
import { Submitter } from "./submit.js";
import { announceCart } from "../cart-badge/announce.js";
import { stampFrom } from "../session/cache.js";
import {
  SCRUBBED, pullCart, scrubStray,
} from "../session/cart-sync.js";
import { me } from "../session/session.js";
import { api } from "../utils/api.js";
import { setBusy as spin } from "../utils/busy-button.js";
import { whileLoading } from "../utils/skeleton.js";

// A send that can't get through is tried once more this soon, while
// the page still shows it being placed, and then not again (#154).
const RETRY_DELAY = 3000;

// The customer's details and delivery address: what signing out (or a
// scrub of another account's draft) takes out of the draft (#149).
const DETAIL_FIELDS = "[data-field^='customer.'], [data-field^='delivery.']";

const sha256 = async (text) => {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0")).join("");
};

const qs = (root, selector) => root.querySelector(selector);
const all = (root, selector) => Array.from(root.querySelectorAll(selector));

// Restart a CSS animation by re-applying its class.
const pulse = (el, className) => {
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
};

// Brings the rail's lit link into view inside whatever box scrolls the
// rail, never the page. scrollIntoView moved Chromium's Tab starting
// point to the link, so on load the first Tab skipped the skip link
// for the link after it (#291).
const keepInRail = (link) => {
  let box = link.parentElement;

  while (box && box !== document.body) {
    const { overflowY } = getComputedStyle(box);

    const scrolls = /auto|scroll/.test(overflowY);

    if (scrolls && box.scrollHeight > box.clientHeight) break;
    box = box.parentElement;
  }
  if (!box || box === document.body) return;

  const a = link.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  const by = a.top < b.top ? a.top - b.top
    : a.bottom > b.bottom ? a.bottom - b.bottom : 0;

  if (by) box.scrollBy({ top: by, behavior: "smooth" });
};

export class OrderForm {
  static init() {
    document.addEventListener("DOMContentLoaded", () => {
      const form = document.getElementById("order-form");

      if (form) new OrderForm(form).start();
    });
  }

  // The prices in force today in the farm's zone, so the 1 January
  // changes (data/delivery.json, money.changes) arrive with the day;
  // an order being changed keeps those of the day it was placed.
  get money() {
    const placed = this.editing && this.editing.placed;

    return moneyOn(this.terms.money, today(
      placed ? new Date(placed) : this.dates.now(), this.terms.timeZone
    ));
  }

  constructor(form) {
    const data = JSON.parse(document.getElementById("order-data").textContent);

    this.form = form;
    this.catalog = data.catalog;
    this.aliases = data.aliases || {};
    // The scheduled pickups the page validates against, built as the
    // functions build them (lib/events.mjs).
    this.terms = {
      ...data.terms, model: buildModel(data.locations, data.series),
    };
    // The drop site's series code (data/series.json), for the old
    // ?method=scituate link and a draft saved before scheduled pickup.
    this.dropSeries = dropSeriesCode(this.terms.model);
    this.drop = this.terms.model.series
      .find((s) => s.code === this.dropSeries) || {};
    this.contact = data.contact;
    // Discount codes, by hash; the plain codes stay on the server.
    this.codes = data.codes || [];
    this.code = null;
    // A pass the farm issued (#182): its code, once /api/pass says it
    // lifts the delivery minimum, and whether it waives the delivery
    // fee too. The server checks it again. To the customer it is a
    // discount code like any other.
    this.pass = null;
    this.passFee = false;
    // A buying group (#471): what /api/group said its code unlocks
    // (the name, the lock, its place and series), and the code itself
    // when one was typed or linked, so the order carries it; null for
    // a member signed in, whose account the server knows. The page
    // embeds nothing of a group, so its places are folded into the
    // model from the answer (`raw` is what the page embeds).
    this.raw = { locations: data.locations, series: data.series };
    this.member = null;
    this.groupCode = null;
    // A draft's pickup at a round the lists lack until the group is
    // unlocked, chosen then.
    this.wantedOccurrence = null;
    this.index = indexCatalog(this.catalog);
    this.errors = new Errors(form);
    // /order/?edit=<id> changes a paid order (startEdit): its own draft,
    // so the cart the header reads is left alone, and its own endpoint.
    const edit = new URLSearchParams(location.search).get("edit") || "";

    this.editId = /^[A-Za-z0-9-]{1,32}$/.test(edit) ? edit : null;
    this.editing = null;
    this.draft = new Draft(this.editId ? { name: `nff-edit-${this.editId}` }
      : {});
    this.dates = new DateLists(form, () => this.refresh());
    this.dates.place = (code) => this.terms.model.location(code);
    // A pickup time to select once its day's windows are drawn: a
    // restored draft's, or the dialog's.
    this.wantedWindow = null;
    this.lapsed = new Lapsed(document.getElementById("order-lapsed"), {
      onUse: (choice) => this.useLapsed(choice),
      onOther: (method) => this.otherWay(method),
    });
    this.submitter = new Submitter(this.editId
      ? { url: `/api/account/orders/${this.editId}/edit` }
      : {});
    this.saveButton = document.getElementById("order-save");
    this.stock = new Stock(form, {
      onChange: (notice) => this.stockMoved(notice),
      setQty: (input, n) => this.setQty(input, n),
      inStockOnly: wireSwitch(form),
      onLock: () => this.refresh(),
      nameOf: (sku) => this.index.get(sku)?.lineName,
    });
    this.stockNotice = document.getElementById("order-stock");
    // The cart owns its pane; the form tells it what to show and hears
    // back what the customer did in it (docs/cart.md 4.1).
    this.cart = new Cart(document.getElementById("order-cart"), {
      form,
      bar: document.querySelector(".order-topbar"),
      onRemove: (sku) => this.remove(sku),
      onWay: (method) => this.pickWay(method),
      onCode: () => this.applyCode(),
      onCheckout: () => this.toPickup(),
    });
    // A change to a paid order keeps the prices of its day.
    if (!this.editId) this.cart.setMoney(this.money);
    this.result = document.getElementById("order-result");
    this.pending = new Pending(document.getElementById("order-pending"));
    this.submitButton = document.getElementById("order-submit");
    this.payment = new Payment(document.getElementById("payment"), this);
    this.busy = false;
    // The quantity box with focus, which refresh() keeps open.
    this.typing = null;
    // The signed-in customer's discount group, from /api/me. The server
    // applies it again from the session; this only shows it.
    this.group = null;
    // Whether /api/me said so: the thank-you card then leaves out the
    // line about the account the order made (#114).
    this.isSignedIn = false;
  }

  async start() {
    if (this.editId) {
      this.startEdit();

      return;
    }

    this.wire();

    // Nothing is retried in the background any more (#154); an order
    // an older page left to retry is forgotten, its draft kept.
    this.draft.clearPending();

    // This browser's draft first, so the form is never empty while the
    // account's copy is on its way: a change made meanwhile saves the
    // whole cart, and is newer than the account's. The account's copy
    // replaces it only when nothing changed here (#149). A draft left
    // by someone not signed in here loses its details before it is
    // shown: signed out, at once; signed in, once /api/me (usually
    // cached) names the account, and only for a draft tagged at all.
    window.addEventListener(SCRUBBED, () => this.clearDetails());
    if (!stampFrom(document.cookie)) {
      scrubStray(null);
    } else if (this.draft.owner()) {
      const who = await me().catch(() => ({ signedIn: false }));

      scrubStray(who.signedIn ? who.owner : null);
    }
    this.resume();
    if (await pullCart()) this.resume({ fresh: true });

    // Another tab changed the cart (search's Add on another page, a
    // line taken out there): take its lines, so the next change here
    // does not save a stale cart over them (#356).
    window.addEventListener("storage", (e) => {
      if (e.key === this.draft.name) this.syncLines();
    });

    this.methodFromQuery();
    this.addFromQuery();
    this.dates.load();
    // /order/?group=<code>: a buying group's link (#471) puts its code
    // in the box, and applyCode tries it as a typed one would be.
    const linked = groupFromQuery(location.search);

    this.clearQuery("group");
    if (linked) this.cart.setCodeValue(linked);
    this.applyCode({ quiet: true });
    this.refresh();
    this.stock.start();
    this.payment.start();

    // A signed-in customer sees their discount group as they shop, and
    // their details arrive already filled in, under skeletons while
    // they come (#271). Someone with no session stamp is signed out,
    // so their fields never wait; if the answer fails, they type.
    const fields = stampFrom(document.cookie)
      ? all(this.form, "[data-prefill-region]")
      : [];

    whileLoading(fields, me, { render: (who) => this.signedIn(who) });
  }

  signedIn(who) {
    if (!who.signedIn || !who.customer) return;

    this.isSignedIn = true;

    const group = who.customer.discountGroup || null;

    if (group && group !== this.group) {
      this.group = group;
      this.refresh();
    }
    // A buying group's member (#471) needs no code: the account's
    // group is asked for, and its pickup and prices follow.
    if (who.customer.memberGroup && !this.member && !this.editing) {
      this.applyGroup("").catch(() => {});
    }
    this.prefill(who.customer);
  }

  // /order/?edit=<id>: the page opens one of the customer's paid orders
  // for a change (#160), priced by the same code as a new order. What
  // is paid shows under the total with the difference, which is all
  // the payment section takes; with nothing to pay, Save changes sends
  // it. An order that cannot be changed goes back to the account page.
  async startEdit() {
    this.wire();

    const { ok, status, data } = await api("/api/account/orders");

    if (status === 401) {
      location.replace(`/login/?next=${encodeURIComponent(
        location.pathname + location.search
      )}`);

      return;
    }

    const order = ok
      ? (data.orders || []).find((o) => o.id === this.editId)
      : null;

    if (!order || !order.canChange) {
      location.replace("/account/#orders");

      return;
    }

    const sum = (list) => (list || []).reduce((s, x) => s + (x.amount || 0),
      0);

    // A fee a missed delivery kept paid for that trip: it counts toward
    // nothing now (#193).
    this.editing = {
      id: order.id, held: sum(order.payments) - sum(order.refunds),
      kept: order.keptFee || 0, keptDate: order.keptDate || null,
      placed: order.submittedAt,
    };
    for (const line of order.lines) {
      this.stock.held[line.sku] = line.qty;
      this.hold(line);
    }

    const who = await me().catch(() => ({}));
    const customer = (who && who.customer) || {};

    this.group = customer.discountGroup || null;
    this.pass = order.pass || null;
    this.passFee = !!(order.pass && order.passWaivesFee);

    const saved = this.draft.load();

    this.restore(saved ? saved.payload : {
      customer: { ...order.customer, email: customer.email },
      lines: order.lines.map(({ sku, qty }) => ({ sku, qty })),
      fulfilment: order.fulfilment,
      code: order.code,
    });

    const banner = document.getElementById("order-editing");

    // Draft wording.
    banner.textContent = `You're changing order ${order.id}. You pay ` +
      "only the difference, or we refund it.";
    banner.hidden = false;
    for (const heading of document.querySelectorAll(
      ".page-heading h1, [data-topbar-title]"
    )) {
      heading.textContent = "Change your order";
    }
    this.saveButton.addEventListener("click", (e) => this.submit(e));

    this.dates.load();
    this.applyCode({ quiet: true });
    this.refresh();
    this.stock.start();
    this.payment.start();
  }

  // A line the paid order holds. An archived one's row shows, and its
  // quantity can fall but never rise past what is held (6305650920):
  // the line stays in the order rather than vanishing and being
  // refunded on save.
  hold({ sku, qty }) {
    const input = this.form.querySelector(`[data-qty="${CSS.escape(sku)}"]`);
    const row = input && input.closest(".order-item[data-archived]");

    if (!row) return;
    row.dataset.held = "";
    input.dataset.max = String(qty);
  }

  // Changing a paid order: with nothing to pay, Save changes stands in
  // for the payment section. The cart shows what is paid and the
  // difference (cart.js renderEdit).
  renderEdit(total) {
    if (!this.editing) return;

    const { held, kept } = this.editing;
    const diff = total - (held - kept);

    this.payment.root.hidden = diff <= 0;
    this.saveButton.hidden = diff > 0;
    // The card's own Pay button shows only with the card chosen.
    this.submitButton.hidden = diff <= 0
      || this.payment.state.dataset.cardOpen !== "true";
  }

  // The × on a cart line takes every unit of that product out.
  remove(sku) {
    const input = qs(this.form, `[data-qty="${CSS.escape(sku)}"]`);

    if (!input) return;
    this.setQty(input, 0);
    this.changed();
  }

  // A pick in the cart's switch sets the page's radio, as a click on
  // its card would, less the scroll to its fields: the customer is in
  // the cart, not at the section (#203).
  pickWay(method) {
    const radio = qs(this.form, `[name='method'][value='${method}']`);

    if (!radio || radio.checked) return;
    radio.checked = true;
    this.quietMethod = true;
    radio.dispatchEvent(new Event("change", { bubbles: true }));
    this.quietMethod = false;
  }

  // Proceed to checkout: to Pickup or delivery, its legend focused.
  toPickup() {
    const target = document.getElementById("pickup");

    target.scrollIntoView({ behavior: "smooth", block: "start" });
    qs(target, "legend").focus({ preventScroll: true });
  }

  // Name, email and phone from the customer's record, filled in as
  // ordinary fields.
  prefill(customer) {
    let any = false;

    for (const input of all(this.form, "[data-prefill]")) {
      const value = customer[input.dataset.prefill];

      if (!value) continue;
      if (!input.value) input.value = value;
      any = true;
    }
    this.formatPhone();

    this.showContact();
    if (any) this.draft.save(this.collect());
  }

  // The phone number as "(xxx) xxx-xxxx" while it is typed. A
  // deletion that lands on a bracket or a dash takes the digit before
  // it too, so backspace never fights the mask. A leading 1 is dropped.
  formatPhone(deleting = false) {
    const input = qs(this.form, "[data-field='customer.phone']");
    const raw = input.value;
    let digits = raw.replace(/\D/g, "");

    if (digits.length === 11 && digits.startsWith("1")) {
      digits = digits.slice(1);
    }
    if (deleting && /\D$/.test(raw)) digits = digits.slice(0, -1);
    digits = digits.slice(0, 10);

    const out = digits.length <= 3 ? (digits ? `(${digits}` : "")
      : digits.length <= 6 ? `(${digits.slice(0, 3)}) ${digits.slice(3)}`
        : `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;

    if (out !== raw) input.value = out;
  }

  // "Prefer text or call?" shows once the phone number is one we could
  // use, and fades in when it appears.
  showContact() {
    const row = qs(this.form, "[data-contact-row]");
    const phone = qs(this.form, "[data-field='customer.phone']");
    const on = phoneOk(phone.value.trim());

    if (row.dataset.shown === String(on)) return;
    row.dataset.shown = String(on);
    if (on) {
      row.classList.add("is-entering");
      requestAnimationFrame(() => requestAnimationFrame(() => {
        row.classList.remove("is-entering");
      }));
    }
  }

  wire() {
    this.form.addEventListener("input", () => {
      this.changed();
      this.revalidate();
    });
    this.form.addEventListener("change", (e) => {
      this.changed();
      this.revalidate();
      if (e.target.name === "method" && !this.quietMethod) {
        this.revealMethod();
      }
      if (e.target.name === "customer.marketing" && e.target.checked) {
        celebrate(e.target);
      }
      if (e.target.name === "delivery.toGroup") this.fillGroupAddress();
    });
    this.form.addEventListener("submit", (e) => this.submit(e));
    this.form.addEventListener("click", (e) => this.step(e));

    // Blur normalises whatever was typed into a quantity box.
    this.form.addEventListener("focusin", (e) => {
      if (e.target.matches("[data-qty]")) this.typing = e.target;
    });
    this.form.addEventListener("focusout", (e) => {
      if (e.target.matches("[data-qty]")) {
        this.typing = null;
        this.setQty(e.target, this.qty(e.target));
        this.refresh();
      }
      this.revalidate(e.target);
    });

    const phone = qs(this.form, "[data-field='customer.phone']");

    phone.addEventListener("input", (e) => {
      this.formatPhone((e.inputType || "").startsWith("delete"));
      this.showContact();
    });
    this.formatPhone();
    this.showContact();

    // The rail's Cart link, the header's cart link and #order-cart in
    // the URL bring the cart into view and focus it at every width
    // (#337, #402).
    document.getElementById("order-nav")
      ?.querySelector("a[href='#order-cart']")
      ?.addEventListener("click", (e) => {
        e.preventDefault();
        this.cart.show({ smooth: true, ring: true });
      });
    window.addEventListener("hashchange", () => {
      if (location.hash === "#order-cart") this.cart.show({ smooth: true });
    });
    if (location.hash === "#order-cart") this.cart.show();

    this.watchSections();
  }

  // The section on screen, named in three places: the sidebar's
  // outline from lg up, the phone's sticky bar below lg, and the total
  // bar from lg to xl. Bootstrap's spy only hears sections crossing a
  // band, so a fast scroll left a stale name, and the last section,
  // too short to reach the band, never lit (#204). This asks where
  // each section is on every frame the page moves.
  watchSections() {
    const nav = document.getElementById("order-nav");
    const catalog = document.getElementById("order-catalog");
    const titles = all(document, "[data-topbar-title]");
    const bars = all(document, ".order-topbar, .order-total-bar");
    const heading = document.querySelector(".page-heading h1");
    const wide = window.matchMedia("(min-width: 992px)");
    const xl = window.matchMedia("(min-width: 1200px)");
    const sections = all(nav, "a")
      .map((link) => ({
        link, target: document.querySelector(link.hash),
      }))
      .filter(({ target }) => target);
    // Each category's link, by its section; the catalog's rows, top to
    // bottom.
    const cats = new Map(sections
      .filter(({ target }) => target.classList.contains("order-cat"))
      .map(({ link, target }) => [target, link]));
    const rows = all(catalog, ".order-item");
    const cartHeading = document.getElementById("order-cart-heading");
    let shown = null;
    let tick = null;

    // Mark the link and its parent in the outline (Catalog, over a
    // category).
    const mark = (link) => {
      const parent = link.closest(".order-side-sub")
        ?.closest(".nav-item").querySelector(":scope > .nav-link");

      for (const a of all(nav, ".nav-link")) {
        a.classList.toggle("active", a === link || a === parent);
      }
      if (wide.matches) keepInRail(link);
    };

    const update = () => {
      tick = null;

      // A section is current once its top reaches the lower edge of
      // whichever bar is stuck at the top, less a little so a jump to
      // it lands inside it. The floating cart is at the foot of the
      // screen, not at its place in the page, so it counts only once
      // settled. From xl it is a column stuck beside the others and
      // never counts.
      const column = xl.matches;

      // The phone bar casts its shadow only once stuck; at rest it
      // lies flat under the header (O5).
      for (const bar of bars) {
        if (bar.classList.contains("order-topbar")) {
          bar.dataset.stuck = String(bar.getBoundingClientRect().top <= 0.5);
        }
      }

      const edge = bars.reduce((low, bar) => {
        const r = bar.getBoundingClientRect();

        return bar.offsetParent && getComputedStyle(bar).opacity !== "0"
          && r.top <= 1 ? Math.max(low, r.bottom) : low;
      }, 0);
      const line = edge + 24;
      const end = window.innerHeight + window.scrollY
        >= document.documentElement.scrollHeight - 2;
      let current = null;
      let best = -Infinity;

      for (const { link, target } of sections) {
        if (target.dataset.stuck === "true") continue;
        if (column && target.id === "order-cart") continue;
        // Settled, the cart begins at its heading, above the pane.
        const top = (target.id === "order-cart" ? cartHeading : target)
          .getBoundingClientRect().top;

        // On a tie the later link wins: a category over the catalog.
        // At the foot of the page the last section on screen wins,
        // since it may be too short ever to reach the line.
        if ((top <= line || (end && top < window.innerHeight))
          && (top >= best || end)) {
          best = top;
          current = link;
        }
      }

      // Within the catalog, the category is the one whose rows are
      // under the bar: the first row still showing below its edge
      // names it. A section's top crossing the line named it too late,
      // after the gap above its heading, while the rows under the bar
      // were already its own (#274).
      if (current && (current.hash === `#${catalog.id}`
        || cats.has(document.querySelector(current.hash)))) {
        const row = rows.find((el) => el.getBoundingClientRect().bottom
          > edge + 8);

        if (row && row.getBoundingClientRect().top < window.innerHeight) {
          current = cats.get(row.closest(".order-cat")) || current;
        }
      }

      if (current && current !== shown) mark(current);
      shown = current || shown;

      const name = current
        ? current.dataset.heading || current.textContent.trim()
        : heading ? heading.textContent.trim() : "";
      // A category's name in the bar carries the double chevron.
      const cat = !!current && current.hash.startsWith("#cat-");

      for (const title of titles) {
        // Below lg the bar drops the page name: it shows a category's
        // name or nothing (#327).
        const text = !cat && title.closest(".order-topbar") ? "" : name;

        if (title.textContent !== text) title.textContent = text;
        title.parentElement.toggleAttribute("data-cat", cat);
      }
    };
    const onScroll = () => {
      if (tick === null) tick = requestAnimationFrame(update);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    update();
  }

  changed() {
    this.refresh();
    this.draft.save(this.collect());
    // A change after a payment attempt began means the next attempt
    // must not reuse that attempt's keys (the order may differ).
    this.draft.touch();
  }

  // /order/?method=onfarm (or scheduled, delivery) chooses that way, as
  // a click on its card would: the home page's off-season band and the
  // map's pin cards. ?method=scheduled&series=<code> also chooses that
  // series' next date once the lists come, and the old
  // ?method=scituate the drop site series'. The link wins over a
  // restored draft's way. An unknown value is ignored. The query is
  // cleared, as ?add= is.
  methodFromQuery() {
    const radios = all(this.form, "[name='method']");
    const link = linkedMethod(
      location.search, radios.map((radio) => radio.value), this.dropSeries
    );

    this.clearQuery("method");
    this.clearQuery("series");
    if (!link) return;

    this.wantedSeries = link.series;
    if (link.method === this.method()) {
      this.chooseSeries();

      return;
    }

    radios.find((radio) => radio.value === link.method).checked = true;
    this.draft.save(this.collect());
  }

  // A linked series' next date, chosen on the picker once its list is
  // here. A series the list lacks (closed, or none open) leaves the
  // picker as it was.
  chooseSeries() {
    const lists = this.dates.lists;

    if (!this.wantedSeries || !lists) return;

    const first = lists.scheduled.find((c) => c.series === this.wantedSeries);

    this.wantedSeries = null;
    if (!first || this.method() !== "scheduled") return;
    this.dates.choose(first.value);
    this.draft.save(this.collect());
  }

  clearQuery(name) {
    if (!new URLSearchParams(location.search).has(name)) return;

    history.replaceState(null, "", `${location.pathname}${
      withoutParam(location.search, name)}${location.hash}`);
  }

  // /order/?add=SKU:qty,SKU:qty puts those items in the cart: the
  // "Add again" links on the account page, and anything else that
  // wants to. Unknown or sold-out SKUs are named, not added; a live
  // stock check right after brings any quantity down if it must. The
  // query is cleared so a reload does not add again.
  addFromQuery() {
    const params = new URLSearchParams(location.search);
    const raw = params.get("add");

    if (!raw) return;

    const added = [];
    const missing = [];
    let unknown = false;

    for (const part of raw.split(",")) {
      const [given, qtyText] = part.split(":");
      const sku = current(given || "", this.aliases);
      const input = qs(this.form, `[data-qty="${CSS.escape(sku || "")}"]`);
      const qty = Math.min(99, Math.max(1, parseInt(qtyText, 10) || 1));

      // A row out of stock is on the page to say when it is back, not
      // to be added (#267).
      if (!input || input.closest("[data-out]")) {
        const item = this.index.get(sku);

        // Named, never a raw SKU.
        if (item) missing.push(item.lineName);
        else unknown = true;
        continue;
      }
      this.setQty(input, Math.min(99, this.qty(input) + qty));
      added.push(`${qty} × ${this.index.get(sku).lineName}`);
    }

    const notice = document.getElementById("order-added");
    const bits = [];

    if (added.length) {
      bits.push(sentence(`Added to your cart: ${added.join(", ")}`));
    }
    if (missing.length) {
      bits.push(sentence(`Not available: ${missing.join(", ")}`));
    }
    // Draft wording.
    if (unknown) {
      bits.push("Some items from that order have changed. Please add " +
        "them again.");
    }
    notice.textContent = bits.join(" ");
    notice.hidden = !bits.length;
    notice.classList.toggle("alert-warning", !added.length);
    notice.classList.toggle("alert-success", added.length > 0);

    this.clearQuery("add");

    if (added.length) {
      this.draft.save(this.collect());
      setTimeout(() => this.cart.show({ smooth: true }), 300);
    }
  }

  // Stock changed under the cart: quantities were already brought into
  // line by Stock; say so, and let a submission in flight stop.
  stockMoved(notice) {
    this.moved = true;
    this.stockNotice.textContent = notice;
    this.stockNotice.hidden = false;
    this.stockNotice.scrollIntoView({ block: "nearest", behavior: "smooth" });
    this.changed();
  }


  // Quantity controls.

  qty(input) {
    const n = parseInt(String(input.value).replace(/\D/g, ""), 10);

    return Number.isFinite(n) ? Math.min(99, Math.max(0, n)) : 0;
  }

  // Both the property and the attribute, so CSS can see the state.
  setQty(input, n) {
    const value = String(n);

    input.value = value;
    input.setAttribute("value", value);
  }

  step(e) {
    const button = e.target.closest("[data-step]");

    if (!button) return;

    const box = button.closest(".order-qty");
    const input = qs(box, "[data-qty]");
    const was = this.qty(input);
    const max = Number(input.dataset.max) || 99;
    const next = Math.min(max, Math.max(0, was + Number(button.dataset.step)));

    this.setQty(input, next);
    pulse(input, "order-qty-tick");

    if (was === 0 && next > 0) {
      qs(box, ".order-qty-step [data-step='1']").focus();
    } else if (next === 0) {
      button.closest(".order-item").focus();
    }

    // The first item into an empty cart opens the pane on its own for
    // a restored draft; an Add has its own say (added() below).
    this.adding = next > was;
    this.changed();
    if (this.adding) {
      const item = this.index.get(input.dataset.qty);

      if (item) this.cart.added(input.dataset.qty, item.lineName);
    }
    this.adding = false;
  }


  method() {
    const checked = qs(this.form, "[name='method']:checked");

    return checked ? checked.value : "";
  }

  lines() {
    return all(this.form, "[data-qty]")
      .map((input) => ({ sku: input.dataset.qty, qty: this.qty(input) }))
      .filter((line) => line.qty > 0);
  }

  // Lines with their catalog entries, for rules that need the group.
  lineDetails() {
    return this.lines().map((line) => ({
      ...line, groupKey: this.index.get(line.sku).groupKey,
    }));
  }

  totals() {
    return computeTotals({
      lines: this.lines(),
      method: this.method(),
      index: this.index,
      money: this.money,
      group: this.group,
      code: this.code,
      lock: this.lock(),
      zipStatus: this.zipStatus(),
      waiveFee: !!this.pass && this.passFee,
    });
  }

  // Looks the typed code up by its hash. A known one becomes
  // `this.code` and shows in the totals; the joke starts its clock;
  // anything else is ignored by the server, and the cart's note says
  // so (cart.js codeResult).
  async applyCode({ quiet = false } = {}) {
    const typed = normalizeCode(this.cart.codeValue());
    const accepted = (text) => this.cart.codeResult({
      text, tone: "good", accepted: true,
    });

    this.cart.setCodeValue(typed);

    // Apply with the field empty takes the code off again, and a pass
    // with it; a change keeps the pass its order was placed with.
    if (!typed) {
      this.cart.stopJoke();
      this.code = null;
      if (!this.editing) {
        this.pass = null;
        this.passFee = false;
      }
      this.cart.codeResult();
      this.refresh();

      return;
    }

    if (typed === JOKE_CODE) {
      this.code = null;
      this.cart.startJoke();
      accepted("Code applied.");
      this.refresh();

      return;
    }

    const hash = await sha256(typed);
    const found = this.codes.find((c) => c.hash === hash);

    if (found) {
      this.cart.stopJoke();
      this.code = { code: typed, label: found.label, off: found.off };
      accepted(`Code applied: $${found.off} off.`);
      this.refresh();

      return;
    }

    // A buying group's code (#471): the server says what it unlocks.
    // Only its own shape, six characters or more, is worth a request.
    const member = this.editing || typed.length < 6
      ? { ok: false }
      : await this.applyGroup(typed);

    if (member.ok) {
      // Draft wording.
      accepted(`Applied: you can pick up at ${this.member.name}.`);
      this.refresh();

      return;
    }

    const pass = this.editing ? { ok: false } : await this.applyPass(typed);

    // James's wording (6333286808, and on #182 since): the minimum is
    // the live one from data/delivery.json; a code that waives the fee
    // says only "Applied.", as the fee cell already shows $0.
    if (pass.ok) {
      accepted(this.passFee ? "Applied."
        : "Applied: this order can be delivered under the " +
          `$${this.money.deliveryMinimum} minimum.`);
    } else if (!quiet) {
      // The code that was on stays on. Every code refused says only
      // this (James, on #182).
      this.cart.codeResult({ text: pass.message || "That code isn't valid." });
    }
    this.refresh();
  }

  // Asks the server whether a typed code is a pass (#182). Only the
  // pass shape, eight letters and digits, is worth a request.
  // -> { ok, message? }; an accepted one becomes `this.pass`.
  async applyPass(value) {
    const raw = String(value || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();

    if (raw.length !== 8) return { ok: false };

    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    // The submission's key: a pass it holds, after a declined card and
    // a reload, is still its own.
    const holder = encodeURIComponent(this.draft.key());
    const { ok, data } = await api(
      `/api/pass?code=${encodeURIComponent(code)}&holder=${holder}`
    ).catch(() => ({ ok: false, data: null }));

    if (ok) {
      this.pass = code;
      this.passFee = !!(data && data.waivesFee);
    }

    return { ok, message: data && data.message };
  }

  // Takes a pass the server refused off the order and says why by the
  // code box, as a code refused on Apply would.
  dropPass(message) {
    this.pass = null;
    this.passFee = false;
    this.cart.codeResult({ text: message });
    this.refresh();
  }

  // Asks the server what a buying group's code unlocks (#471), or,
  // with no code, what the signed-in account's group is. An accepted
  // answer unlocks the group. -> { ok, message? }.
  async applyGroup(code) {
    const { ok, data } = await api("/api/group", {
      method: "POST", body: code ? { code } : {},
    }).catch(() => ({ ok: false, data: null }));

    if (ok && data && data.group) this.unlockGroup(data, code || null);

    return { ok: !!(ok && data && data.group), message: data && data.message };
  }

  // The group's place and series join the model and its rounds the
  // pickup list, its lock prices the totals, and the order carries
  // the code (or, for a member signed in, nothing: the server knows).
  unlockGroup(data, code) {
    this.member = data.group;
    this.groupCode = code;
    this.terms = withPlaces(this.terms, this.raw, data.group);
    this.dates.addScheduled(data.dates || []);
    if (this.wantedOccurrence && this.dates.choose(this.wantedOccurrence)) {
      this.wantedOccurrence = null;
    }
    this.renderGroupDelivery();
    this.refresh();
    this.draft.save(this.collect());
  }

  // The member's price lock while it holds (#471): through its last
  // day, by the day the order is for, the day it is placed or, for a
  // change, was, as `money` chooses the prices in force. The server
  // works it out the same way, so the totals agree.
  lock() {
    if (!this.member || !this.member.lock) return null;

    const placed = this.editing && this.editing.placed;
    const day = today(placed ? new Date(placed) : this.dates.now(),
      this.terms.timeZone);

    return lockOn({ ...this.member.lock, through: this.member.lockThrough },
      day);
  }

  // The group's place as the page knows it once unlocked, or null.
  groupPlace() {
    return this.member
      ? this.terms.model.location(this.member.location) || null
      : null;
  }

  // A member may have a Thursday delivery left at the group's place
  // (#471): the choice shows once the group is unlocked, named for
  // it, and goes with the group.
  renderGroupDelivery() {
    const row = qs(this.form, "[data-deliver-to-group]");

    if (!row) return;

    row.hidden = !this.member;
    if (this.member) {
      qs(row, "[data-group-name]").textContent = this.member.name;
      // A restored draft's tick is filled now that the place is known.
      if (qs(row, "input").checked) this.fillGroupAddress();
    } else {
      qs(row, "input").checked = false;
      this.fillGroupAddress();
    }
  }

  // Ticked, the address fields take the place's and hold still; the
  // server fills them from the place again. Unticked, they are the
  // customer's to type.
  fillGroupAddress() {
    const box = qs(this.form, "[data-field='delivery.toGroup']");
    const place = this.groupPlace();
    const on = !!(box && box.checked && place);
    const fields = {
      "delivery.address1": place ? place.street : "",
      "delivery.address2": "",
      "delivery.town": place ? place.city : "",
      "delivery.zip": place ? place.zip : "",
    };

    for (const [key, text] of Object.entries(fields)) {
      const el = qs(this.form, `[data-field="${key}"]`);

      if (!el) continue;
      if (on) el.value = text;
      el.readOnly = on;
    }

    const cooler = qs(this.form, "[data-field='delivery.cooler']");

    // Draft wording.
    if (on && cooler && !cooler.value) {
      cooler.value = `The cooler at ${place.name}`;
    }
    this.refresh();
  }

  // A code the server refused at submission (replaced since the page
  // applied it): the group comes off, its pickup with it, and the
  // words go by the code box, as for a pass.
  dropGroup(message) {
    this.member = null;
    this.groupCode = null;
    this.terms = withPlaces(this.terms, this.raw);
    this.dates.dropExtra();
    this.renderGroupDelivery();
    this.cart.codeResult({ text: message });
    this.refresh();
    this.draft.save(this.collect());
  }

  // The money rules the page holds the order to: a pass lifts the
  // delivery minimum, and nothing else.
  rules() {
    return this.pass ? { ...this.money, deliveryMinimum: 0 } : this.money;
  }


  // The delivery ZIP's status, for the outside-area fee. Null unless
  // delivery is chosen, so the fee shows the moment it applies.
  zipStatus() {
    if (this.method() !== "delivery") return null;

    return zipInfo(
      qs(this.form, "[data-field='delivery.zip']").value, this.terms.area
    ).status;
  }

  eligible(totals) {
    return meetsMinimum(totals, this.rules());
  }

  // Everything derived from the current field values.

  refresh() {
    // First: an empty list unchooses scheduled pickup, and the rest
    // reads the way that leaves.
    this.renderScheduledCard();

    const method = this.method();
    const totals = this.totals();

    this.renderWindows();

    for (const input of all(this.form, "[data-qty]")) {
      const qty = this.qty(input);
      const box = input.closest(".order-qty");
      // A box being typed in stays open at 0 or blank: an empty box
      // hides its stepper, which would blur the box and lose what the
      // customer types after clearing it. Leaving it settles the state.
      const state = qty > 0 || input === this.typing ? "active" : "empty";

      if (box.dataset.qtyState !== state) box.dataset.qtyState = state;
      qs(box, "[data-step='-1']").setAttribute(
        "aria-label", qty === 1 ? "Remove" : "One fewer"
      );
    }

    for (const body of all(this.form, "[data-method-body]")) {
      body.toggleAttribute("inert", body.dataset.methodBody !== method);
    }

    // Delivery needs a phone for the driver; the rest can do without.
    const phone = qs(this.form, "[data-field='customer.phone']");

    phone.required = method === "delivery";
    qs(this.form, "[data-phone-optional]").hidden = method === "delivery";

    this.renderCart(totals, method);
    this.renderZipNote();
  }

  // What the cart shows, from the totals (lib/summary.mjs), and what
  // the form keeps for itself: the payment's amount, the submit
  // button's label, the header's count and the Delivery card's own
  // warning.
  renderCart(totals, method) {
    const lines = this.lines();
    const count = lines.reduce((n, line) => n + line.qty, 0);
    const s = summarize({
      totals, method, money: this.rules(), count, lines, index: this.index,
    });

    this.cart.render(s, {
      method,
      ways: {
        scheduled: !!this.dates.lists && this.dates.lists.scheduled.length > 0,
      },
      edit: this.editing ? { ...this.editing, total: totals.total } : null,
      locked: !!(this.stock && this.stock.locked),
      adding: !!this.adding,
    });
    this.total = totals.total;
    this.payment.setAmount(this.amount());
    this.submitLabel();
    this.renderEdit(totals.total);
    // The header's Order link shows the same count; a change to a paid
    // order is not the cart.
    if (!this.editing) announceCart(count);

    const short = qs(this.form, "[data-delivery-short]");

    if (short.textContent !== s.deliveryShort) {
      short.textContent = s.deliveryShort;
    }
    short.hidden = !s.deliveryShort;
  }

  // The scheduled pickup card from the list: its Where summarizes
  // every place once the list reaches more than the drop site (as
  // built, it reads as the drop site does; When is always "During
  // markets, pop-ups, and drops"); an empty list says so
  // and the card cannot be chosen; the lists not yet here leave it as
  // built.
  renderScheduledCard() {
    const lists = this.dates.lists;
    const radio = qs(this.form, "#method-scheduled");
    const facts = qs(this.form, "[data-scheduled-facts]");

    if (!lists || !radio || !facts) return;

    const choices = lists.scheduled;
    const none = !choices.length;
    const where = qs(facts, "[data-scheduled-where]");

    if (where.dataset.built === undefined) {
      where.dataset.built = where.textContent;
    }
    // Beyond one place, Where counts the locations and links to the
    // map in a new tab, so the order stays as it is (#places-scheduled
    // opens the plain Places list: the filter it once set is gone,
    // #214). The link is kept while its text and href hold, so a
    // focused one stays focused.
    const places = locationCount(choices);

    if (!none && places > 1) {
      const text = `${places} locations`;
      const href = facts.dataset.placesHref;
      const kept = where.firstElementChild;

      if (!kept || where.children.length !== 1 || kept.textContent !== text
        || kept.getAttribute("href") !== href) {
        const link = document.createElement("a");

        link.href = href;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = text;
        where.textContent = "";
        where.appendChild(link);
      }
    } else {
      where.textContent = none || dropOnly(choices, this.dropSeries)
        ? where.dataset.built : placesFact(choices);
    }
    facts.hidden = none;
    qs(this.form, "[data-scheduled-none]").hidden = !none;
    radio.disabled = none;
    if (none && radio.checked) qs(this.form, "#method-onfarm").checked = true;
    this.chooseSeries();
  }

  // The chosen pickup day's windows, one radio each, from the farm's
  // schedule (W11d). The time chosen carries over to a new day that
  // has it; otherwise the day's first is chosen.
  renderWindows() {
    const box = qs(this.form, "[data-windows]");
    const select = qs(this.form, "[data-dates='onfarm']");

    if (!box || !select) return;

    const lists = this.dates.lists;
    const day = lists && (lists.onfarm || [])
      .find((d) => d.date === select.value);
    const windows = day ? day.windows : [];
    const key = `${select.value} ${windows.map((w) => w.id).join(" ")}`;

    if (box.dataset.key === key && !this.wantedWindow) return;

    const checked = qs(box, "input:checked");
    const current = this.wantedWindow || (checked && checked.value);
    const pick = windows.some((w) => w.id === current) ? current
      : windows[0] && windows[0].id;

    box.dataset.key = key;
    box.textContent = "";
    if (!windows.length) {
      const none = document.createElement("p");

      none.className = "order-windows-none";
      none.textContent = lists ? "No pickup times on this day."
        : "Loading times…";
      box.appendChild(none);
    }
    for (const w of windows) {
      const node = document.getElementById("tpl-window").content
        .cloneNode(true);
      const input = qs(node, "input");
      const text = qs(node, "label");

      input.id = `onfarm-window-${w.id.replace(/\D/g, "")}`;
      input.value = w.id;
      input.checked = w.id === pick;
      text.htmlFor = input.id;
      text.textContent = w.label;
      box.appendChild(node);
    }
    if (lists) this.wantedWindow = null;
  }

  // The dialog's choice, put on the form; the customer pays again with
  // the same button (U1).
  useLapsed({ method, date, window }) {
    const select = qs(this.form, `[data-dates="${method}"]`);
    const status = document.querySelector("[data-lapsed-status]");
    const place = method === "scheduled" && this.pickupAt({ occurrence: date });

    if (method === "scheduled") this.dates.choose(date);
    else if (select) select.value = date;
    if (window) this.wantedWindow = window;
    this.refresh();
    this.errors.clear();
    this.draft.save(this.collect());

    const chosen = method === "scheduled" && this.dates.occurrence(date);
    const day = label(chosen ? chosen.date : date);
    const times = window && windowLabel(pickupTimes({ window }));

    if (status) {
      status.textContent = `${method === "onfarm"
        ? `Pickup is now ${day}, ${times}`
        : method === "scheduled" ? `Pickup is now ${day}, ${place}`
          : `Delivery is now ${day}`}. Pay to place your order.`;
      status.hidden = false;
    }

    const pay = [this.submitButton, this.saveButton]
      .find((button) => !button.hidden)
      || qs(document.getElementById("payment"), "legend");

    pay.focus();
  }

  // The dialog's other way: to the choice of ways, which the customer
  // makes themselves.
  otherWay(method) {
    const other = qs(this.form, `[name="method"]:not([value="${method}"])`);

    document.getElementById("pickup").scrollIntoView({ block: "start" });
    if (other) other.focus({ preventScroll: true });
  }

  // A 409: what was chosen lapsed. The fresh list goes on the form and
  // the dialog offers it (U1, U3).
  lapse(stored, dates) {
    const method = stored;
    const list = method === "scheduled" ? this.dates.scheduled(dates) : dates;

    this.dates.replace(method, dates);
    this.lapsed.open(method, list, this.submitButton.hidden ? null
      : this.submitButton);
  }

  revealMethod() {
    const body = qs(this.form, `[data-method-body="${this.method()}"]`);

    if (!body) return;

    setTimeout(() => {
      const field = qs(body, "select, input");

      if (field) {
        field.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }, 240);
  }


  renderZipNote() {
    const zip = qs(this.form, "[data-field='delivery.zip']");
    const note = qs(this.form, "[data-zip-note]");
    const info = zipInfo(zip.value, this.terms.area);
    const bad = disallowedFor(this.lineDetails(), info.state);

    note.classList.remove("text-danger-emphasis");

    if (info.status === "outside") {
      note.textContent = "That's outside our delivery area. On-farm pickup " +
        "and our pickup days are open to everyone.";
      note.classList.add("text-danger-emphasis");
    } else if (info.status === "unlisted") {
      note.textContent = "A little outside our usual area: delivery is " +
        `$${this.money.outsideAreaFee} more. If we can't get to your ` +
        "address, we'll call, text, or email you.";
    } else if (bad.length) {
      note.textContent = "We can only deliver " +
        `${info.state.onlyGroups.join(" and ")} to ${info.state.name} ` +
        "for now. Remove the chicken, or choose pickup.";
      note.classList.add("text-danger-emphasis");
    } else if (info.state && info.state.note) {
      note.textContent = info.state.note;
    } else {
      note.textContent = "";
    }
  }

  // The payload as the server expects it.

  collect() {
    const value = (key) => {
      const el = qs(this.form, `[data-field="${key}"]`);

      if (!el) return "";
      if (el.type === "checkbox") return el.checked;
      if (el.type === "radio" || el.getAttribute("role") === "radiogroup") {
        // A group drawn from the lists (the pickup times) may have no
        // radios yet.
        const first = el.getAttribute("name") ? el : qs(el, "input");
        const checked = first
          && qs(this.form, `[name="${first.name}"]:checked`);

        return checked ? checked.value : "";
      }

      return el.value;
    };
    const way = this.method();
    const dateSelect = qs(this.form, `[data-dates="${way}"]`);
    // Scheduled pickup stores its occurrence, which holds the date; the
    // picker's value is the occurrence id.
    const picked = way === "scheduled" ? this.dates.scheduledValue()
      : dateSelect ? dateSelect.value : "";

    return {
      formVersion: this.form.dataset.version,
      customer: {
        firstName: value("customer.firstName"),
        lastName: value("customer.lastName"),
        email: value("customer.email"),
        phone: value("customer.phone"),
        contact: value("customer.contact"),
        // A customer on the list is not shown the box (news/hide.js),
        // so a hidden one says nothing. Unticked never changes a
        // record that says yes (records.mjs) either way.
        marketing: !qs(this.form, "[data-farm-list-block]")?.hidden
          && value("customer.marketing") === true,
      },
      lines: this.lines(),
      fulfilment: {
        method: way,
        ...(way === "scheduled" ? { occurrence: picked } : { date: picked }),
        onfarm: {
          window: value("onfarm.window"),
        },
        delivery: {
          address1: value("delivery.address1"),
          address2: value("delivery.address2"),
          town: value("delivery.town"),
          zip: value("delivery.zip"),
          cooler: value("delivery.cooler"),
          notes: value("delivery.notes"),
          // A member's delivery to the group's place (#471).
          toGroup: value("delivery.toGroup") === true,
        },
      },
      code: this.code
        ? this.code.code
        : normalizeCode(qs(this.form, "[data-field='code']").value),
      pass: this.pass,
      // A buying group's code (#471), when one was typed or linked.
      groupCode: this.groupCode,
      claimedTotal: this.totals().total,
      website: qs(this.form, "[name='website']").value,
    };
  }

  // Empties the details and address on the form, as a scrub of the
  // draft did (#149), then fills in the signed-in customer's own.
  clearDetails({ prefill = true } = {}) {
    for (const el of all(this.form, DETAIL_FIELDS)) {
      if (!["checkbox", "radio"].includes(el.type)) el.value = "";
    }
    if (prefill) me().then((who) => this.signedIn(who)).catch(() => {});
  }

  // Brings the quantities to the saved draft's lines and leaves every
  // other field as it is: what another tab did to the cart, without
  // touching what is being typed here.
  syncLines() {
    const draft = this.draft.load();
    const lines = (draft && draft.payload && draft.payload.lines) || [];
    const wanted = new Map(
      lines.map((l) => [current(l.sku, this.aliases), l.qty])
    );
    let moved = false;

    for (const input of all(this.form, "[data-qty]")) {
      const qty = Math.min(99, Math.max(0, wanted.get(input.dataset.qty) || 0));

      if (input !== this.typing && this.qty(input) !== qty) {
        this.setQty(input, qty);
        moved = true;
      }
    }
    if (moved) this.refresh();
  }

  // Fills the form from the saved draft. `fresh` first empties the
  // cart, for a draft that replaced the one already shown.
  resume({ fresh = false } = {}) {
    const draft = this.draft.load();

    if (!draft || !draft.payload) return;
    if (fresh) {
      for (const input of all(this.form, "[data-qty]")) this.setQty(input, 0);
      // Details shown before go first (perhaps another account's, now
      // scrubbed), since restore() fills only what the draft holds.
      this.clearDetails({ prefill: false });
    }
    this.restore(draft.payload);
  }

  restore(payload) {
    if (!payload) return;

    const set = (key, v) => {
      const el = qs(this.form, `[data-field="${key}"]`);

      if (!el || v === undefined || v === null) return;
      if (el.type === "checkbox") {
        el.checked = !!v;
      } else if (el.type === "radio" || el.getAttribute("role")) {
        const name = el.getAttribute("name") || qs(el, "input").name;
        const radio = qs(this.form, `[name="${name}"][value="${v}"]`);

        if (radio) radio.checked = true;
      } else {
        el.value = v;
      }
    };
    const c = payload.customer || {};
    const f = payload.fulfilment || {};
    const o = f.onfarm || {};
    const d = f.delivery || {};

    set("customer.firstName", c.firstName);
    set("customer.lastName", c.lastName);
    set("customer.email", c.email);
    set("customer.phone", c.phone);
    this.formatPhone();
    set("customer.contact", c.contact);
    set("code", payload.code);
    // A saved draft's pass is asked about again: it may be gone.
    if (payload.pass && !this.editing) {
      this.applyPass(payload.pass).then(() => this.refresh());
    }
    // So is a buying group's code (#471): replaced since, it is gone,
    // and the pickup it unlocked with it.
    if (payload.groupCode && !this.editing) {
      this.applyGroup(payload.groupCode).catch(() => {});
    }

    for (const line of payload.lines || []) {
      // A saved cart may predate a rename; a paid order being changed
      // never does (its SKUs are all known, or it can't be changed).
      const sku = this.editing ? line.sku : current(line.sku, this.aliases);
      const input = qs(this.form, `[data-qty="${CSS.escape(sku)}"]`);

      if (input) this.setQty(input, line.qty);
    }

    // A draft saved before scheduled pickup holds `scituate`, which is
    // scheduled pickup at the drop site.
    const way = f.method === "scituate" ? "scheduled" : f.method;

    if (way) set("fulfilment.method", way);
    // The radios are drawn from the lists when they come.
    this.wantedWindow = o.window || null;

    for (const key of [
      "address1", "address2", "town", "zip", "cooler", "notes",
    ]) {
      set(`delivery.${key}`, d[key]);
    }
    // Filled from the group's place once the group is unlocked (#471).
    set("delivery.toGroup", d.toGroup === true);

    // Kept until the real list arrives; fill() honours it if the date
    // is still valid (#284).
    if (way === "scheduled") {
      this.dates.want(way, draftOccurrence(f, this.dropSeries),
        f.method === "scituate" ? this.dropSeries : "");
      // A round of a buying group is not in the lists until the group
      // is unlocked (#471); it is chosen then.
      this.wantedOccurrence = f.occurrence || null;
    } else if (way && f.date) {
      this.dates.want(way, f.date);
    }
    this.showContact();
  }

  // What the payment section asks of the form (pay.js).

  amount() {
    return this.editing
      ? Math.max(0, (this.total || 0) - this.editing.held + this.editing.kept)
      : this.total || 0;
  }

  referenceId() {
    return this.draft.key();
  }

  paymentReady() {
    this.submitButton.disabled = false;
    this.submitLabel();
  }

  // The customer's details for the card's verification, and the
  // delivery address when there is one.
  billing(payload) {
    const c = payload.customer;
    const d = payload.fulfilment.method === "delivery"
      ? payload.fulfilment.delivery
      : {};

    return {
      firstName: c.firstName, lastName: c.lastName, email: c.email,
      phone: c.phone,
      address1: d.address1 || "", address2: d.address2 || "",
      town: d.town || "", zip: d.zip || "",
      state: d.zip ? (zipInfo(d.zip, this.terms.area).state || {}).code : "",
    };
  }

  // Validates now and returns the payload the server expects, with
  // its key and attempt, or null after showing the errors. Nothing
  // asynchronous: a wallet must tokenise inside its click.
  check(payload) {
    return validateOrder(payload, {
      index: this.index, terms: this.terms, now: this.dates.now(),
      placed: this.editing && this.editing.placed,
      group: this.group, code: this.code, schedule: this.dates.schedule(),
      lock: this.lock(),
      deliverTo: this.groupPlace(),
      waive: { minimum: !!this.pass, fee: !!this.pass && this.passFee },
    });
  }

  // Once errors are showing, each change clears the ones it fixes and
  // rewords the ones it changes; leaving a field shows its own. Before
  // the first attempt nothing is said while the customer fills in.
  revalidate(left = null) {
    if (this.busy || !this.errors.showing()) return;

    const check = this.check(this.collect());

    this.errors.update(check.ok ? {} : check.errors, left);
    this.refresh();
  }

  prepare() {
    if (this.busy) return null;
    // No order is taken while stock is unknown (#333).
    if (this.stock.locked) {
      this.stock.warn();

      return null;
    }

    const payload = this.collect();
    const check = this.check(payload);
    const status = document.querySelector("[data-lapsed-status]");

    if (status) status.hidden = true;
    if (!check.ok) {
      // Only the day or time lapsed: the dialog. Before the lists have
      // come there is nothing to offer, so the errors say it.
      if (check.status === 409 && this.dates.lists) {
        this.lapse(payload.fulfilment.method, check.dates);

        return null;
      }
      if (check.dates && this.dates.lists) {
        this.dates.replace(payload.fulfilment.method, check.dates);
      }
      this.errors.show(check.errors);
      this.refresh();

      return null;
    }

    this.errors.clear();
    this.payment.clearError();
    payload.idempotencyKey = this.draft.key();
    payload.attempt = this.draft.attempt();
    this.draft.save(payload);

    return payload;
  }

  // The same with one last look at stock. If the cart had to change,
  // the customer sees why and decides again; nothing is sent.
  async prepareAsync() {
    // Pressed before the dates came: wait for them, rather than check
    // the order against no dates at all and send nothing (#284).
    if (!this.dates.lists) await this.dates.refresh();

    const payload = this.prepare();

    if (!payload) return null;

    // The farm may have dropped the time since the page loaded: ask
    // now, before a wallet or Venmo opens (UX's point 2). The server
    // checks again whatever happens here.
    if (await this.dates.refresh()) {
      const again = this.check(payload);

      if (!again.ok && again.status === 409) {
        this.lapse(payload.fulfilment.method, again.dates);

        return null;
      }
    }

    this.moved = false;
    // A last look at stock that fails shuts the page and stops the
    // order (#333).
    if (!await this.stock.refresh({ final: true })) {
      this.stock.warn();

      return null;
    }
    if (this.moved) return null;

    return payload;
  }

  // A wallet's token, or the card's: send it.
  pay(payload, source) {
    return this.deliver({ ...payload, payment: source });
  }

  // Venmo's two steps. The first answers with the PayPal order the
  // button pays; the second captures it and records the order. A draft
  // whose payment already went through (its answer was lost) gets the
  // paid order instead and no PayPal order: it is done, and the button
  // is told so with null, to stop without a word (#253).
  async venmoCreate(payload) {
    this.setBusy(true);

    const outcome = await this.submitter.send({
      ...payload, payment: { method: "venmo", stage: "create" },
    });

    this.setBusy(false);
    if (outcome.kind === "ok" && outcome.data && outcome.data.paypalOrderId) {
      this.draft.markAttempted();

      return outcome.data.paypalOrderId;
    }
    if (outcome.kind === "ok" && outcome.data && outcome.data.orderId) {
      this.paid(outcome.data, payload);

      return null;
    }

    this.settle(outcome, payload);
    throw new Error(outcome.message
      || "We couldn't start the Venmo payment.");
  }

  venmoCapture(payload, paypalOrderId) {
    return this.deliver({
      ...payload, payment: { method: "venmo", stage: "capture", paypalOrderId },
    });
  }

  // Submission and recovery.

  // The main button: the card form.
  // A second press while the first is still checking the dates and the
  // stock (before the button goes busy) is ignored: it would tokenize
  // and send again (#268, rec 7). The server would only dedupe it.
  async submit(e) {
    e.preventDefault();
    if (this.preparing) return;

    crumb("pay.press");

    this.preparing = true;

    let payload;

    try {
      payload = await this.prepareAsync();
    } finally {
      this.preparing = false;
    }

    if (!payload) return;
    // A change with nothing more to pay: no payment at all.
    if (this.editing && this.amount() <= 0) {
      await this.deliver(payload);

      return;
    }

    let source;

    // Busy from here to the answer, so the spinner runs unbroken.
    this.setBusy(true);
    try {
      source = await this.payment.tokenizeCard(payload);
    } catch (error) {
      this.setBusy(false);
      this.payment.fail(error.message);

      return;
    }
    await this.pay(payload, source);
  }

  // A send that can't get through goes once more, under the same keys,
  // so it can't pay twice. If that one can't either, it stops.
  async deliver(payload) {
    this.setBusy(true);
    this.draft.markAttempted();

    let outcome = await this.submitter.send(payload);

    if (outcome.kind === "retry") {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
      outcome = await this.submitter.send(payload);
    }

    this.setBusy(false);
    crumb(outcome.kind === "ok" ? "pay.ok" : "pay.failed");

    switch (outcome.kind) {
    case "ok":
      this.paid(outcome.data, payload);
      break;
    case "retry":
      // Draft wording.
      this.fail(payload, "We couldn't reach our payment system.");
      break;
    default:
      this.settle(outcome, payload);
    }
  }

  // The order is paid: the draft goes, and the page says so.
  paid(data, payload) {
    this.draft.clearPending();
    this.draft.clear();
    if (this.editing) {
      location.assign("/account/#orders");

      return;
    }
    announceCart(0);
    this.succeed(data, payload);
  }

  // Every answer but success and retry: the customer decides again.
  settle(outcome, payload) {
    switch (outcome.kind) {
    case "invalid":
      if (outcome.stock) {
        this.stock.items = outcome.stock;
        this.stock.apply();
      }
      // A code the server refused (#182): it comes off, the totals
      // follow, and the words go by the code box, not under a field.
      if (outcome.errors.pass) {
        this.dropPass(outcome.errors.pass);

        return;
      }
      // A buying group's code the server no longer knows (#471), the
      // same way.
      if (outcome.errors.groupCode) {
        this.dropGroup(outcome.errors.groupCode);

        return;
      }
      // The fields first: showing them clears every slot, the
      // payment's too, so the changed total is said after (#302).
      this.errors.show(outcome.errors);
      if (outcome.errors.total) {
        this.refresh();
        this.payment.fail(outcome.errors.total);
      }
      break;
    case "stale":
      this.lapse(payload.fulfilment.method, outcome.dates);
      break;
    case "declined":
      // The next try is a new attempt: fresh keys for the processor.
      this.draft.nextAttempt();
      this.payment.fail(outcome.message);
      break;
    case "checkout":
      this.draft.nextAttempt();
      this.payment.fail(outcome.message);
      break;
    case "busy":
      this.payment.fail(outcome.message);
      break;
    default:
      this.fail(payload, outcome.message);
    }
  }

  // While an order is sent, the button that sent it spins its egg. A
  // wallet or Venmo has no button of ours on show, so the notice says
  // it instead. The busy flag and the form's pointer-events stop a
  // second press; the button is not disabled, which would dim it.
  setBusy(busy) {
    const shown = [this.submitButton, this.saveButton]
      .find((button) => !button.hidden);

    this.busy = busy;
    this.form.classList.toggle("order-busy", busy);
    this.submitButton.disabled = !busy && !this.payment.ready;
    for (const button of [this.submitButton, this.saveButton]) {
      spin(button, busy && button === shown);
    }
    if (busy && !shown) {
      this.pending.sending();
    } else {
      this.pending.hide();
    }
  }

  // The cart says the total; the button says what it does.
  submitLabel() {
    qs(this.submitButton, ".busy-button-idle").textContent = this.editing
      // Draft wording.
      ? `Pay ${dollars(this.amount())} and save`
      : "Place your order";
  }

  // One line saying when and where, the sentence people screenshot.
  when(fulfilment) {
    const f = fulfilment;
    const date = fulfilmentDate(f, (id) => this.dates.occurrence(id));
    const day = date ? label(date) : "";

    if (f.method === "delivery" && f.delivery) {
      return `${day}, delivered to ${f.delivery.address1}.`;
    }
    if (f.method === "scituate" || f.method === "scheduled") {
      return `${day}, ${this.pickupAt(f)}.`;
    }
    if (f.method === "onfarm" && f.onfarm) {
      const times = pickupTimes(f.onfarm);

      return `${day}, ${times ? windowLabel(times) : ""}, at the farm.`;
    }

    return day;
  }

  // "10:00 – 11:00 AM, at the drop site" or "9:00 AM – 1:00 PM, at
  // Foster Farmers Market": the occurrence's own hours and name, from
  // the lists (one that has since left them is still remembered). A
  // draft saved before scheduled pickup (`scituate`) reads as the drop
  // site's did; an occurrence the page cannot name, as "the pickup you
  // chose".
  pickupAt(f) {
    if (f.method === "scituate") {
      return `${this.drop.window}, at the drop site`;
    }

    const entry = this.dates.occurrence(f.occurrence);

    if (!entry) return "at the pickup you chose";

    const place = entry.series === this.dropSeries
      ? "the drop site" : entry.name;

    return `${entry.window}, at ${place}`;
  }

  summaryText(payload) {
    const totals = this.totals();
    const lines = payload.lines.map((line) => {
      const item = this.index.get(line.sku);

      return `${line.qty} × ${item.groupLabel}, ${item.label} ` +
        `(${dollars(line.qty * toCents(item.price))})`;
    });

    return [
      `${payload.customer.firstName} ${payload.customer.lastName} ` +
        `<${payload.customer.email}>`,
      this.when(payload.fulfilment),
      ...lines,
      `Total ${dollars(totals.total)}`,
    ].join("\n");
  }

  finish(node) {
    this.pending.hide();
    this.result.textContent = "";
    this.result.appendChild(node);
    this.result.hidden = false;
    this.result.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  succeed(data, payload) {
    const node = document.getElementById("order-success").content
      .cloneNode(true);
    const fill = (name, text) => {
      const el = qs(node, `[data-out="${name}"]`);

      if (el) el.textContent = text;
    };

    if (data) {
      fill("name", data.customer.firstName || data.customer.name);
      fill("email", data.customer.email);
      fill("total", dollars(data.totals.total));
      fill("orderId", data.orderId);
      fill("how", this.paidWith(data.payment));
      fill("when", this.when(data.fulfilment));

      const account = qs(node, "[data-out='account']");

      if (account) account.hidden = this.isSignedIn;

      const receipt = qs(node, "[data-out='receiptUrl']");

      if (data.payment && data.payment.receiptUrl) {
        receipt.href = data.payment.receiptUrl;
      } else {
        receipt.parentElement.hidden = true;
      }
    } else {
      // Dropped silently by the server: show nothing that could be
      // used to probe the filter, just a plain thank-you.
      fill("name", payload.customer.firstName);
      qs(node, "[data-out='details']").hidden = true;
    }

    this.form.hidden = true;
    this.finish(node);
  }

  // "Visa ending 4242", "Apple Pay", "Venmo".
  paidWith(payment) {
    const p = payment || {};
    const wallets = {
      applepay: "Apple Pay", googlepay: "Google Pay", cashapp: "Cash App Pay",
      venmo: "Venmo",
    };

    if (wallets[p.method]) return wallets[p.method];

    const brand = String(p.brand || "card").toLowerCase()
      .replace(/_/g, " ")
      .replace(/\b\w/g, (ch) => ch.toUpperCase());

    return p.last4 ? `${brand} ending ${p.last4}` : brand;
  }

  fail(payload, message) {
    const node = document.getElementById("order-failed").content
      .cloneNode(true);
    const text = this.summaryText(payload);
    const mail = qs(node, "[data-out='mailto']");
    const phone = qs(node, "[data-out='phone']");
    const copy = qs(node, "[data-out='copy']");

    qs(node, "[data-out='message']").textContent = message;
    qs(node, "[data-out='summary']").textContent = text;
    // The farm's own address and number, from the page's data; only a
    // plain address or number becomes a link.
    if (/^[^\s@?&#:/]+@[^\s@?&#:/]+$/.test(this.contact.email)) {
      mail.href = `mailto:${encodeURIComponent(this.contact.email)}` +
        `?subject=` +
        `${encodeURIComponent("Order from the website")}&body=` +
        `${encodeURIComponent(text)}`;
    }
    mail.textContent = this.contact.email;
    if (/^\+?\d+$/.test(this.contact.phone.plain)) {
      phone.href = `tel:${this.contact.phone.plain}`;
    }
    phone.textContent = this.contact.phone.display;

    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = "Copied";
        setTimeout(() => { copy.textContent = "Copy summary"; }, 2000);
      } catch {
        copy.textContent = "Select the text above to copy it";
      }
    });

    // The key, never the payload: it holds the customer's details, and
    // the console is read by whoever sits down at the machine (#258).
    console.error(JSON.stringify({
      event: "order.undeliverable",
      idempotencyKey: payload && payload.meta && payload.meta.idempotencyKey,
    }));
    // Tell the farm a checkout could not complete. A beacon survives
    // the page being closed; nothing here can fail the customer.
    try {
      const beacon = JSON.stringify({
        kind: "checkout.failed",
        message,
        method: payload.fulfilment && payload.fulfilment.method,
        page: location.pathname,
      });

      if (!navigator.sendBeacon || !navigator.sendBeacon("/api/health",
        new Blob([beacon], { type: "application/json" }))) {
        fetch("/api/health", {
          method: "POST", body: beacon, keepalive: true,
          headers: { "Content-Type": "application/json" },
        }).catch(() => {});
      }
    } catch {
      // The failure itself is already on screen.
    }
    this.finish(node);
  }
}
