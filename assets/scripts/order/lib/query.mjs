// What a link to /order/ asks of the page, read from its query string.

// ?method=onfarm (or scituate, delivery): the way to choose, when it
// is one of `methods`, the form's own values. Anything else is null.
export const linkedMethod = (search, methods) => {
  const value = new URLSearchParams(search).get("method");

  return methods.includes(value) ? value : null;
};

// The query string with `name` taken out, "" when nothing is left.
export const withoutParam = (search, name) => {
  const params = new URLSearchParams(search);

  params.delete(name);

  return params.toString() ? `?${params}` : "";
};
