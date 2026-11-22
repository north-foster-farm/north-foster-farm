// The keyframes of the sheet's motion, and their clock (#559): pure,
// for the unit tests. view.mjs moveParts and swapWords play them.

// Every part's ease in a move runs on this clock and curve, under one
// id the specs wait on.
export const MOVE_MS = 420;
export const MOVE_EASE = "cubic-bezier(0.2, 0.8, 0.25, 1)";
export const MOVE_ID = "cart-move";

// The keyframes for one part, from its two sizes (pure, for the unit
// tests). A body part eases its height; a sideways part (a foot
// button) its flex basis with its growth held, since a flex item's
// width is its basis. Coming or going, the room it takes besides its
// size (view.mjs ROOM: padding, borders, margins, a foot button's gap)
// eases from or to nothing with it, so the pane's edge, the part and
// everything under it move on the same curve to the end. Its fade is
// fadeFrames', on its own timing.
export const moveFrames = (sideways, was, now) => {
  const fade = !was.shown || !now.shown;
  const seen = was.shown ? was : now;
  const frame = (size, gone) => {
    const f = sideways
      ? {
        flexGrow: 0, flexShrink: 0, flexBasis: `${size}px`, minWidth: "0px",
        maxWidth: "none",
      }
      : { height: `${size}px`, minHeight: "0px", maxHeight: "none" };

    if (!fade) return f;
    for (const [name, value] of Object.entries(seen.room || {})) {
      f[name] = gone ? "0px" : value;
    }
    if (sideways && gone) {
      f.marginRight = `${(parseFloat(seen.room?.marginRight) || 0)
        - (seen.gap || 0)}px`;
    }

    return f;
  };

  return [frame(was.size, !was.shown), frame(now.size, !now.shown)];
};

// Where on the shared curve a fade ends or begins (#559, round 3): what
// goes is gone by FADE_OUT of the way, and what comes shows from
// FADE_IN, so old and new contents are never on screen together (the
// clear's lines faded over the new total row) and a part that comes is
// most of its height before it shows (Expand's rows looked squeezed
// under Hide). Offsets on the eased progress: the curve starts fast,
// so FADE_OUT is about the first 85 ms and FADE_IN about the first
// 150 ms of MOVE_MS.
export const FADE_OUT = 0.6;
export const FADE_IN = 0.75;

// The opacity keyframes for a part that comes or goes (pure, for the
// unit tests); null for one that stays.
export const fadeFrames = (was, now) => {
  if (was.shown === now.shown) return null;
  if (now.shown) {
    return [
      { opacity: 0, offset: 0 },
      { opacity: 0, offset: FADE_IN },
      { opacity: 1, offset: 1 },
    ];
  }

  return [
    { opacity: 1, offset: 0 },
    { opacity: 0, offset: FADE_OUT },
    { opacity: 0, offset: 1 },
  ];
};

// The pane's own room, which a settle or a lift-off changes (the
// settled pane has no padding, and its border is thinner): eased with
// the parts on their clock, so the foot's width and the parts' widths
// move as one (#559, round 3: on a CSS clock of its own, the foot
// narrowed a frame ahead of its buttons, and Proceed to checkout
// wrapped onto a row of its own).
export const CHROME = [
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth",
  "borderLeftWidth", "marginLeft", "marginRight",
];

// The keyframes for the pane itself (pure, for the unit tests): its
// room where it changed, and `shift`, how far below its resting place
// the pane starts, eased away. Null when nothing changes.
//
// The shift is the lift-off's (#559, round 3). A floating pane rests
// on its foot (sticky), so on the frame an open settled cart lifted
// off, the pane, still as tall as the settled cart, jumped up over the
// catalog by all the height it had yet to lose, and shrank back down:
// two carts on screen for a third of a second. Started that far down
// and eased up as it shrinks, its top stays where the settled cart's
// was while the lines go and the total row and the foot rise into
// view, the settle run backwards.
export const paneFrames = (was, now, shift = 0) => {
  const from = {};
  const to = {};

  for (const name of CHROME) {
    if (was[name] !== undefined && was[name] !== now[name]) {
      from[name] = was[name];
      to[name] = now[name];
    }
  }
  if (Math.abs(shift) >= 0.5) {
    from.translate = `0 ${shift}px`;
    to.translate = "0 0";
  }

  return Object.keys(to).length ? [from, to] : null;
};

// How far below its resting place a floating pane must start so that
// its top stays where it was (see paneFrames), from its box before the
// change and after it. 0 when the pane is not floating after it (the
// settled pane keeps its top in the flow) or the shift is under half a
// pixel.
export const liftShift = ({ wasTop, wasHeight, nowBottom, floating }) => {
  if (!floating) return 0;

  const shift = wasTop - (nowBottom - wasHeight);

  return Math.abs(shift) < 0.5 ? 0 : shift;
};

// The opacity keyframes for Clear cart (pure, for the unit tests): one
// that goes fades over the whole move, and one that comes as a part
// does. It stands astride the pane's top edge, over the padding, so it
// shares no room with what comes and needs no early fade. By FADE_OUT
// it was gone in about 73 ms, less than one frame gap of WebKit on CI,
// so the per-frame spec saw a cut, and on a phone it was 4 frames.
export const pillFadeFrames = (was, now) => (was.shown && !now.shown
  ? [{ opacity: 1, offset: 0 }, { opacity: 0, offset: 1 }]
  : fadeFrames(was, now));

// Whether a part moves, from its two sizes: half a pixel is rounding.
export const moves = (was, now) => (was.shown || now.shown)
  && Math.abs(was.size - now.size) >= 0.5;

// The opacity keyframes for words that change with a move (pure, for
// the unit tests): the old words go as a part that goes (gone by
// FADE_OUT), and the new ones come as a part that comes (from FADE_IN).
export const WORD_FRAMES = [
  { opacity: 1, offset: 0 },
  { opacity: 0, offset: FADE_OUT },
  { opacity: 0, offset: FADE_IN },
  { opacity: 1, offset: 1 },
];

// The words the swap puts in, from the ease's progress on the shared
// curve (pure, for the unit tests): the old ones until they have faded
// to nothing, the new ones after.
export const wordsAt = (progress, was, now) => (
  progress !== null && progress < FADE_OUT ? was : now
);
