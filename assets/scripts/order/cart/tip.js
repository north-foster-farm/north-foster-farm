// A cart tooltip, shut at once, with no fade (#569): one that faded
// while the page moved was drawn away from its badge. Bootstrap has no
// option for one hide alone, so its animation flag is set aside for
// this one. Shared by the discount badges and the perks' info buttons
// (perk-label.js, #717).
//
// A show still fading in waits on a transitionend, or Bootstrap's
// timer standing in for one, to finish (#644). Left waiting, that end
// came after the tooltip was gone and cancelled the next tap's show.
// The event Bootstrap's own timer would send ends it now; it goes to
// nothing when no show waits. Only a shown tip gets it: Bootstrap's
// show() builds a new tip each time, so a shown tip's only pending end
// is its show's. A hide fading out would end too, and its end drops
// the tip, leaving nothing to hide.
export const shutTip = (tip) => {
  if (!tip.tip) return;

  const animated = tip._config.animation;

  try {
    if (tip.tip.classList.contains("show")) {
      tip.tip.dispatchEvent(new Event("transitionend"));
    }
    tip._config.animation = false;
    tip.tip?.classList.remove("fade");
    tip.hide();
  } finally {
    tip._config.animation = animated;
  }
};
