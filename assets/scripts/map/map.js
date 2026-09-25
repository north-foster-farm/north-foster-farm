// The delivery map (partials/map.html), made to answer.
//
// - A ZIP names its town and whether we deliver there as the pointer
//   passes over it; a tap on it puts it in the map's ZIP check, which
//   answers in words and announces an nff:zip event.
// - On nff:zip, from any check on the page, the map outlines that ZIP
//   and drops a pin onto its middle, coloured by the answer.
// - A pin, or its line in the key, opens a card with the details.
// - It zooms with its buttons, a pinch (a trackpad's too), a double
//   click or ctrl and the wheel, and pans with a drag once zoomed. At
//   full size a swipe still scrolls the page.
//
// Wording of the labels is a draft for James (#138).

const LABELS = {
  ok: "We deliver here",
  wait: "A little outside our area",
  no: "Outside our area",
};

const TONE_OF = { "is-ours": "ok", "is-away": "wait", "is-land": "no" };

const MAX_ZOOM = 5;

// Pins stand this tall on screen at any zoom and any width; the shape
// is drawn 45 units tall.
const PIN_PX = 38;
const PIN_UNITS = 45;

// A pointer that moves further than this is dragging, not tapping.
const SLOP = 6;

// Labels near an edge grow inward rather than off the map.
const EDGE = 160;

// The ZIP a shape stands for. The markup writes it after a "z": the
// minifier reads a bare "02825" in an SVG as a number and drops its
// leading zero.
const zipOf = (area) => area.dataset.zip.slice(1);

const toneOf = (area) => {
  for (const [name, tone] of Object.entries(TONE_OF)) {
    if (area.classList.contains(name)) return tone;
  }
  return "no";
};

const easeOut = (t) => 1 - (1 - t) ** 3;

