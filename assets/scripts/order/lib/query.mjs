// What a link to /order/ asks of the page, read from its query string.

// ?method=onfarm (or scheduled, delivery): the way to choose, when it
// is one of `methods`, the form's own values. `?method=scituate`, a
// link published before scheduled pickup, reads as scheduled pickup at
// the drop site: its `series` is `dropSeries`. `&series=<code>` names
// the series, and only scheduled pickup has one. Anything else is
// null: { method, series } with `series` null when none is named.
export const linkedMethod = (search, methods, dropSeries = null) => {
  const params = new URLSearchParams(search);
  const value = params.get("method");
  const method = value === "scituate" ? "scheduled" : value;

  if (!methods.includes(method)) return null;

  if (method !== "scheduled") return { method, series: null };

  const series = value === "scituate" ? dropSeries : params.get("series");

  return { method, series: series || null };
};

// The query string with `name` taken out, "" when nothing is left.
export const withoutParam = (search, name) => {
  const params = new URLSearchParams(search);

  params.delete(name);

  return params.toString() ? `?${params}` : "";
};
