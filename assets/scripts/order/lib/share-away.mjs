// Whether a tap or a focus at `target` is outside the cart's open
// shared row (#203), so the row should fold. A focus on an ancestor of
// the row is not: Safari does not focus a button it taps, so a tap on
// a pick focuses the nearest focusable ancestor, the cart itself
// (tabindex -1, #337), and folding the row then would take the pick
// out from under the tap (#383). A tap on the ancestor still folds.
// Nor is an open dialog: the join dialog (#495) asks on the row's
// behalf, and Cancel hands the focus back to Apply, which a folded row
// would have hidden.
export function awayFrom(share, target, focus = false) {
  if (!share.dataset.share || share.contains(target)) return false;
  if (target.closest && target.closest("dialog[open]")) return false;

  return !(focus && target.contains(share));
}