const wire = (map) => {
  const frame = map.querySelector("[data-map-frame]");
  const svg = map.querySelector("[data-map-svg]");
  const tip = map.querySelector("[data-map-tip]");
  const drop = map.querySelector("[data-map-drop]");
  const dropAt = map.querySelector("[data-map-drop-at]");
  const zoomIn = map.querySelector("[data-map-zoom='in']");
  const zoomOut = map.querySelector("[data-map-zoom='out']");
  const reset = map.querySelector("[data-map-zoom='reset']");
  const pins = [...map.querySelectorAll("[data-map-pin]")];
  // A pin by its number in the key; the markup draws them in
  // reverse, so what is on now lies on top.
  const pinOf = (n) => map.querySelector(`[data-map-pin="${n}"]`);
  const pick = map.querySelector("[data-map-pick]");
  const form = map.querySelector("[data-zip-check]");
  const full = svg.viewBox.baseVal;
  const W = full.width;
  const H = full.height;
  let view = { x: 0, y: 0, w: W, h: H };
  let open = null;
  let tween = 0;
  // True while the view animates, when a pin may be on its way in.
  let moving = false;

  // The pointers down on the map, for drags and pinches.
  const pointers = new Map();
  let dragging = false;
  let startView = null;
  let startPoint = null;
  let startSpread = 0;

  // The view: the viewBox, and everything that must keep its size on
  // screen whatever the zoom (pins, the dropped pin, the open card).

  const zoom = () => W / view.w;

  const clamp = (v) => {
    const w = Math.min(W, Math.max(W / MAX_ZOOM, v.w));
    const h = w * (H / W);

    return {
      w,
      h,
      x: Math.min(W - w, Math.max(0, v.x)),
      y: Math.min(H - h, Math.max(0, v.y)),
    };
  };

  const place = () => {
    if (!open) return;

    const pin = pinOf(open.dataset.mapCard);
    const box = frame.getBoundingClientRect();
    const x = (pin.dataset.x - view.x) / view.w * box.width;
    const y = (pin.dataset.y - view.y) / view.h * box.height;

    // A pin panned out of view takes its card with it, once the
    // view has come to rest.
    if (x < 0 || x > box.width || y < 0 || y > box.height) {
      if (moving) return;
      open.hidden = true;
      pin.setAttribute("aria-pressed", "false");
      open = null;
      return;
    }

    const half = open.offsetWidth / 2;
    const left = Math.min(box.width - half - 8, Math.max(half + 8, x));
    // Above the pin where there is room, else below it, and never off
    // the bottom of the map.
    // The farm marker stands 62 units to the others' 45.
    const tall = (pin.classList.contains("map-pin-farm") ? 62 / 45 : 1)
      * PIN_PX + 4;
    const above = y - tall - open.offsetHeight > 8;
    const below = Math.max(8,
      Math.min(y + 10, box.height - open.offsetHeight - 8));

    open.style.left = `${left}px`;
    open.style.top = `${above ? y - tall : below}px`;
    open.style.transform = above
      ? "translate(-50%, -100%)"
      : "translate(-50%, 0)";
  };

  const apply = () => {
    const k = zoom();
    const width = svg.getBoundingClientRect().width || W;
    const s = (PIN_PX / PIN_UNITS * view.w / width).toFixed(4);

    svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
    for (const pin of pins) {
      pin.setAttribute("transform",
        `translate(${pin.dataset.x} ${pin.dataset.y}) scale(${s})`);
    }
    if (dropAt.dataset.x) {
      dropAt.setAttribute("transform",
        `translate(${dropAt.dataset.x} ${dropAt.dataset.y}) scale(${s})`);
    }
    zoomIn.disabled = k >= MAX_ZOOM - 0.01;
    zoomOut.disabled = k <= 1.01;
    reset.hidden = k <= 1.01;
    // Zoomed in, a drag pans the map; at full size it scrolls the page.
    svg.style.touchAction = k > 1.01 ? "none" : "pan-y";
    place();
  };

  const go = (target, animate = true) => {
    const to = clamp(target);

    cancelAnimationFrame(tween);
    if (!animate || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      view = to;
      moving = false;
      apply();
      return;
    }

    const from = { ...view };
    const start = performance.now();
    const step = (now) => {
      const t = easeOut(Math.min(1, (now - start) / 220));

      view = {
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        w: from.w + (to.w - from.w) * t,
        h: from.h + (to.h - from.h) * t,
      };
      moving = t < 1;
      apply();
      if (t < 1) tween = requestAnimationFrame(step);
    };

    moving = true;
    tween = requestAnimationFrame(step);
  };

  // Zoom by a factor about a point in map units.
  const zoomAbout = (factor, px, py, animate) => {
    const w = view.w / factor;
    const h = view.h / factor;

    go({
      w,
      h,
      x: px - (px - view.x) / factor,
      y: py - (py - view.y) / factor,
    }, animate);
  };

  // A point on screen in map units.
  const toMap = (clientX, clientY) => {
    const box = svg.getBoundingClientRect();

    return {
      x: view.x + (clientX - box.left) / box.width * view.w,
      y: view.y + (clientY - box.top) / box.height * view.h,
    };
  };

  const centre = () => ({ x: view.x + view.w / 2, y: view.y + view.h / 2 });

  zoomIn.addEventListener("click", () => {
    const c = centre();

    zoomAbout(2, c.x, c.y, true);
  });
  zoomOut.addEventListener("click", () => {
    const c = centre();

    zoomAbout(0.5, c.x, c.y, true);
  });
  reset.addEventListener("click", () => go({ x: 0, y: 0, w: W, h: H }));

  // A trackpad pinch arrives as the wheel with ctrl held.
  svg.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();

    const p = toMap(e.clientX, e.clientY);

    zoomAbout(Math.exp(-e.deltaY * 0.01), p.x, p.y, false);
  }, { passive: false });

  svg.addEventListener("dblclick", (e) => {
    e.preventDefault();
    const p = toMap(e.clientX, e.clientY);

    zoomAbout(2, p.x, p.y, true);
  });

  // Cards.

  const close = () => {
    if (!open) return;
    open.hidden = true;
    pinOf(open.dataset.mapCard)
      .setAttribute("aria-pressed", "false");
    open = null;
  };

  const show = (n, { focus = false, centreOn = false } = {}) => {
    const card = map.querySelector(`[data-map-card="${n}"]`);
    const pin = pinOf(n);

    if (open === card) {
      close();
      return;
    }
    close();
    open = card;
    card.hidden = false;
    pin.setAttribute("aria-pressed", "true");
    if (centreOn && zoom() > 1.01) {
      go({
        ...view,
        x: pin.dataset.x - view.w / 2,
        y: pin.dataset.y - view.h / 2,
      });
    }
    place();
    if (focus) card.querySelector(".map-card-name").focus();
  };

  for (const pin of pins) {
    pin.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      show(Number(pin.dataset.mapPin), { focus: true });
    });
  }

  for (const button of map.querySelectorAll("[data-map-show]")) {
    button.addEventListener("click", () => {
      show(Number(button.dataset.mapShow), { centreOn: true });
      // On a phone the key is below the map; bring the map back.
      const box = frame.getBoundingClientRect();

      if (box.top < 0 || box.bottom > innerHeight) {
        frame.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    });
  }

  for (const button of map.querySelectorAll("[data-map-card-close]")) {
    button.addEventListener("click", () => {
      const n = open && open.dataset.mapCard;

      close();
      if (n) pinOf(n).focus();
    });
  }

  map.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !open) return;

    const n = open.dataset.mapCard;

    close();
    pinOf(n).focus();
  });

  // The tip: a ZIP's town and answer, beside the pointer.

  const hideTip = () => {
    tip.hidden = true;
  };

  svg.addEventListener("pointermove", (e) => {
    const area = e.pointerType === "mouse" && e.target.closest("[data-zip]");

    if (!area || dragging) {
      hideTip();
      return;
    }

    const box = frame.getBoundingClientRect();
    const town = area.dataset.town ? `${area.dataset.town}, ` : "";

    tip.textContent = `${town}${zipOf(area)}: ${LABELS[toneOf(area)]}`;
    tip.hidden = false;
    tip.style.left = `${e.clientX - box.left}px`;
    tip.style.top = `${e.clientY - box.top}px`;
    tip.style.transform = e.clientX - box.left > box.width / 2
      ? "translate(calc(-100% - 12px), 12px)"
      : "translate(12px, 12px)";
  });
  svg.addEventListener("pointerleave", hideTip);

  // A tap on a ZIP runs the check; a tap on a pin opens its card; a
  // tap on anything else closes the card.
  const tap = (target) => {
    const pin = target.closest("[data-map-pin]");

    if (pin) {
      show(Number(pin.dataset.mapPin));
      return;
    }
    close();

    const area = target.closest("[data-zip]");

    if (!area) return;
    if (form) {
      const input = form.querySelector("[name='zip']");

      input.value = zipOf(area);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      document.dispatchEvent(new CustomEvent("nff:zip", {
        detail: { zip: zipOf(area), tone: toneOf(area) },
      }));
    }
  };

  // Drags and pinches, from pointer events so mouse, pen and touch
  // share one path.
  const spread = () => {
    const [a, b] = [...pointers.values()];

    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  const middle = () => {
    const [a, b] = [...pointers.values()];

    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  svg.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    startView = { ...view };
    startPoint = { x: e.clientX, y: e.clientY };
    dragging = false;
    if (pointers.size === 2) startSpread = spread();
  });

  svg.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const box = svg.getBoundingClientRect();
    const perPixel = view.w / box.width;

    if (pointers.size === 2) {
      dragging = true;
      const m = middle();
      const factor = spread() / startSpread;
      const p = toMap(m.x, m.y);

      zoomAbout(factor, p.x, p.y, false);
      startSpread = spread();
      return;
    }

    const dx = e.clientX - startPoint.x;
    const dy = e.clientY - startPoint.y;

    if (!dragging && Math.hypot(dx, dy) < SLOP) return;
    if (zoom() <= 1.01) return;
    if (!dragging) svg.setPointerCapture(e.pointerId);
    dragging = true;
    go({
      ...startView,
      x: startView.x - dx * perPixel,
      y: startView.y - dy * perPixel,
    }, false);
  });

  const up = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (e.type === "pointerup" && !dragging && pointers.size === 0) {
      tap(e.target);
    }
    if (pointers.size === 0) {
      setTimeout(() => {
        dragging = false;
      });
    } else {
      startView = { ...view };
      const [rest] = [...pointers.values()];

      startPoint = rest;
    }
  };

  svg.addEventListener("pointerup", up);
  svg.addEventListener("pointercancel", up);

  // The dropped pin, from any ZIP check on the page.

  document.addEventListener("nff:zip", (e) => {
    const { zip, tone } = e.detail;
    const area = zip && LABELS[tone]
      && svg.querySelector(`[data-zip="z${CSS.escape(zip)}"]`);

    // SVG elements have no hidden property, so the attribute it is.
    if (!area) {
      drop.setAttribute("hidden", "");
      pick.setAttribute("hidden", "");
      return;
    }

    const { x, y } = area.dataset;
    const label = map.querySelector("[data-map-drop-label]");
    let anchor = "middle";

    if (x < EDGE) anchor = "start";
    if (x > W - EDGE) anchor = "end";
    label.setAttribute("text-anchor", anchor);
    label.setAttribute("x", { start: -15, middle: 0, end: 15 }[anchor]);
    const town = area.dataset.town ? ` ${area.dataset.town}` : "";

    label.textContent = `${zip}${town}: ${LABELS[tone]}`;

    pick.setAttribute("d", area.getAttribute("d"));
    pick.removeAttribute("hidden");
    dropAt.dataset.x = x;
    dropAt.dataset.y = y;
    drop.dataset.tone = tone;
    apply();

    // Hidden and shown again, with a layout between, the pin falls anew.
    drop.setAttribute("hidden", "");
    drop.getBoundingClientRect();
    drop.removeAttribute("hidden");
  });

  addEventListener("resize", apply);
  apply();
};

export const wireMaps = () => {
  for (const map of document.querySelectorAll("[data-map]")) wire(map);
};
