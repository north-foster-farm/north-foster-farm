// The cart's view state (#477, docs/cart.md 4.3): where it goes and
// how it folds, every rule in one place.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  attributes, close, escape, initial, open, place, rendered, setShare,
  toggle,
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
    });
    assert.deepEqual(attributes(initial()), {
      "data-placement": "floating",
      "data-fold": "closed",
      "data-empty": "",
      "data-share": "",
    });
  });
});
