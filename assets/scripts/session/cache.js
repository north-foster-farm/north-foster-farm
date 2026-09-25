// When a cached /api/me answer still counts. The server sets a stamp
// cookie, nff_signed_in, at each sign-in and clears it at sign-out
// (netlify/functions/lib/auth.mjs); an answer counts only under the
// stamp it was fetched with, and for five minutes at most.

export const TTL = 5 * 60_000;

// -> the stamp in a cookie string, or "" when there is none.
export const stampFrom = (cookies) => {
  const match = String(cookies || "").match(/(?:^|;\s*)nff_signed_in=([^;]*)/);

  return match ? match[1] : "";
};

// -> the cached answer if it is fresh under this stamp, else null.
export const fresh = (cached, stamp, now) => (cached
  && cached.stamp === stamp && now - cached.at < TTL ? cached.me : null);
