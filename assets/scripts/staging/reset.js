// "Reset to a first visit": leaves this browser as a stranger's first
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
//   session cookie scripts cannot touch.
//
// What stays is the toolbar's own state (STAY), or the toolbar would
// close. Filters and form values live in the page and
// the address, so the reload that follows drops them.

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

export const forgetEverything = async ({
  local = () => window.localStorage, session = () => window.sessionStorage,
  jar = document, signOut = () => fetch("/api/auth/signout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }),
} = {}) => {
  try {
    await signOut();
  } catch {
    // Offline, or already signed out: the cookies go below anyway.
  }
  wipe(local);
  wipe(session);
  expire(jar);
};
