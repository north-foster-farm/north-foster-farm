// The per-frame spec's check of a move against its curve (#559, fix
// round on fb5908d7). The phone sheet moves every part on one curve and
// one clock (assets/scripts/order/cart/view/move.js moveParts), so on any
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
// A move whose whole ease fell between two frames is held to the
// travel of its eases instead (missed, #635), and a resting place
// whose whole transition did, to that transition's (missedRest).
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

// The lengths an ease's keyframes carry, by the axis they move edges
// on. `translate` is "x y". Any other property (opacity, flex-grow)
// moves no edge.
const DOWN_BY = new Set([
  "height", "minHeight", "maxHeight", "top", "bottom", "paddingTop",
  "paddingBottom", "borderTopWidth", "borderBottomWidth", "marginTop",
  "marginBottom",
]);
const ACROSS_BY = new Set([
  "width", "minWidth", "maxWidth", "flexBasis", "left", "right",
  "paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth",
  "marginLeft", "marginRight",
]);

// How far an ease can move any edge, down and across, from its
// keyframes (getKeyframes()): each length's range over the frames,
// summed. In flow no edge moves further than every eased length
// together, so this bounds what the ease alone can do.
export const travelOf = (keys = []) => {
  const travel = { down: 0, across: 0 };
  const ranges = {};

  for (const key of keys) {
    for (const [name, value] of Object.entries(key)) {
      const axes = name === "translate" ? ["across", "down"]
        : DOWN_BY.has(name) ? ["down"]
          : ACROSS_BY.has(name) ? ["across"] : [];

      String(value).trim().split(/\s+/).slice(0, axes.length)
        .forEach((v, k) => {
          const n = parseFloat(v);

          if (Number.isNaN(n)) return;

          const r = ranges[`${name} ${k}`] ||= { axis: axes[k], lo: n, hi: n };

          r.lo = Math.min(r.lo, n);
          r.hi = Math.max(r.hi, n);
        });
    }
  }
  for (const r of Object.values(ranges)) travel[r.axis] += r.hi - r.lo;

  return travel;
};

// The eases a frame pair missed whole: those that began after the
// first frame (the later frame's `began`, noted as the page started
// them), with neither frame in a move, each shorter than the gap
// between the two frames. Their travel summed, or null for none.
//
// WebKit on CI draws a frame only every 400 to 700 ms while the main
// thread is free (#635: 461 and 665 ms around a settle, 488 around a
// minimize), so a whole 420 ms move can fall between two frames and
// show only its start and its end. The rule that holds a still pane
// to `step` px a frame cannot judge that step. It allows it only as
// far as the missed eases' own travel on the edge's axis, so:
// - a step with no ease begun between the two frames is still a jump;
// - a move seen on any frame is still held to its curve (offCurve):
//   either frame in a move takes the pair out of this rule;
// - an ease that began but could still have been running at the later
//   frame (the gap no longer than it) exempts nothing;
// - a step beyond what the begun eases could move is still a jump.
// What the frames cannot show they cannot vouch for: a snap no larger
// than the missed move, hidden in the same gap, passes. The next pair
// is held to `step` again, so nothing may go on moving after it.
const missed = (f, g) => {
  const began = g.began || [];

  if (!began.length) return null;
  if (began.some((e) => !(g.t - f.t > e.duration))) return null;

  return began.reduce((sum, e) => {
    const t = travelOf(e.keys);

    return { down: sum.down + t.down, across: sum.across + t.across };
  }, { down: 0, across: 0 });
};

// How far the resting place may have moved on transitions a frame pair
// missed whole, or null when it may not have moved unseen at all. The
// floating pane's `bottom` eases on a CSS transition of its own
// (_cart.scss), 420 ms, which the same starved frames can miss from
// its start to its end. The later frame keeps the transitions begun
// since the first (`restBegan`) and how many ran to their end
// (`restEnded`). A step is allowed only when:
// - at least one transition of `bottom` began between the two frames,
//   and as many ran to their end, so none was cut off or still runs;
// - neither frame showed one running (`resting`; offRest asks only
//   then): a transition seen on a frame is judged by that frame;
// - each is shorter than the gap between the frames;
// - the step is within their travel, from their keyframes. Where the
//   recorder could not read them (the transition was over before its
//   event came), its travel is from the first frame's resting place,
//   where it began, to the later's, where it ended: its having run to
//   its end is what holds it then.
const missedRest = (f, g) => {
  const began = g.restBegan || [];

  if (!began.length || (g.restEnded || 0) < began.length) return null;
  if (began.some((e) => !(g.t - f.t > e.duration))) return null;
  if (began.some((e) => !e.keys)) return Infinity;

  return began.reduce((sum, e) => sum + travelOf(e.keys).down, 0);
};

// The first frame pair, outside any move, in which an edge moved more
// than `step` px, or than the eases the pair missed can move it
// (missed), or the floating pane's resting place moved with no
// transition: { at, why } with `at` the later frame, or null.
export const offRest = (frames, { step = 8, px = 1 } = {}) => {
  for (let i = 0; i + 1 < frames.length; i += 1) {
    const f = frames[i];
    const g = frames[i + 1];

    if (f.move || g.move) continue;

    const unseen = missed(f, g);

    const floating = f.placement !== "inline" && g.placement !== "inline";
    const rest = floating ? (g.bottom || 0) - (f.bottom || 0) : 0;

    if (floating && !f.resting && !g.resting && Math.abs(rest) > step + px) {
      const may = missedRest(f, g);

      if (may === null || Math.abs(rest) > may + px) {
        return {
          at: i + 1,
          why: may === null
            ? `the pane's resting place moved ${rest.toFixed(1)}px in one `
              + "frame with no ease"
            : `the pane's resting place moved ${rest.toFixed(1)}px in one `
              + `frame, more than the ${may.toFixed(1)}px its ease begun `
              + `between the two (${Math.round(g.t - f.t)}ms apart, none `
              + "seen) moves",
        };
      }
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

        if (Math.abs(d) <= step + px) continue;

        const may = unseen && unseen[DOWN.has(edge) ? "down" : "across"];

        if (unseen && Math.abs(d) <= may + px) continue;

        return {
          at: i + 1,
          why: unseen
            ? `the ${part}'s ${edge} jumped ${d.toFixed(1)}px in one frame, `
              + `more than the ${may.toFixed(1)}px the ease begun between `
              + `the two (${Math.round(g.t - f.t)}ms apart, none seen) moves`
            : `the ${part}'s ${edge} jumped ${d.toFixed(1)}px in one `
              + `frame with the cart unchanged (at most ${step})`,
        };
      }
    }
  }

  return null;
};
