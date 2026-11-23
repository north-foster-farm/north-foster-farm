// How long Netlify's edge may keep an answer, read off the headers it
// honors: Netlify-CDN-Cache-Control or CDN-Cache-Control (max-age or
// s-maxage), else Cache-Control's s-maxage. 0 when it may not keep it.
// For #908's tests of /api/stock.

const age = (value, keys) => {
  if (!value || /no-store|private/i.test(value)) return 0;

  for (const key of keys) {
    const m = value.match(new RegExp(`(?:^|[,\\s])${key}=(\\d+)`, "i"));

    if (m) return Number(m[1]);
  }

  return 0;
};

export const edgeSeconds = (headers) => Math.max(
  age(headers.get("netlify-cdn-cache-control"), ["s-maxage", "max-age"]),
  age(headers.get("cdn-cache-control"), ["s-maxage", "max-age"]),
  age(headers.get("cache-control"), ["s-maxage"]),
);
