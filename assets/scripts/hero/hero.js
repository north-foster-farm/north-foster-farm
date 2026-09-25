// The home hero's coop video. The photograph under it is its poster,
// so nothing loads until that has painted; the clip then plays while
// the hero is on screen, where Autoplay allows, and fades in over the
// photograph once frames are coming. A pause offers, once, to stop
// every video on the site playing on its own.

import { Autoplay, autoplayOffer } from "../video/video.js";

// Two frames on, the poster is on screen, not only decoded.
const afterPaint = (img) => img.decode()
  .catch(() => {})
  .then(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));

export const wireHeroVideo = () => {
  const hero = document.querySelector("[data-hero-video]");

  if (!hero) return;

  const video = hero.querySelector("video");
  const toggle = hero.querySelector("[data-hero-toggle]");
  const note = autoplayOffer(hero.querySelector("[data-autoplay-note]"));

  // The visitor paused it: it stays paused. The visitor started it:
  // it plays again when back on screen, whatever the preference.
  let held = false;
  let started = false;
  let loaded = false;

  const play = () => {
    if (!loaded) {
      loaded = true;
      for (const source of video.querySelectorAll("source[data-src]")) {
        source.src = source.dataset.src;
      }
      video.load();
    }
    video.play().catch(() => {});
  };

  const show = () => {
    const playing = !video.paused;

    hero.dataset.playing = playing ? "true" : "false";
    toggle.setAttribute("aria-label", playing ? "Pause video" : "Play video");
    if (playing) note.hide();
  };

  video.addEventListener("play", show);
  video.addEventListener("pause", show);
  video.addEventListener("playing", () => hero.classList.add("is-ready"), {
    once: true,
  });

  toggle.addEventListener("click", () => {
    if (video.paused) {
      held = false;
      started = true;
      play();
      return;
    }
    held = true;
    started = false;
    video.pause();
    note.show();
  });

  document.addEventListener("nff:autoplay", (e) => {
    if (e.detail.on) return;
    started = false;
    video.pause();
  });

  hero.querySelector("[data-hero-controls]").hidden = false;
  show();

  afterPaint(hero.querySelector(".home-hero-img")).then(() => {
    // Play while on screen, pause once scrolled away.
    new IntersectionObserver(([{ isIntersecting }]) => {
      if (!isIntersecting) {
        video.pause();
      } else if (started || (!held && Autoplay.allowed())) {
        play();
      }
    }).observe(hero);
  });
};
