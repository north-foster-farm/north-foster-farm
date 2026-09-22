// Where the site lives, for links in email. Netlify sets URL to the
// primary site address and DEPLOY_PRIME_URL to the address of the
// build being run; a preview links to itself so its sign-in links
// resolve. SITE_URL overrides both.

export const siteUrl = (env = process.env) => {
  const raw = env.SITE_URL || env.DEPLOY_PRIME_URL || env.URL
    || "http://localhost:8888";

  return raw.replace(/\/+$/, "");
};

// The account pages exist only when the site is built with them
// (params.features.accounts in Hugo); ACCOUNTS_ENABLED=true says so
// to the functions, and until then no email links to them.
export const accountUrlFor = (env = process.env) =>
  (env.ACCOUNTS_ENABLED === "true" ? `${siteUrl(env)}/account/` : null);

// One order on the account pages, for the emails that are about that
// order. Null until accounts are on, like accountUrlFor. The path is
// served by the account page through a rewrite in netlify.toml; the
// session says whose order it is, so nothing but the id is in it.
// The account page's settings tab, where a customer turns the payment
// reminders off. Null until accounts are on.
export const settingsUrlFor = (env) =>
  (env.ACCOUNTS_ENABLED === "true"
    ? `${siteUrl(env)}/account/#settings`
    : null);

export const orderPathFor = (id) =>
  `/account/orders/${encodeURIComponent(id)}/`;

export const orderUrlFor = (env, id) =>
  (env.ACCOUNTS_ENABLED === "true"
    ? `${siteUrl(env)}${orderPathFor(id)}`
    : null);

// The links every email ends on. `orders` is null until accounts are
// on; `admin` is the dashboard (ADMIN_URL, default the farm's) and
// the farm's notices build their order and customer links under it;
// `order` is the order form; `contact` falls back to the farm's
// mailbox inside the templates when unset.
export const mailLinks = (env = process.env) => ({
  site: siteUrl(env),
  orders: accountUrlFor(env),
  contact: env.CONTACT_URL || null,
  admin: (env.ADMIN_URL || "https://admin.northfosterfarm.com")
    .replace(/\/+$/, ""),
  order: `${siteUrl(env)}/order/`,
});
