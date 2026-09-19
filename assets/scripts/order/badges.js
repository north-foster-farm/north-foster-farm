// The cart's badges live in groups. One that lights leaves the row and
// lands on its group's stack, latest on top, as if coming forward;
// one that goes dark slides back to its place in the row. The moves
// are FLIP animations on the `translate` and `scale` properties, so
// they compose with the depth transform the stylesheet gives each
// card in a stack.

const EASE = "cubic-bezier(0.2, 0.8, 0.25, 1)";
const DURATION = 420;

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export class BadgeStacks {
  constructor(root) {
    this.root = root;
    this.badges = Array.from(root.querySelectorAll("[data-badge]"));
    this.badges.forEach((badge, i) => { badge.dataset.slot = String(i); });
  }

  // `states` maps badge keys to on or off. Returns the badges that
  // just lit. With `animate` false the badges take their places at
  // once, for the first render of a restored draft.
  apply(states, { animate = true } = {}) {
    const lit = [];

    for (const badge of this.badges) {
      const on = !!states[badge.dataset.badge];

      if (on === (badge.dataset.on === "true")) continue;

      const group = badge.closest("[data-badge-group]");
      const stack = group.querySelector("[data-stack]");
      const first = badge.getBoundingClientRect();

      badge.dataset.on = String(on);

      if (on) {
        stack.appendChild(badge);
        lit.push(badge);
      } else {
        const slot = Number(badge.dataset.slot);
        const next = Array.from(group.children).find((el) =>
          el.matches("[data-badge]") && Number(el.dataset.slot) > slot);

        group.insertBefore(badge, next || null);
      }

      this.depths(stack);
      if (animate) this.fly(badge, first, on);
    }

    return lit;
  }

  // Top of the stack is depth 0; the stylesheet sets each card back a
  // little per unit of depth.
  depths(stack) {
    const cards = Array.from(stack.children);

    cards.forEach((card, i) => {
      card.style.setProperty("--i", String(cards.length - 1 - i));
    });
  }

  fly(badge, first, forward) {
    if (reduced() || typeof badge.animate !== "function") return;

    const last = badge.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;

    if (!dx && !dy) return;

    const frames = forward
      ? [
        { translate: `${dx}px ${dy}px`, scale: "1", opacity: 1 },
        {
          translate: `${dx / 2}px ${dy / 2 - 12}px`, scale: "1.3", offset: 0.5,
        },
        { translate: "0 0", scale: "1", opacity: 1 },
      ]
      : [
        { translate: `${dx}px ${dy}px`, scale: "1", opacity: 1 },
        {
          translate: `${dx / 2}px ${dy / 2 + 8}px`,
          scale: "0.75",
          opacity: 0.55,
          offset: 0.5,
        },
        { translate: "0 0", scale: "1", opacity: 1 },
      ];

    badge.animate(frames, { duration: DURATION, easing: EASE });
  }
}
