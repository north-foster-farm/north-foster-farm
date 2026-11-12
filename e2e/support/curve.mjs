// The per-frame spec's check of a move against its curve (#559, fix
// round on fb5908d7). The phone sheet moves every part on one curve and
// one clock (assets/scripts/order/cart/view.mjs moveParts), so on any
// frame every edge of every part sits at
//
//   from + (to - from) * curve(time into the move / its length)
//
// where `from` is the edge in the last frame before the move and `to`
// in the first frame after it, both at rest. Each frame keeps the
// move's own record, read from the page in the same frame as the boxes:
// its number, how far into it the clock is, its length and its curve.
// So a frame drawn late, as WebKit on CI starves the renderer (48 ms,
// then 322 ms between frames), is held to where the curve is at that
// moment and cannot fail a smooth move, while a part off its curve, a
// part that snaps or eases on a clock of its own, still fails.
//
// Between moves, with the cart unchanged, no edge moves more than
// `step` px a frame, after the floating pane's resting place, which
// eases on its own CSS transition, is taken out; that resting place
// may itself move only while its transition runs (James's 23px drop).
//
// No Playwright import: the unit tests load it (test/e2e-curve.test.mjs).

// The edges a frame records for each part.
export const EDGES = {
  pane: ["top", "bottom"],
  total: ["top", "bottom"],
  foot: ["top", "bottom"],
  lines: ["top"],
  clear: ["top", "bottom"],
  toggle: ["top", "bottom", "left", "right"],
  next: ["top", "bottom", "left", "right"],
};

const DOWN = new Set(["top", "bottom"]);

// A CSS timing function as a function of the time's share, 0 to 1:
// cubic-bezier() and linear, the only ones the cart uses. Null for any
// other, which the caller reports rather than guesses.
export const curve = (easing) => {
  if (easing === "linear") return (x) => Math.min(1, Math.max(0, x));

  const m = /^cubic-bezier\(([^)]+)\)$/.exec(String(easing).trim());

  if (!m) return null;

  const [x1, y1, x2, y2] = m[1].split(",").map(Number);
  const at = (a, b, t) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b
    + t ** 3;

  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;

    // The x of the curve climbs with t for 0 <= x1, x2 <= 1: halve the
    // interval.
    let lo = 0;
    let hi = 1;

    for (let i = 0; i < 50; i += 1) {
      const t = (lo + hi) / 2;

      if (at(x1, x2, t) < x) lo = t;
      else hi = t;
    }

    return at(y1, y2, (lo + hi) / 2);
  };
};

// How far along its curve a frame's move is, 0 to 1, from its record:
// { at: ms into it, duration, easing }. Null for a frame with no move.
export const progressOf = (move) => {
  if (!move) return null;

  const ease = curve(move.easing);

  if (!ease) throw new Error(`no curve for "${move.easing}"`);

  return ease(move.duration > 0 ? move.at / move.duration : 1);
};

// The moves in a recording: each a run of frames with the same move
// number, with the frame before it and the frame after it. `pre` is
// null for a move already running when the recording began, `post` for
// one a newer move cut off, as the next move takes over from wherever
// the parts were.
export const movesIn = (frames) => {
  const runs = [];

  frames.forEach((f, i) => {
    if (!f.move) return;

    const last = runs[runs.length - 1];

    if (last && last.end === i - 1 && last.no === f.move.no) {
      last.end = i;
    } else {
      runs.push({ no: f.move.no, start: i, end: i });
    }
  });

  return runs.map((run) => {
    const before = frames[run.start - 1];
    const after = frames[run.end + 1];

    return {
      ...run,
      pre: before && !before.move ? run.start - 1 : null,
      post: after && !after.move ? run.end + 1 : null,
    };
  });
};

