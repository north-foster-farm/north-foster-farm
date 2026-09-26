// The Venmo dark launch. With VENMO_HIDDEN set on the deploy, the
// button shows only to a browser that has opened the order page with
// ?venmo, so the farm can prove a live payment before customers see
// it. The browser remembers, so the flag survives what the page does
// to its URL: edit mode, a reload, the sign-in round trip, a link from
// the account page. ?venmo=0 forgets. Unset, the button always shows.

// -> { show, remember }: whether to show the button, and what the
// browser should remember from now on.
export const venmoGate = (hidden, search, remembered) => {
  const value = new URLSearchParams(search).get("venmo");
  const remember = value === null ? remembered : value !== "0";

  return { show: !hidden || remember, remember };
};
