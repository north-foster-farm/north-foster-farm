// The home hero's coop video. The photograph under it is its poster,
// so nothing loads until that has painted; the clip then plays while
// the hero is on screen, where Autoplay allows, and fades in over the
// photograph once frames are coming. Beside its button, the switch for
// whether every video on the site plays on its own.

import { Autoplay, autoplaySwitch, fadeWhenIdle } from "../video/video.js";

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
  const autoplay = autoplaySwitch(hero);

  // The visitor paused it: it stays paused. The visitor started it:
  // it plays again when back on screen, whatever the preference.
  let held = false;
  let started = false;
  let loaded = false;
  let onScreen = false;

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
  };

  video.addEventListener("play", show);
  video.addEventListener("pause", show);
  video.addEventListener("playing", () => hero.classList.add("is-ready"), {
    once: true,
  });

  toggle.addEventListener("click", () => {
    autoplay.reveal();
    if (video.paused) {
      held = false;
      started = true;
      play();
      return;
    }
    held = true;
    started = false;
    video.pause();
  });

  // Turned off, a clip playing on its own stops; turned on, it starts
  // if it is on screen and the visitor did not pause it.
  document.addEventListener("nff:autoplay", (e) => {
    if (!e.detail.on) {
      if (!started) video.pause();
    } else if (!held && onScreen) {
      play();
    }
  });

  hero.querySelector("[data-hero-controls]").hidden = false;
  show();

  const wake = fadeWhenIdle(hero);

  afterPaint(hero.querySelector(".home-hero-img")).then(() => {
    // Play while on screen, pause once scrolled away.
    new IntersectionObserver(([{ isIntersecting }]) => {
      onScreen = isIntersecting;
      if (!isIntersecting) {
        video.pause();
        return;
      }
      wake();
      if (started || (!held && Autoplay.allowed())) {
        play();
      }
    }).observe(hero);
  });
};
