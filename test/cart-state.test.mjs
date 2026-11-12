// The cart's view state (#477, docs/cart.md 4.3): where it goes and
// how it folds, every rule in one place.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MINIMIZE_AT, attributes, close, escape, expand, forget, hide, initial,
  open, place, rendered, scrolled, setShare, toggle,
} from "../assets/scripts/order/cart/state.mjs";

// A phone's page: 844 tall, the pane resting 16px above the foot.
const ROOM = 828;
// The pane closed (the total and the foot), open under its cap, and
// settled with every line showing.
const PANE = { closed: 120, open: 480, inline: 700 };

const look = (state, slotTop, more = {}) => place(state, {
  column: false, short: false, slotTop, room: ROOM,
  height: state.placement === "inline" ? PANE.inline : PANE[state.fold],
  closedH: PANE.closed, ...more,
});

// Scrolls the slot from one place to another in steps, as the page
// does, and counts how often the placement changes.
const scroll = (start, from, to) => {
  let state = start;
  let flips = 0;
  const step = from > to ? -8 : 8;

  for (let top = from; step > 0 ? top <= to : top >= to; top += step) {
    const next = look(state, top);

    if (next.placement !== state.placement) flips += 1;
    state = next;
  }

  return { state, flips };
};

describe("place", () => {
  it("floats on the first look when the slot is below the screen", () => {
    const state = look(initial(), 2000);

    assert.equal(state.placement, "floating");
    assert.equal(state.fold, "closed");
  });

  it("is inline on the first look when the slot is on screen", () => {
    const state = look(initial(), 300);

    assert.equal(state.placement, "inline");
    assert.equal(state.fold, "open");
  });

  it("settles when the slot's top rises to the floating pane's top", () => {
    const floating = { ...initial(), placement: "floating", fold: "open" };

    assert.equal(look(floating, ROOM - PANE.open + 1).placement, "floating");
    assert.equal(look(floating, ROOM - PANE.open).placement, "inline");
  });

  it("settles open, whatever it floated as", () => {
    const closed = { ...initial(), placement: "floating", fold: "closed" };

    assert.equal(look(closed, 100).fold, "open");
  });

  it("lifts off closed when the slot sinks below the closed pane", () => {
    const inline = { ...initial(), placement: "inline", fold: "open" };

    assert.equal(look(inline, ROOM - PANE.closed).placement, "inline");

    const lifted = look(inline, ROOM - PANE.closed + 1);

    assert.equal(lifted.placement, "floating");
    assert.equal(lifted.fold, "closed");
  });

  it("flips once on the way down and once on the way up", () => {
    const start = { ...initial(), placement: "floating", fold: "open" };
    const down = scroll(start, 1400, 200);

    assert.equal(down.flips, 1);
    assert.equal(down.state.placement, "inline");

    const up = scroll(down.state, 200, 1400);

    assert.equal(up.flips, 1);
    assert.equal(up.state.placement, "floating");
    assert.equal(up.state.fold, "closed");
  });

  it("does not lift off again at once after settling and growing", () => {
    // The pane settles at its open height and grows to show every
    // line; judged by its new height it would float again. It is
    // judged by the closed height instead.
    const start = { ...initial(), placement: "floating", fold: "open" };
    const at = ROOM - PANE.open;
    const settled = look(start, at);

    assert.equal(settled.placement, "inline");
    assert.equal(look(settled, at).placement, "inline");
    assert.equal(look(settled, at + 100).placement, "inline");
  });

  it("is a column from xl, open, wherever the slot is", () => {
    for (const top of [-500, 300, 2000]) {
      const state = look({ ...initial(), fold: "closed" }, top, {
        column: true,
      });

      assert.equal(state.placement, "column");
      assert.equal(state.fold, "open");
    }
  });

  it("is inline and open on a short screen, wherever the slot is", () => {
    for (const top of [-500, 300, 2000]) {
      const state = look({ ...initial(), fold: "closed" }, top, {
        short: true,
      });

      assert.equal(state.placement, "inline");
      assert.equal(state.fold, "open");
    }
  });

  it("leaving the column, floats or settles by the slot", () => {
    const column = { ...initial(), placement: "column", fold: "open" };

    assert.equal(look(column, 2000).placement, "floating");
    assert.equal(look(column, 100).placement, "inline");
  });
});

describe("open, close, toggle", () => {
  const floating = { ...initial(), placement: "floating", fold: "closed" };

  it("fold a floating cart", () => {
    assert.equal(open(floating).fold, "open");
    assert.equal(close(open(floating)).fold, "closed");
    assert.equal(toggle(floating).fold, "open");
    assert.equal(toggle(toggle(floating)).fold, "closed");
  });

  it("leave an inline or column cart open", () => {
    for (const placement of ["inline", "column"]) {
      const state = { ...initial(), placement, fold: "open" };

      assert.equal(close(state).fold, "open");
      assert.equal(toggle(state).fold, "open");
    }
  });
});

