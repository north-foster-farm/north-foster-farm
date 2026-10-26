// Whether a touch on the open cart pane was a tap or a scroll (#473).
// A tap is the customer's say to keep the pane; a scroll, of the page
// or of the list, is not. The touch is judged when it ends, never when
// it lands: a scroll starts as a touch like any other.

// How far, in CSS pixels, a finger may stray and still be tapping.
export const TAP_SLOP = 10;

// The farthest a touch has strayed from where it landed, given the
// farthest so far and where it is now.
export const strayed = (start, point, was = 0) => Math.max(
  was, Math.hypot(point.x - start.x, point.y - start.y)
);

// "tap" or "scroll". The browser cancels a touch it takes for a scroll
// (pointercancel), and one that strays past the slop is a scroll even
// where it doesn't.
export const touchKind = ({ cancelled = false, far = 0 } = {},
  slop = TAP_SLOP) => (cancelled || far > slop ? "scroll" : "tap");
