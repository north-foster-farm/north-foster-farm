// The order an email's link names (#924). netlify.toml sends
// /account/orders/<id>/ on to /account/?order=<id>/, so the page is
// served at its own depth; where no rule runs (a preview, a local
// server) the id is still read off the path. -> the id, or "".
const PATH = /^\/account\/orders\/([^/]+)\/?$/;

export const orderFromLink = ({ pathname, search }) => {
  const query = new URLSearchParams(search).get("order");

  // An id holds no slash: what follows one is the splat's trailing
  // slash, or a query a redirect joined badly.
  if (query) return query.split("/")[0];

  const found = PATH.exec(pathname);

  return found ? decodeURIComponent(found[1]) : "";
};
