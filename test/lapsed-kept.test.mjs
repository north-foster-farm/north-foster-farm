// #596: the lapsed dialog (order/lapsed.js) writes its lines through
// setKept, so a phone never leaves a line's last word alone. The e2e
// walk never opens the dialog, so this reads what it writes: each line
// reads as before, and its last two words sit in one text-nowrap span.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { Lapsed } from "../assets/scripts/order/lapsed.js";
import { NOWRAP } from "../assets/scripts/utils/keep-together.mjs";

// Enough of an element for Lapsed and setKept: text and spans, in
// order, and the few properties the dialog touches.
const fakeElement = () => {
  const el = {
    kids: [],
    hidden: false,
    ownerDocument: {
      createElement: (tag) => ({ tag, className: "", textContent: "" }),
    },
    classList: { toggle: () => {} },
    set textContent(value) {
      this.kids = value ? [String(value)] : [];
    },
    get textContent() {
      return this.kids.map((k) => (typeof k === "string" ? k
        : k.textContent)).join("");
    },
    append(kid) {
      this.kids.push(kid);
    },
    addEventListener: () => {},
    querySelector: () => null,
    focus: () => {},
  };

  return el;
};

// The text kept on one line, from the element's spans.
const kept = (el) => el.kids.filter((k) => typeof k !== "string"
  && k.className === NOWRAP).map((k) => k.textContent);

describe("the lapsed dialog keeps each line's last words together (#596)",
  () => {
    let dialog;
    let parts;
    let saved;

    before(() => {
      saved = globalThis.document;
      globalThis.document = { activeElement: null };
      parts = {};
      dialog = {
        querySelector: (s) => {
          parts[s] ||= fakeElement();
          return parts[s];
        },
        addEventListener: () => {},
        showModal: () => {},
      };
    });

    after(() => {
      globalThis.document = saved;
    });

    it("writes its title, lead and way on through setKept", () => {
      const lapsed = new Lapsed(dialog, {
        onUse: () => {}, onOther: () => {},
      });

      lapsed.open("delivery", []);

      const title = parts["#order-lapsed-title"];
      const lead = parts["#order-lapsed-lead"];
      const other = parts["[data-lapsed-other]"];

      assert.equal(title.textContent, "No delivery days are open right now");
      assert.deepEqual(kept(title), ["right now"]);
      assert.equal(lead.textContent, "Nothing has been charged. You can "
        + "still choose another way to get your order.");
      assert.deepEqual(kept(lead), ["your order."]);
      assert.equal(other.textContent,
        "Choose on-farm pickup or a pick-up day");
      assert.deepEqual(kept(other), ["pick-up day"]);
    });
  });
