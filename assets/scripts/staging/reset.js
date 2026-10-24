// "Reset to first visit": leaves this browser as a stranger's first
// load of the site would find it. It clears everything the site keeps
// here, without a list of keys to fall behind the site:
//
// - localStorage and sessionStorage, whole: the cart and its draft, a
//   submission not yet delivered, an order's edit draft, the dismissed
//   delivery note, the remembered Venmo buyer, the farm news "joined"
//   flag (nff-news), the video preference (nff:autoplay), the sign-in
//   cache (nff-me) and whatever is added later;
// - every cookie a script can reach, among them the nff_signed_in
//   stamp;
// - the sign-in itself, ended on the server, which also clears the
//   session cookie scripts cannot touch;
// - this gate session's emails, emptied on the server: the gate
//   session stays, and the emails are filed under it;
// - the page's form fields, reset, so the reload does not restore them.
//
// What stays is the toolbar's own state (STAY), or the toolbar would
// close, and the gate session, or the reset would lock its user out.

export const STAY = ["staging.open"];

// `bag` is a function: even reading window.localStorage can throw.
const wipe = (bag) => {
  try {
    bag = bag();

    const keep = new Map(STAY.map((k) => [k, bag.getItem(k)]));

    bag.clear();
    for (const [k, v] of keep) if (v !== null) bag.setItem(k, v);
  } catch {
    // Storage may be blocked; nothing was kept there.
  }
};

// A cookie is removed by expiring it on the path and host that set it:
// the site sets them on "/", with no Domain.
const expire = (jar) => {
  const names = String(jar.cookie || "").split(";")
    .map((c) => c.split("=")[0].trim()).filter(Boolean);

  for (const name of names) {
    jar.cookie = `${name}=; Path=/; Max-Age=0`;
  }
};

// A reload puts back what the browser remembers of the page's form
// fields, quantity boxes among them, and the order form builds the cart
// again from them. Resetting each form first leaves nothing to restore.
const resetForms = (forms) => {
  try {
    for (const form of Array.from(forms())) form.reset();
  } catch {
    // No forms to reset.
  }
};

// Cache Storage and IndexedDB, which the two storages above do not
// cover. Nothing in the site uses either today; a script that starts
// to will be cleared with no change here.
const dropStores = async () => {
  try {
    for (const key of await window.caches.keys()) {
      await window.caches.delete(key);
    }
    for (const db of await window.indexedDB.databases()) {
      window.indexedDB.deleteDatabase(db.name);
    }
  } catch {
    // Not offered here, or blocked.
  }
};

// A request the server must answer well: fetch does not throw on a 403
// or a 503, so a refused sign-out would look like a done one.
const ask = async (path, method, body) => {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body,
  });

  if (!res.ok) throw new Error(`${method} ${path}: ${res.status}`);
};

// What the toolbar says when the server left a step undone, every such
// step named; "" when it did them all.
export const unfinished = ({ signedOut, mailCleared }) => {
  const missed = [];

  if (!signedOut) missed.push("end the sign-in");
  if (!mailCleared) missed.push("empty this session's emails");

  return missed.length
    ? `The browser is reset, but the server did not ${missed.join(" or ")}.`
    : "";
};

// -> { signedOut, mailCleared }: whether the server ended the sign-in
// and emptied this gate session's emails. The browser is cleared
// either way; the caller says what the server did not do.
export const forgetEverything = async ({
  local = () => window.localStorage, session = () => window.sessionStorage,
  jar = document, forms = () => document.forms,
  signOut = () => ask("/api/auth/signout", "POST", "{}"),
  // "this session's emails" are kept by the gate session, which the
  // reset keeps, so only the server can empty them.
  clearMail = () => ask("/api/staging/outbox", "DELETE"),
} = {}) => {
  const done = { signedOut: true, mailCleared: true };

  try {
    await signOut();
  } catch {
    done.signedOut = false;
  }
  try {
    await clearMail();
  } catch {
    done.mailCleared = false;
  }
  resetForms(forms);
  wipe(local);
  wipe(session);
  expire(jar);
  await dropStores();

  return done;
};
