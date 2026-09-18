// JSON calls to the site's own functions. Every request carries the
// session cookie; a POST says where it came from, which the functions
// check.

export const api = async (path, { method = "GET", body } = {}) => {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => ({}));

  return { ok: res.ok, status: res.status, data };
};