// Where an edge is, in the frame of reference a part keeps while still:
// a settled pane's parts move with the page, a floating one's rest on
// the screen's foot at the pane's `bottom`. Across a lift-off or a
// settle, `pre`'s edge is put in `like`'s frame of reference, as it was
// at `like`'s scroll: the move started between the two.
const place = (f, part, edge, like = f) => {
  const v = f[part][edge];

  if (!DOWN.has(edge)) return v;
  if (like.placement === f.placement) {
    return f.placement === "inline" ? v + f.y : v + (f.bottom || 0);
  }

  return like.placement === "inline"
    ? v + like.y
    : v + f.y - like.y + (like.bottom || 0);
};

// Whether a part is there to measure in a frame: drawn, and, for the
// parts that can fade, not faded to nothing.
const shows = (f, part) => Boolean(f[part])
  && (part === "pane" || part === "foot" || (f.ops?.[part] ?? 1) > 0.05);

// The first frame of a recording a part sits off its curve in, or null:
// { at, why }. `step` is the tolerance, `px` a pixel of rounding.
export const offCurve = (frames, { step = 8, px = 1 } = {}) => {
  for (const move of movesIn(frames)) {
    if (move.pre === null || move.post === null) continue;

    const pre = frames[move.pre];
    const post = frames[move.post];
    const first = frames[move.start];
    // A lift-off or a settle started somewhere between `pre` and the
    // move's first frame, as the page scrolled: that far is unknown.
    const slack = pre.placement === first.placement
      ? 0 : Math.abs(first.y - pre.y);

    for (const [part, edges] of Object.entries(EDGES)) {
      if (!pre[part] || !post[part]) continue;

      for (const edge of edges) {
        if (DOWN.has(edge) && post.placement !== first.placement) continue;

        const from = place(pre, part, edge, first);
        const to = place(post, part, edge);

        for (let i = move.start; i <= move.end; i += 1) {
          const f = frames[i];

          if (!shows(f, part)) continue;

          const p = progressOf(f.move);
          const want = from + (to - from) * p;
          const off = place(f, part, edge) - want;

          if (Math.abs(off) > step + slack + px) {
            return {
              at: i,
              why: `the ${part}'s ${edge} is ${off.toFixed(1)}px off its `
                + `curve (${Math.round(p * 100)}% of the way at ${
                  Math.round(f.move.at)}ms, from ${from.toFixed(1)} to ${
                  to.toFixed(1)})`,
            };
          }
        }
      }
    }
  }

  return null;
};

// The first frame pair, outside any move, in which an edge moved more
// than `step` px, or the floating pane's resting place moved with no
// transition: { at, why } with `at` the later frame, or null.
export const offRest = (frames, { step = 8, px = 1 } = {}) => {
  for (let i = 0; i + 1 < frames.length; i += 1) {
    const f = frames[i];
    const g = frames[i + 1];

    if (f.move || g.move) continue;

    const floating = f.placement !== "inline" && g.placement !== "inline";
    const rest = floating ? (g.bottom || 0) - (f.bottom || 0) : 0;

    if (floating && !f.resting && !g.resting && Math.abs(rest) > step + px) {
      return {
        at: i + 1,
        why: `the pane's resting place moved ${rest.toFixed(1)}px in one `
          + "frame with no ease",
      };
    }

    for (const [part, edges] of Object.entries(EDGES)) {
      if (!shows(f, part) || !shows(g, part)) continue;

      for (const edge of edges) {
        const a = f[part][edge];
        const b = g[part][edge];

        if (DOWN.has(edge) && Math.max(a, b) < 0) continue;
        if (DOWN.has(edge) && Math.min(a, b) > f.vh) continue;

        let d = b - a;

        if (DOWN.has(edge)) {
          // The page moved by s: its contents by -s on the screen. A
          // floating pane rests `bottom` above the screen's foot.
          const page = d + (g.y - f.y);

          if (f.placement === "inline" && g.placement === "inline") d = page;
          else if (floating) d += rest;
          else if (Math.abs(page) < Math.abs(d)) d = page;
        }

        if (Math.abs(d) > step + px) {
          return {
            at: i + 1,
            why: `the ${part}'s ${edge} jumped ${d.toFixed(1)}px in one `
              + `frame with the cart unchanged (at most ${step})`,
          };
        }
      }
    }
  }

  return null;
};
