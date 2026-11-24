// The customer's interactions that check stock on the order page
// (#908, James's rule 1): adding to the cart or taking out (a row's
// More and Fewer), a quantity typed, and the cart opened from its
// toggle. Each tells the page's stock reader, whose 15-second floor
// keeps a burst of them to one check. It also hands site search that
// reader (search/live-stock.js), so the two share one.

export const wireStockNudges = (form, stock, root = document) => {
  form.addEventListener("click", (e) => {
    if (e.target.closest("[data-step]")) stock.nudge();
  });
  form.addEventListener("change", (e) => {
    if (e.target.matches("[data-qty]")) stock.nudge();
  });
  root.addEventListener("click", (e) => {
    if (e.target.closest("[data-cart-toggle]")) stock.nudge();
  });
  window.nffStock = { read: () => stock.read() };
};
