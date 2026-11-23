// Links into the order page (docs/refactors/order-form.md, phase 3):
// ?method= and ?series= choose a way, ?add= puts items in the cart and
// ?group= brings a buying group's code. Each is read once, at start,
// and cleared from the address.

import { current } from "../lib/catalog.mjs";
import { groupFromQuery } from "../lib/group.mjs";
import { linkedMethod, withoutParam } from "../lib/query.mjs";
import { addNotice, parseAdd } from "./add-query.mjs";
import { all, qs } from "./dom.js";

// Takes `name` out of the address, if it is there.
const clearQuery = (name) => {
  if (!new URLSearchParams(location.search).has(name)) return;

  history.replaceState(null, "", `${location.pathname}${
    withoutParam(location.search, name)}${location.hash}`);
};

export class Links {
  // `page` is the OrderForm: its form, catalog index and aliases, the
  // date lists, the draft and the cart, and its way(), collect(),
  // qty() and setQty(). `afterStock` resolves once stock has answered.
  constructor(page, { afterStock }) {
    this.page = page;
    this.afterStock = afterStock;
    // A linked series waiting for its date list (chooseSeries).
    this.wantedSeries = null;
  }

  // /order/?method=onfarm (or scheduled, delivery) chooses that way, as
  // a click on its card would: the home page's off-season band and the
  // map's pin cards. ?method=scheduled&series=<code> also chooses that
  // series' next date once the lists come, and the old
  // ?method=scituate the drop site series'. The link wins over a
  // restored draft's way. An unknown value is ignored. The query is
  // cleared, as ?add= is.
  methodFromQuery() {
    const page = this.page;
    // Group orders is no link's to choose: it is a member's alone.
    const radios = all(page.form, "[name='method']")
      .filter((radio) => radio.value !== "group");
    const link = linkedMethod(
      location.search, radios.map((radio) => radio.value), page.dropSeries
    );

    clearQuery("method");
    clearQuery("series");
    if (!link) return;

    this.wantedSeries = link.series;
    if (link.method === page.way()) {
      this.chooseSeries();

      return;
    }

    radios.find((radio) => radio.value === link.method).checked = true;
    page.draft.save(page.collect());
  }

  // A linked series' next date, chosen on the picker once its list is
  // here. A series the list lacks (closed, or none open) leaves the
  // picker as it was.
  chooseSeries() {
    const page = this.page;
    const lists = page.dates.lists;

    if (!this.wantedSeries || !lists) return;

    const first = lists.scheduled.find((c) => c.series === this.wantedSeries);

    this.wantedSeries = null;
    if (!first || page.way() !== "scheduled") return;
    page.dates.choose(first.value);
    page.draft.save(page.collect());
  }

  // /order/?add=SKU:qty,SKU:qty puts those items in the cart: the
  // "Add again" links on the account page, and anything else that
  // wants to. Unknown or sold-out SKUs are named, not added; a live
  // stock check right after brings any quantity down if it must. The
  // query is cleared so a reload does not add again.
  addFromQuery() {
    const page = this.page;
    const raw = new URLSearchParams(location.search).get("add");

    if (!raw) return;

    const result = this.addLines(parseAdd(raw));

    this.showNotice(addNotice(result));
    clearQuery("add");

    if (result.added.length) {
      page.draft.save(page.collect());
      this.afterStock(page.stock).then(() => page.cart.show({ smooth: true }));
    }
  }

  // Each line into its row: what was added, what is not available by
  // name, and the SKUs the catalog does not know.
  addLines(lines) {
    const page = this.page;
    const result = { added: [], missing: [], unknown: [] };

    for (const { sku: given, qty } of lines) {
      const sku = current(given, page.aliases);
      const input = qs(page.form, `[data-qty="${CSS.escape(sku || "")}"]`);

      // A row out of stock is on the page to say when it is back, not
      // to be added (#267).
      if (!input || input.closest("[data-out]")) {
        this.notAdded(result, sku, given);
        continue;
      }
      page.setQty(input, Math.min(99, page.qty(input) + qty));
      result.added.push({ qty, name: page.index.get(sku).lineName });
    }

    return result;
  }

  // A line not added: a product the catalog knows is named, never a
  // raw SKU; one it does not know is only counted.
  notAdded(result, sku, given) {
    const item = this.page.index.get(sku);

    if (item) result.missing.push(item.lineName);
    else result.unknown.push(given);
  }

  showNotice({ text, tone, hidden }) {
    const notice = document.getElementById("order-added");

    notice.textContent = text;
    notice.hidden = hidden;
    notice.classList.toggle("alert-warning", tone === "warning");
    notice.classList.toggle("alert-success", tone === "success");
  }

  // /order/?group=<code>: a buying group's link (#471) puts its code
  // in the box, and the form's applyCode tries it as a typed one
  // would be. Whether a code came by the link.
  groupFromLink() {
    const linked = groupFromQuery(location.search);

    clearQuery("group");
    if (linked) this.page.cart.setCodeValue(linked);

    return !!linked;
  }
}
