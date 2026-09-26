// The site's own videos: short, silent clips that play on a loop once
// they are on screen, with a play/pause button over each. Whether they
// may start by themselves is one preference for the whole site, which
// the offer after a pause sets, on any of them and the hero (#133).

const KEY = "nff:autoplay";

// Frames the visitor paused: they stay paused, even scrolled away and
// back.
const held = new WeakSet();

// Frames the visitor started: they play again when back on screen,
// whatever the preference.
const started = new WeakSet();

export const Autoplay = {
  // Off when the visitor turned it off, asked their system for less
  // motion, or asked their browser to save data.
  allowed() {
    let stored = null;

    try {
      stored = localStorage.getItem(KEY);
    } catch {
      // Storage refused (private mode, blocked site data): no choice
      // saved.
    }
    if (stored === "off") return false;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
    if (navigator.connection && navigator.connection.saveData) return false;

    return true;
  },

  set(on) {
    try {
      localStorage.setItem(KEY, on ? "on" : "off");
    } catch {
      // Nowhere to keep it; this page still honours the click.
    }
    document.dispatchEvent(new CustomEvent("nff:autoplay", {
      detail: { on },
    }));
  },
};

// The offer beside a video's button: after a pause, to stop every
// video on the site playing on its own; then its answer. Nothing to
// offer where videos already wait to be played.
export const autoplayOffer = (note) => {
  const offer = note.querySelector("[data-autoplay-offer]");
  const done = note.querySelector("[data-autoplay-done]");

  note.querySelector("[data-autoplay-off]").addEventListener("click", () => {
    Autoplay.set(false);
    offer.hidden = true;
    done.hidden = false;
  });

  return {
    show() {
      if (!Autoplay.allowed()) return;
      offer.hidden = false;
      done.hidden = true;
      note.hidden = false;
    },
    hide() {
      note.hidden = true;
    },
  };
};

const IDLE_MS = 5000;

// The controls fade almost away five seconds after the last touch,
// tap or mouse movement on the video, and come back with the next.
// Returns the wake, for when the video comes back on screen.
export const fadeWhenIdle = (frame) => {
  let timer;

  const wake = () => {
    frame.dataset.idle = "false";
    clearTimeout(timer);
    timer = setTimeout(() => {
      frame.dataset.idle = "true";
    }, IDLE_MS);
  };

  for (const type of ["pointermove", "pointerdown", "focusin"]) {
    frame.addEventListener(type, wake, { passive: true });
  }
  wake();

  return wake;
};

const wakes = new WeakMap();

const wire = (frame, observer) => {
  const video = frame.querySelector("video");
  const toggle = frame.querySelector("[data-video-toggle]");
  const note = autoplayOffer(frame.querySelector("[data-autoplay-note]"));

  wakes.set(frame, fadeWhenIdle(frame));

  const show = () => {
    const playing = !video.paused;

    frame.dataset.playing = playing ? "true" : "false";
    toggle.setAttribute("aria-label", playing ? "Pause video" : "Play video");
    if (playing) note.hide();
  };

  video.addEventListener("play", show);
  video.addEventListener("pause", show);
  toggle.addEventListener("click", () => {
    if (video.paused) {
      held.delete(frame);
      started.add(frame);
      video.play().catch(() => {});
    } else {
      held.add(frame);
      started.delete(frame);
      video.pause();
      note.show();
    }
  });
  show();
  observer.observe(frame);
};

export const wireVideos = () => {
  const frames = document.querySelectorAll("[data-video]");

  if (!frames.length) return;

  // Play what is on screen, pause what has left it.
  const observer = new IntersectionObserver((entries) => {
    for (const { target, isIntersecting } of entries) {
      const video = target.querySelector("video");

      if (!isIntersecting) {
        video.pause();
        continue;
      }
      wakes.get(target)();
      if (started.has(target)
        || (!held.has(target) && Autoplay.allowed())) {
        video.play().catch(() => {});
      }
    }
  }, { threshold: 0.5 });

  for (const frame of frames) wire(frame, observer);

  document.addEventListener("nff:autoplay", (e) => {
    if (e.detail.on) return;
    for (const frame of frames) frame.querySelector("video").pause();
  });
};
