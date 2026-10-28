// The join token on /join/?t=<token> (#495). Once read it leaves the
// address bar (history.replaceState), so it is not in the history, a
// bookmark or a link copied from the page, and it is kept for this tab
// only in sessionStorage, so a reload still works. It is never put in
// another URL: someone with an account uses the sign-up form, whose
// link signs them in, rather than a trip through /login/?next=.

export const KEY = "nff_join_token";

// `storage` is a getter: reading window.sessionStorage can throw when a
// browser blocks it, and then the token lives only in the page.
const store = (storage) => {
  try {
    return storage() || null;
  } catch {
    return null;
  }
};

// -> the token, from the address or from this tab's storage, or "".
export const takeToken = ({ location, history, storage }) => {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get("t");
  const kept = store(storage);

  if (fromUrl === null) {
    try {
      return (kept && kept.getItem(KEY)) || "";
    } catch {
      return "";
    }
  }

  url.searchParams.delete("t");
  history.replaceState(history.state, "",
    `${url.pathname}${url.search}${url.hash}`);
  try {
    if (kept) kept.setItem(KEY, fromUrl);
  } catch {
    // Kept in the page only.
  }

  return fromUrl;
};

// Whether a check's answer means the token is done with: only when the
// server said so (404, not in force; 429, too many tries). A fetch that
// failed or a server error says nothing about the token, and since `t`
// has already left the address bar, dropping it then would leave
// someone on weak data with a dead page for good (James, #495).
export const tokenDead = (status) => status === 404 || status === 429;

// Once the token is spent or found dead, the tab forgets it.
export const dropToken = ({ storage }) => {
  try {
    const kept = store(storage);

    if (kept) kept.removeItem(KEY);
  } catch {
    // Nothing kept.
  }
};