describe("escape", () => {
  it("folds a floating open cart and says so", () => {
    const state = { ...initial(), placement: "floating", fold: "open" };
    const out = escape(state);

    assert.equal(out.handled, true);
    assert.equal(out.state.fold, "closed");
  });

  it("does nothing to a closed, inline or column cart", () => {
    for (const state of [
      { ...initial(), placement: "floating", fold: "closed" },
      { ...initial(), placement: "inline", fold: "open" },
      { ...initial(), placement: "column", fold: "open" },
    ]) {
      const out = escape(state);

      assert.equal(out.handled, false);
      assert.deepEqual(out.state, state);
    }
  });
});

describe("rendered", () => {
  const floating = { ...initial(), placement: "floating", fold: "open" };

  it("marks an empty cart", () => {
    assert.equal(rendered(floating, { count: 0, was: 2 }).empty, true);
    assert.equal(rendered(floating, { count: 2, was: 0 }).empty, false);
  });

  it("folds a floating cart that empties", () => {
    assert.equal(rendered(floating, { count: 0, was: 1 }).fold, "closed");
  });

  it("folds a floating cart that loads empty", () => {
    assert.equal(rendered(floating, { count: 0, was: null }).fold, "closed");
  });

  it("opens a floating cart a restored draft fills", () => {
    const closed = { ...floating, fold: "closed" };

    assert.equal(rendered(closed, { count: 3, was: null }).fold, "open");
    assert.equal(rendered(closed, { count: 3, was: 0 }).fold, "open");
  });

  it("leaves a floating cart an Add fills as it was", () => {
    const closed = { ...floating, fold: "closed" };

    assert.equal(
      rendered(closed, { count: 1, was: 0, adding: true }).fold, "closed"
    );
  });

  it("leaves a fold the customer chose until the cart empties", () => {
    const closed = { ...floating, fold: "closed" };

    assert.equal(rendered(closed, { count: 4, was: 3 }).fold, "closed");
    assert.equal(rendered(floating, { count: 2, was: 3 }).fold, "open");
  });

  it("never folds an inline or column cart", () => {
    for (const placement of ["inline", "column"]) {
      const state = { ...initial(), placement, fold: "open" };

      assert.equal(rendered(state, { count: 0, was: 1 }).fold, "open");
    }
  });
});

describe("attributes", () => {
  it("mirror the state, the fold open unless floating", () => {
    assert.deepEqual(attributes(setShare({
      ...initial(), placement: "inline", fold: "closed", empty: false,
    }, "code")), {
      "data-placement": "inline",
      "data-fold": "open",
      "data-empty": null,
      "data-share": "code",
      "data-kept": null,
    });
    assert.deepEqual(attributes(initial()), {
      "data-placement": "floating",
      "data-fold": "closed",
      "data-empty": "",
      "data-share": "",
      "data-kept": null,
    });
  });

  it("mark the stay-open choice for the specs", () => {
    assert.equal(attributes({ ...initial(), kept: true })["data-kept"], "");
  });
});

