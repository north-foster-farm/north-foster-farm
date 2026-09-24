// The site's own videos: short, silent clips that play on a loop once
// they are on screen, with a play/pause button over each. Whether they
// may start by themselves is one preference for the whole site, which
// the hero's "stop videos playing on their own" offer (#133) sets.

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

const wire = (frame, observer) => {
  const video = frame.querySelector("video");
  const toggle = frame.querySelector("[data-video-toggle]");

  const show = () => {
    const playing = !video.paused;

    frame.dataset.playing = playing ? "true" : "false";
    toggle.setAttribute("aria-label", playing ? "Pause video" : "Play video");
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
      } else if (started.has(target)
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
