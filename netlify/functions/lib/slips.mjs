// Every kind of page the morning packing packet can hold, each built
// from fixed fake orders with the real packet code, for the staging
// toolbar's Packing slips section (#334). Nothing here reads a record,
// sends mail or stores anything.
//
// An entry: { id, name, note }; `build(id, env)` -> the PDF's bytes.

import {
  dropSite, order, pickup, samplePacket,
} from "./library.mjs";
import { packetPdf } from "./packing.mjs";

const AT = "2026-10-06T13:00:00.000Z";
const NOW = new Date("2026-10-06T10:00:00.000Z");
const card = order().payments[0];

const fresh = (o) => ({ order: o, kind: "new", changes: [] });
const of = (kind) => samplePacket().entries.find((e) => e.kind === kind);

const PAGES = [
  {
    id: "cover", name: "Cover sheet",
    note: "The pick list and what is in the packet.",
    entries: () => samplePacket().entries, cover: "only",
  },
  {
    id: "card", name: "Slip: paid by card",
    note: "A delivery, paid in full by Visa.",
    entries: () => [fresh(order())],
  },
  {
    id: "venmo", name: "Slip: paid by Venmo",
    note: "A drop-site order, paid in full through PayPal's Venmo.",
    entries: () => [fresh(dropSite())],
  },
  {
    id: "wallet", name: "Slip: paid by a wallet",
    note: "A pickup, paid in full with Apple Pay.",
    entries: () => [fresh(pickup())],
  },
  {
    id: "part", name: "Slip: part-paid",
    note: "A delivery partly paid, the rest due.",
    entries: () => [fresh(order({ payments: [{ ...card, amount: 4000 }] }))],
  },
  {
    id: "refunded", name: "Slip: refunded",
    note: "Paid in full, then partly refunded by the farm.",
    entries: () => [fresh(order({
      refunds: [{
        id: "RF-1", amount: 1000, status: "COMPLETED", at: AT,
        via: "square",
      }],
    }))],
  },
  {
    id: "unpaid-pickup", name: "Slip: unpaid pickup",
    note: "An older order still owing, to be paid at pickup (cash first).",
    entries: () => [fresh(pickup({ status: "submitted", payments: [] }))],
  },
  {
    id: "unpaid-delivery", name: "Slip: unpaid delivery",
    note: "An older order still owing, to be paid at delivery.",
    entries: () => [fresh(order({ status: "submitted", payments: [] }))],
  },
  {
    id: "revision", name: "Revision sheet and its new slip",
    note: "An order changed since its slip printed.",
    entries: () => [of("changed")],
  },
  {
    id: "cancelled", name: "Canceled sheet",
    note: "An order canceled since its slip printed. No slip follows.",
    entries: () => [of("cancelled")],
  },
];

export const pages = () => PAGES.map(({ id, name, note }) => ({
  id, name, note,
}));

export const has = (id) => PAGES.some((p) => p.id === id);

// -> the PDF as a Buffer, or null for an id with no page.
export const build = (id, env = process.env) => {
  const page = PAGES.find((p) => p.id === id);

  if (!page) return null;

  return packetPdf({
    entries: page.entries(), now: NOW, title: page.name, env,
    cover: page.cover || false,
  });
};