// The open phone sheet on a page scroll (#559, the proposal James
// agreed on 2026-11-12, with its defaults).
describe("scrolled", () => {
  const openSheet = {
    ...initial(), placement: "floating", fold: "open", empty: false,
  };
  const seen = (more) => ({
    y: 1000, from: 1000, sheet: true, counts: true, busy: false, ...more,
  });

  // A person's scroll, a frame at a time, from `start` by `by` px.
  const swipe = (state, { start = 1000, by, step = 6, ...more }) => {
    let s = state;
    let from = start;
    const dir = Math.sign(by);

    for (let y = start; Math.abs(y - start) <= Math.abs(by); y += dir * step) {
      ({ state: s, from } = scrolled(s, seen({ y, from, ...more })));
    }

    return s;
  };

  it("minimizes once the page has moved 48px, either way", () => {
    assert.equal(MINIMIZE_AT, 48);
    for (const by of [MINIMIZE_AT, -MINIMIZE_AT]) {
      const out = scrolled(openSheet, seen({ y: 1000 + by }));

      assert.equal(out.state.fold, "closed");
      assert.equal(out.state.shutByScroll, true);
      assert.equal(out.from, null);
    }
  });

  it("does not minimize on a nudge", () => {
    const out = scrolled(openSheet, seen({ y: 1000 + MINIMIZE_AT - 1 }));

    assert.equal(out.state, openSheet);
    assert.equal(out.from, 1000);
  });

  it("minimizes once in a long swipe, partway through", () => {
    let s = openSheet;
    let from = 1000;
    let shuts = 0;

    for (let y = 1000; y <= 1600; y += 12) {
      const out = scrolled(s, seen({ y, from }));

      if (out.state.fold !== s.fold) shuts += 1;
      ({ state: s, from } = out);
    }
    assert.equal(shuts, 1);
    assert.equal(s.fold, "closed");
  });

  it("counts from where the pane finished opening", () => {
    const out = scrolled(openSheet, seen({ y: 5000, from: null }));

    assert.equal(out.state, openSheet);
    assert.equal(out.from, 5000);
  });

  it("does not count a scroll the person did not make", () => {
    const s = swipe(openSheet, { by: 400, counts: false });

    assert.equal(s.fold, "open");
  });

  it("starts the count again after a scroll the page made", () => {
    // The page scrolls itself 300px (counts false), then the person 40.
    let { state: s, from } = scrolled(openSheet,
      seen({ y: 1300, counts: false }));

    assert.equal(from, 1300);
    ({ state: s, from } = scrolled(s, seen({ y: 1340, from })));
    assert.equal(s.fold, "open");
    ({ state: s } = scrolled(s, seen({ y: 1348, from })));
    assert.equal(s.fold, "closed");
  });

  it("never minimizes a pane in use", () => {
    assert.equal(swipe(openSheet, { by: 400, busy: true }).fold, "open");
  });

  it("leaves the tablet's panel alone", () => {
    assert.equal(swipe(openSheet, { by: 400, sheet: false }).fold, "open");
  });

  it("leaves a closed, settled or column cart alone", () => {
    for (const state of [
      { ...openSheet, fold: "closed" },
      { ...openSheet, placement: "inline" },
      { ...openSheet, placement: "column" },
    ]) {
      const out = scrolled(state, seen({ y: 2000 }));

      assert.equal(out.state, state);
      assert.equal(out.from, null);
    }
  });

  it("keeps the pane open after Expand reopened it", () => {
    const shut = swipe(openSheet, { by: 100 });
    const reopened = expand(shut);

    assert.equal(reopened.fold, "open");
    assert.equal(reopened.kept, true);
    assert.equal(swipe(reopened, { by: 2000 }).fold, "open");
  });

  it("keeps it for an Expand by the pill's toggle too", () => {
    const shut = swipe(openSheet, { by: 100 });

    assert.equal(toggle(shut).kept, true);
  });

  it("does not keep a pane Expand opened without a scroll's minimize",
    () => {
      const reopened = expand(hide(openSheet));

      assert.equal(reopened.kept, false);
      assert.equal(swipe(reopened, { by: 100 }).fold, "closed");
    });

  it("does not keep a pane an automatic open reopened", () => {
    const shut = swipe(openSheet, { by: 100 });

    assert.equal(open(shut).kept, false);
  });
});

// What resets the stay-open choice (#559, rule 6).
describe("the stay-open choice", () => {
  const kept = {
    ...initial(), placement: "floating", fold: "open", empty: false,
    kept: true,
  };
  const ROOM_LOOK = {
    column: false, short: false, room: 828, height: 480, closedH: 120,
  };

  it("goes on Hide and on Escape", () => {
    assert.equal(hide(kept).kept, false);
    assert.equal(toggle(kept).kept, false);
    assert.equal(escape(kept).state.kept, false);
  });

  it("stays when an item is added", () => {
    const next = rendered(kept, { count: 4, was: 3, adding: true });

    assert.equal(next.kept, true);
    assert.equal(next.fold, "open");
  });

  it("goes when the cart empties", () => {
    const next = rendered(kept, { count: 0, was: 3 });

    assert.equal(next.kept, false);
    assert.equal(next.fold, "closed");
  });

  it("goes when the cart settles, and the lift-off comes back closed", () => {
    const settled = place(kept, { ...ROOM_LOOK, slotTop: 300 });

    assert.equal(settled.placement, "inline");
    assert.equal(settled.kept, false);

    const lifted = place(settled, { ...ROOM_LOOK, slotTop: 800 });

    assert.equal(lifted.placement, "floating");
    assert.equal(lifted.fold, "closed");
    assert.equal(lifted.kept, false);
  });

  it("goes when the pane changes form", () => {
    assert.equal(forget(kept).kept, false);
    assert.equal(
      place(kept, { ...ROOM_LOOK, column: true, slotTop: 2000 }).kept, false
    );
  });

  it("starts empty on a reload", () => {
    assert.equal(initial().kept, false);
    assert.equal(initial().shutByScroll, false);
  });

  it("forget is a no-op with nothing to forget", () => {
    const plain = { ...kept, kept: false };

    assert.equal(forget(plain), plain);
  });
});
