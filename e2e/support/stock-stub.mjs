// /api/stock as the server gives it, with `over` laid on top: for an
// answer the server can never give (stock on a product the catalog
// has out, an archived one on hand, Large eggs flagged out), or one
// that changes while the page is open (#908). `over` is read at each
// answer, so a test may change its keys between them. Every other
// count is pinned (support/stock.mjs).
export const stubStock = (page, over) => page.route("**/api/stock",
  async (route) => {
    const res = await route.fetch();
    const body = await res.json();

    Object.assign(body.items, over);
    await route.fulfill({ response: res, json: body });
  });
