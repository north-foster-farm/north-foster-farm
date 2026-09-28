// A signed-in customer's cart follows them across devices (#149). The
// order draft is kept in the browser as ever; a copy is kept on the
// account too, and whichever was saved last wins. A cleared cart (an
// order placed) is kept as a copy with no payload, so an older cart on
// another device is cleared too rather than coming back. Shared by
// the browser (session/cart-sync.js) and the account API.

const MAX_LINES = 200;

const text = (value, max = 200) =>
  typeof value === "string" ? value.slice(0, max) : "";

const obj = (value) => (value && typeof value === "object" ? value : {});

// -> the part of a draft's payload worth carrying to another device:
// the customer's details, the cart, the way and the code. A payment
// attempt's keys and the claimed total stay with the device.
export const cartOf = (payload) => {
  const p = obj(payload);
  const c = obj(p.customer);
  const f = obj(p.fulfilment);
  const d = obj(f.delivery);
  const lines = (Array.isArray(p.lines) ? p.lines : [])
    .map((l) => ({
      sku: text(obj(l).sku, 40),
      qty: Math.min(99, Math.max(0, Math.floor(Number(obj(l).qty) || 0))),
    }))
    .filter((l) => l.sku && l.qty > 0)
    .slice(0, MAX_LINES);

  return {
    formVersion: text(p.formVersion, 20),
    customer: {
      firstName: text(c.firstName, 60),
      lastName: text(c.lastName, 60),
      email: text(c.email, 254),
      phone: text(c.phone, 40),
      contact: text(c.contact, 20),
      marketing: c.marketing === true,
    },
    lines,
    fulfilment: {
      method: text(f.method, 20),
      date: text(f.date, 10),
      onfarm: { window: text(obj(f.onfarm).window, 20) },
      delivery: {
        address1: text(d.address1),
        address2: text(d.address2),
        town: text(d.town, 100),
        zip: text(d.zip, 10),
        cooler: text(d.cooler, 300),
        notes: text(d.notes, 1000),
      },
    },
    code: text(p.code, 40),
  };
};

// Which copy wins. `local` is the browser's draft ({ payload, savedAt }
// or null); `remote` is the account's ({ payload | null, savedAt } or
// null when it has never had one). -> "remote" to take the account's
// copy, "local" to send this one up, or null when they agree.
export const settle = (local, remote) => {
  const mine = local && local.payload ? Number(local.savedAt) || 0 : 0;
  const theirs = remote ? Number(remote.savedAt) || 0 : 0;

  // Signing in carries a guest's cart into an account that has none.
  if (!remote) return local && local.payload ? "local" : null;
  if (theirs > mine) return "remote";
  if (mine > theirs) return "local";

  return null;
};
