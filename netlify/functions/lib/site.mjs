// Where the site lives, for links in email. Netlify sets URL to the
// primary site address and DEPLOY_PRIME_URL to the address of the
// build being run; a preview links to itself so its sign-in links
// resolve. SITE_URL overrides both.

export const siteUrl = (env = process.env) => {
  const raw = env.SITE_URL || env.DEPLOY_PRIME_URL || env.URL
    || "http://localhost:8888";

  return raw.replace(/\/+$/, "");
};

export const accountUrlFor = (env = process.env) =>
  `${siteUrl(env)}/account/`;

export const orderUrlFor = (env, id) =>
  `${siteUrl(env)}/account/orders/#${encodeURIComponent(id)}`;
