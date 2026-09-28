// The site's own videos: short, silent clips that play on a loop once
// they are on screen, with a play/pause button over each. Whether they
// may start by themselves is one preference for the whole site, which
// the switch beside each button turns off and on again (#133, #200).

const KEY = "nff:autoplay";

// Frames the visitor paused: they stay paused, even scrolled away and
// back.
const held = new WeakSet();

// Frames the visitor started: they play again when back on screen,
// whatever the preference.
const started = new WeakSet();

// Frames at least half on screen.
const onScreen = new WeakSet();

export const Autoplay = {
  // "on" or "off" if the visitor chose, else null.
  stored() {
    try {
      const value = localStorage.getItem(KEY);

      return value === "on" || value === "off" ? value : null;
    } catch {
      // Storage refused (private mode, blocked site data): no choice
      // saved.
      return null;
    }
  },

  // What the visitor chose, if they did. Otherwise off when they asked
  // their system for less motion or their browser to save data.
  allowed() {
    const stored = Autoplay.stored();

    if (stored === "off") return false;
    if (stored === "on") return true;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
    if (navigator.connection && navigator.connection.saveData) return false;

    return true;
  },

  // `from` says who changed it: "switch" (a video's switch), "account"
  // (the account page, which saves it itself) or "sync" (the account's
  // value, adopted). Only a switch's change is saved to the account.
  set(on, { from = "switch" } = {}) {
    try {
      localStorage.setItem(KEY, on ? "on" : "off");
    } catch {
      // Nowhere to keep it; this page still honours the click.
    }
    document.dispatchEvent(new CustomEvent("nff:autoplay", {
      detail: { on, from },
    }));
  },
};

// The switch beside a video's button, in step with the preference on
// every video on the page. It says what a press will do. A press of
// play or pause shows it (the frame's data-reveal), and it fades with
// the controls; it is never taken out of the page, so the keyboard
// and screen readers always reach it. Play and pause never change it.
export const autoplaySwitch = (frame) => {
  const button = frame.querySelector("[data-autoplay-switch]");
  const words = button.querySelector("[data-autoplay-words]");

  const show = () => {
    const on = Autoplay.allowed();

    button.setAttribute("aria-checked", on ? "true" : "false");
    words.textContent = on ? "Turn autoplay off" : "Turn autoplay on";
  };

  button.addEventListener("click", () => {
    Autoplay.set(!Autoplay.allowed());
  });
  document.addEventListener("nff:autoplay", show);
  show();

  return {
    reveal() {
      frame.dataset.reveal = "true";
    },
  };
};

const IDLE_MS = 5000;

// The controls fade almost away five seconds after the last touch,
// tap or mouse movement on the video, and come back with the next.
// The autoplay switch fades with them and waits for the next press of
// play or pause. Returns the wake, for when the video comes back on
// screen.
export const fadeWhenIdle = (frame) => {
  let timer;

  const wake = () => {
    frame.dataset.idle = "false";
    clearTimeout(timer);
    timer = setTimeout(() => {
      frame.dataset.idle = "true";
      delete frame.dataset.reveal;
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
  const autoplay = autoplaySwitch(frame);

  wakes.set(frame, fadeWhenIdle(frame));

  const show = () => {
    const playing = !video.paused;

    frame.dataset.playing = playing ? "true" : "false";
    toggle.setAttribute("aria-label", playing ? "Pause video" : "Play video");
  };

  video.addEventListener("play", show);
  video.addEventListener("pause", show);
  toggle.addEventListener("click", () => {
    autoplay.reveal();
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
        onScreen.delete(target);
        video.pause();
        continue;
      }
      onScreen.add(target);
      wakes.get(target)();
      if (started.has(target)
        || (!held.has(target) && Autoplay.allowed())) {
        video.play().catch(() => {});
      }
    }
  }, { threshold: 0.5 });

  for (const frame of frames) wire(frame, observer);

  // Turned off, whatever plays on its own stops; turned on, what is on
  // screen and not paused by the visitor starts.
  document.addEventListener("nff:autoplay", (e) => {
    for (const frame of frames) {
      const video = frame.querySelector("video");

      if (!e.detail.on) {
        if (!started.has(frame)) video.pause();
      } else if (!held.has(frame) && onScreen.has(frame)) {
        video.play().catch(() => {});
      }
    }
  });
};
