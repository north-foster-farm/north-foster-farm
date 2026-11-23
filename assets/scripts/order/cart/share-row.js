// The shared row (#203, docs/refactors/cart.md, phase 5): the way and
// Add discount side by side, each opening over the whole row, and the
// discount code with its note. Cart builds one, wires it with the rest
// of the pane, and asks it to fold the row on Escape.

import { awayFrom } from "../lib/share-away.mjs";
import { codeNote } from "./code-note.mjs";
import { qs, reduced } from "./dom.js";
import { shutShare } from "./view.mjs";

export class ShareRow {
  // `root` is #order-cart. `on` is Cart's callbacks, of which this
  // calls onWay and onCode. `pane` holds the view state (`state`) and
  // opens one side of the row (`setShare`).
  constructor(root, on, pane) {
    this.root = root;
    this.on = on;
    this.pane = pane;
    this.note = null;
  }

  // A pick, Apply (#532), a tap or a focus outside the row, or Escape
  // folds it back. Blur alone does not: a tap on Apply blurs the field
  // on iOS before its click lands.
  wire() {
    const share = qs(this.root, "[data-cart-share]");
    const input = qs(share, "[data-field='code']");

    this.wireToggles(share, input);
    this.wirePick(share);
    this.wireAway(share);
    this.wireApply(share, input);
    this.note = this.wireCodeNote();
  }

  wireToggles(share, input) {
    qs(share, "[data-way-toggle]").addEventListener("click", () => {
      this.pane.setShare("way");
      (qs(share, "[data-way][aria-pressed='true']")
        || qs(share, "[data-way]")).focus();
    });
    qs(share, "[data-code-toggle]").addEventListener("click", () => {
      this.pane.setShare("code");
      input.focus();
    });
  }

  wirePick(share) {
    share.addEventListener("click", (e) => {
      const pick = e.target.closest("[data-way]");

      if (!pick) return;
      this.pane.setShare("");
      qs(share, "[data-way-toggle]").focus();
      this.on.onWay(pick.dataset.way);
    });
  }

  // A focus on an ancestor of the row is not away: Safari focuses
  // the pane, not the pick it tapped (#383, share-away.mjs).
  wireAway(share) {
    const away = (e) => {
      const open = this.pane.state.share;

      if (open && awayFrom(
        { dataset: { share: open }, contains: (n) => share.contains(n) },
        e.target, e.type === "focusin"
      )) {
        this.shutRow();
      }
    };

    document.addEventListener("pointerdown", away);
    document.addEventListener("focusin", away);
  }

  // The discount code: Apply, or Enter in the field (#532). An empty
  // field takes the code off and closes at once; a code closes the
  // field once the form has an answer (codeResult), accepted or
  // refused, the refused one left in the field for the next open. A
  // group's code asks first, and Cancel there leaves the field open
  // with the code in it (#495, decision 5).
  wireApply(share, input) {
    const submit = () => {
      const empty = !input.value.trim();

      this.on.onCode(input.value);
      if (empty) this.shutCode();
    };

    qs(share, "[data-code-apply]").addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
  }

  // Folds the shared row. The code field goes the way it came in, the
  // opening reversed, and instantly under reduced motion (#532); the
  // way's switch shuts at once, as before. Resolves once the row's two
  // buttons are back, so the caller can focus one.
  shutRow() {
    const part = qs(this.root, "#order-cart-code");

    if (this.pane.state.share !== "code") {
      if (this.pane.state.share) this.pane.setShare("");

      return Promise.resolve();
    }

    return shutShare(part, () => {
      if (this.pane.state.share === "code") this.pane.setShare("");
    }, { reduce: reduced() });
  }

  // Folds the code field after Apply and hands the focus back to Add
  // discount, unless something else took it meanwhile (a dialog).
  shutCode() {
    const share = qs(this.root, "[data-cart-share]");

    return this.shutRow().then(() => {
      const at = document.activeElement;

      if (!at || at === document.body || share.contains(at)) {
        qs(share, "[data-code-toggle]").focus();
      }
    });
  }

  // The line under the code (code-note.mjs): drawn here, timed there.
  wireCodeNote() {
    const input = qs(this.root, "[data-field='code']");
    const note = qs(this.root, "[data-code-note]");

    return codeNote({
      show: ({ text, tone, fading }) => {
        note.classList.toggle("is-fading", fading);
        note.textContent = text;
        note.hidden = !text;
        if (tone) note.dataset.tone = tone;
        else delete note.dataset.tone;
      },
      clear: () => { input.value = ""; },
    });
  }

  // The outcome of a code the form applied: `text` and `tone` for the
  // note ("good" for an accepted one). An accepted code also empties
  // the field; its note, and that of a code `refused` on Apply, fades
  // after a short while (code-note.mjs), and either folds the field if
  // it is open (#532). A note that `stays` (the rate limit's) folds the
  // field too but stays until the next one.
  codeResult({
    text = "", tone = "", accepted = false, refused = false, stays = false,
  } = {}) {
    this.note.result({ text, tone, accepted, refused, stays });
    if ((accepted || refused) && this.pane.state.share === "code") {
      this.shutCode();
    }
  }

  // The cart's own fields, for the form's collect() and restore().
  codeValue() {
    return qs(this.root, "[data-field='code']").value;
  }

  setCodeValue(value) {
    qs(this.root, "[data-field='code']").value = value;
  }
}
