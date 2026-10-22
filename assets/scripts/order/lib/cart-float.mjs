// The floating cart's state below xl, kept apart from the DOM so the
// rules can be tested.

// What the cart becomes when it lifts off its settled place on the way
// back up (#274, round 5): hidden, on its lines, whatever it was when
// it settled. Settled, both parts are open; left so, a tablet's total
// row lit both of its pills.
export const FLOAT_AGAIN = Object.freeze({
  open: false, items: "open", money: "closed",
});

// True on the frame the settled cart starts to float again. `was` is
// the cart's data-stuck before this frame: "false" once settled,
// undefined before the first look.
export const floatsAgain = (was, floating) => was === "false" && floating;

// One look at the pane as the page scrolls: does it float? `last` is
// the last look's { stuck, floatH }. `place` is where the pane's top
// sits in the flow, under its heading; `height` its height now;
// `room` the foot of the screen less the margin it rests on.
//
// Settled, the pane shows every line, so its own height cannot
// decide: taller, it would float, take the cap and settle, over and
// over. The height it last had floating decides instead, measured
// only while it floats and is not easing (`easing`). On settling,
// that becomes its hidden height (`hidden()`, measured then), since
// it lifts off hidden: judged by its open height it would lift off
// too soon, hide, settle again, open and lift off once more.
export const look = (last, { place, height, room, easing, hidden }) => {
  const floatH = last.stuck !== "false" && !easing ? height : last.floatH;
  const floating = place + Math.min(floatH || height, height) > room;

  return {
    stuck: String(floating),
    floatH: last.stuck === "true" && !floating ? hidden() : floatH,
  };
};

// Which of the total row's two controls show as on. On a phone they
// are tabs and one shows at a time, the lines first; from md each
// folds its own part.
export const segOn = ({ items, money }, narrow) => ({
  items: items === "open",
  money: money === "open" && !(narrow && items === "open"),
});
