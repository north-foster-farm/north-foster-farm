// What the order page embeds, read once at load
// (docs/refactors/order-form.md, phase 5). Pure: the root reads
// #order-data and the address, and keeps what these give as its page
// data, fixed after load.

import { indexCatalog } from "../lib/catalog.mjs";
import { buildModel } from "../lib/events.mjs";
import { dropSeriesCode } from "../lib/scheduled.mjs";

// #order-data's JSON (layouts/partials/order/form.html), as the form
// keeps it.
export const pageData = (data) => {
  // The scheduled pickups the page validates against, built as the
  // functions build them (lib/events.mjs).
  const terms = {
    ...data.terms, model: buildModel(data.locations, data.series),
  };
  // The drop site's series code (data/series.json), for the old
  // ?method=scituate link and a draft saved before scheduled pickup.
  const dropSeries = dropSeriesCode(terms.model);

  return {
    catalog: data.catalog,
    aliases: data.aliases || {},
    index: indexCatalog(data.catalog),
    terms,
    dropSeries,
    drop: terms.model.series.find((s) => s.code === dropSeries) || {},
    contact: data.contact,
    // Discount codes, by hash; the plain codes stay on the server.
    codes: data.codes || [],
    // The page embeds nothing of a group, so its places are folded
    // into the model from the answer (`raw` is what the page embeds).
    raw: { locations: data.locations, series: data.series },
  };
};

// /order/?edit=<id> changes a paid order: the id from the address's
// query (`search`), or null.
export const editIdFrom = (search) => {
  const edit = new URLSearchParams(search).get("edit") || "";

  return /^[A-Za-z0-9-]{1,32}$/.test(edit) ? edit : null;
};
