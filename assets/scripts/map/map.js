// The map (partials/map.html), made to answer, in two layers (#214).
//
// Delivery:
// - A tap on a town puts its ZIP in the ZIP field on the map, which
//   answers to screen readers and announces an nff:zip event.
// - On nff:zip, from any check on the page, the map outlines that ZIP
//   and drops its one pin onto its middle, with a tag: the town, an
//   egg and a hen (struck through where we don't deliver them) and the
//   delivery price, or "No delivery" and a way to the Places layer.
// - With a mouse, the pointer over a town shows the same tag.
// - A second tap on that town, or a tap on water or on a neighbouring
//   state, clears the check, the pin and the outline (M1).
//
// Places:
// - A pin, or its name in the list beside the map, opens a card with
//   the details. The farm and the Foster market stand apart at the
//   whole map. A place, or a line on its card, past its date goes.
// - The top bar's link to a pop-up, #place-…, opens its card.
//
// Both: it zooms with its buttons, a pinch (a trackpad's too), a
// double click (not a double tap) or ctrl and the wheel, and pans with
// a drag once zoomed. At full size a swipe still scrolls the page.
//
// Wording is a draft for James (#138, #214).

const MAX_ZOOM = 5;

// Pins stand this tall on screen at any zoom and any width; the shape
// is drawn 45 units tall and 30 wide.
const PIN_PX = 38;
const PIN_UNITS = 45;

// Below this zoom, a nudged pin stands this far aside, in screen
// pixels, so two places that meet at the whole map can both be tapped.
const NUDGE_BELOW = 2;
const NUDGE_PX = 14;

// A pointer that moves further than this is dragging, not tapping.
const SLOP = 6;

// How far the tag and the cards keep from the frame's edges.
const MARGIN = 8;

// The ZIP a shape stands for. The markup writes it after a "z": the
// minifier reads a bare "02825" in an SVG as a number and drops its
// leading zero.
const zipOf = (area) => area.dataset.zip.slice(1);

const toneOf = (area) => {
  if (area.classList.contains("is-ours")) return "ok";
  if (area.classList.contains("is-away")) return "wait";
  return "no";
};

const easeOut = (t) => 1 - (1 - t) ** 3;

// Today on the visitor's clock, to compare with the dates in the
// markup.
const today = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// What has ended, or not begun, goes: a card's line, a name in the
// list, a pin. A card left with one line takes that line's kind.
const expire = (map) => {
  const day = today();
  const gone = (el) => (el.dataset.until && el.dataset.until < day)
    || (el.dataset.from && el.dataset.from > day);

  for (const line of map.querySelectorAll(".map-card-when [data-until]")) {
    if (!gone(line)) continue;
    const card = line.closest("[data-map-card]");

    if (line.dataset.alone) {
      card.querySelector("[data-map-card-kind]").textContent =
        line.dataset.alone;
      for (const link of card.querySelectorAll(".map-card-links a")) {
        if (link.textContent.startsWith("Market ")) link.remove();
      }
    }
    line.remove();
  }
  for (const el of map.querySelectorAll(
    ".map-places [data-until], .map-places [data-from]"
  )) {
    if (gone(el)) el.remove();
  }
  for (const pin of map.querySelectorAll("[data-map-pin]")) {
    if (gone(pin)) pin.remove();
  }
};

const wire = (map) => {
  expire(map);

  const frame = map.querySelector("[data-map-frame]");
  const svg = map.querySelector("[data-map-svg]");
  const drop = map.querySelector("[data-map-drop]");
  const dropAt = map.querySelector("[data-map-drop-at]");
  const tag = map.querySelector("[data-map-drop-tag]");
  const zoomIn = map.querySelector("[data-map-zoom='in']");
  const zoomOut = map.querySelector("[data-map-zoom='out']");
  const reset = map.querySelector("[data-map-zoom='reset']");
  const tabs = [...map.querySelectorAll("[data-map-layer]")];
  const pins = [...map.querySelectorAll("[data-map-pin]")];
  const pinOf = (n) => map.querySelector(`[data-map-pin="${n}"]`);
  const picks = [...map.querySelectorAll("[data-map-pick]")];
  const form = map.querySelector("[data-zip-check]");
  const full = svg.viewBox.baseVal;
  const W = full.width;
  const H = full.height;
  let view = { x: 0, y: 0, w: W, h: H };
  let open = null;
  let tween = 0;
  // True while the view animates, when a pin may be on its way in.
  let moving = false;
  // The ZIP the dropped pin stands on.
  let picked = null;

  // The tag beside the pointer: the dropped pin's tag, copied, without
  // its link, which the pointer could never reach.
  const tip = tag.cloneNode(true);

  tip.removeAttribute("data-map-drop-tag");
  for (const el of tip.querySelectorAll("*")) {
    for (const name of Object.keys(el.dataset)) delete el.dataset[name];
  }
  tip.querySelector(".map-tag-link").remove();
  tip.classList.add("is-tip");
  tip.setAttribute("aria-hidden", "true");
  frame.append(tip);

  // The pointers down on the map, for drags and pinches.
  const pointers = new Map();
  let dragging = false;
  let startView = null;
  let startPoint = null;
  let startSpread = 0;

  // The view: the viewBox, and everything that must keep its size on
  // screen whatever the zoom (pins, the dropped pin and its tag, the
  // open card).

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

  // A point in map units on screen, in pixels from the frame's corner.
  const onScreen = (x, y) => {
    const box = svg.getBoundingClientRect();

    return {
      x: (x - view.x) / view.w * box.width,
      y: (y - view.y) / view.h * box.height,
      width: box.width,
      height: box.height,
    };
  };

  // A pin's tip on screen, nudged aside at the whole map.
  const tipOf = (pin) => {
    const at = onScreen(Number(pin.dataset.x), Number(pin.dataset.y));
    const nudge = zoom() < NUDGE_BELOW ? Number(pin.dataset.nudge || 0) : 0;

    return { ...at, x: at.x + nudge * NUDGE_PX };
  };

  // Above a point where there is room, else below it, never past an
  // edge: an element over the map, "lift" pixels above its tip.
  const stand = (el, at, lift) => {
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(MARGIN, Math.min(at.width - w - MARGIN,
      at.x - w / 2));
    const above = at.y - lift - 6 - h;
    const top = Math.max(MARGIN, Math.min(at.height - h - MARGIN,
      above >= MARGIN ? above : at.y + MARGIN));

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  };

  const place = () => {
    if (!open) return;

    const at = tipOf(pinOf(open.dataset.mapCard));

    // A pin panned out of view takes its card with it, once the
    // view has come to rest.
    if (at.x < 0 || at.x > at.width || at.y < 0 || at.y > at.height) {
      if (moving) return;
      close();
      return;
    }
    stand(open, at, PIN_PX);
  };

  const placeTag = () => {
    if (tag.hidden || !dropAt.dataset.x) return;

    const at = onScreen(Number(dropAt.dataset.x), Number(dropAt.dataset.y));

    tag.style.visibility = at.x < 0 || at.x > at.width || at.y < 0
      || at.y > at.height ? "hidden" : "";
    stand(tag, at, PIN_PX);
  };

  const apply = () => {
    const k = zoom();
    const width = svg.getBoundingClientRect().width || W;
    const units = view.w / width;
    const s = (PIN_PX / PIN_UNITS * units).toFixed(4);
    const nudged = k < NUDGE_BELOW;

    svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
    for (const pin of pins) {
      const dx = nudged ? Number(pin.dataset.nudge || 0) * NUDGE_PX * units
        : 0;

      pin.setAttribute("transform", `translate(${Number(pin.dataset.x) + dx} `
        + `${pin.dataset.y}) scale(${s})`);
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
    placeTag();
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

  // A double tap is two taps: picking towns quickly must not zoom.
  let touched = false;

  svg.addEventListener("pointerdown", (e) => {
    touched = e.pointerType === "touch";
  });
  svg.addEventListener("dblclick", (e) => {
    e.preventDefault();
    if (touched) return;
    const p = toMap(e.clientX, e.clientY);

    zoomAbout(2, p.x, p.y, true);
  });

  // Layers.

  const layer = () => map.dataset.layer;

  function setLayer(name) {
    if (!tabs.length || layer() === name) return;
    map.dataset.layer = name;
    for (const t of tabs) {
      const on = t.dataset.mapLayer === name;

      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      if (on) frame.setAttribute("aria-labelledby", t.id);
    }
    for (const el of map.querySelectorAll("[data-map-for]")) {
      el.hidden = el.dataset.mapFor !== name;
    }
    if (name === "delivery") close();
    hideTip();
    apply();
  }

  for (const [i, t] of tabs.entries()) {
    t.addEventListener("click", () => setLayer(t.dataset.mapLayer));
    t.addEventListener("keydown", (e) => {
      const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];

      if (!d) return;
      const next = tabs[(i + d + tabs.length) % tabs.length];

      setLayer(next.dataset.mapLayer);
      next.focus();
    });
  }

  // Cards.

  const pressed = (n) => {
    for (const pin of pins) {
      pin.setAttribute("aria-pressed", String(pin.dataset.mapPin === n));
    }
    for (const b of map.querySelectorAll("[data-map-show]")) {
      b.setAttribute("aria-pressed", String(b.dataset.mapShow === n));
    }
  };

  function close() {
    if (!open) return;
    open.hidden = true;
    open = null;
    pressed(null);
    // The selected pin painted last; back in its place.
    for (const pin of pins) pin.parentNode.append(pin);
  }

  const show = (n, { focus = false, centreOn = false } = {}) => {
    const card = map.querySelector(`[data-map-card="${n}"]`);
    const pin = pinOf(n);

    if (!card || !pin) return;
    if (open === card) {
      close();
      return;
    }
    close();
    setLayer("places");
    open = card;
    card.hidden = false;
    pressed(String(n));
    // SVG paints in source order: the selected pin goes on top.
    pin.parentNode.append(pin);
    if (centreOn && zoom() > 1.01) {
      go({
        ...view,
        x: Number(pin.dataset.x) - view.w / 2,
        y: Number(pin.dataset.y) - view.h / 2,
      });
    }
    place();
    if (focus) card.querySelector(".map-card-name").focus();
  };

  for (const pin of pins) {
    pin.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      show(pin.dataset.mapPin, { focus: true });
    });
  }

  // On a phone the list is below the map; bring the map back.
  const bringBack = () => {
    const box = frame.getBoundingClientRect();

    if (box.top < 0 || box.bottom > innerHeight) {
      frame.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  };

  for (const button of map.querySelectorAll("[data-map-show]")) {
    button.addEventListener("click", () => {
      show(button.dataset.mapShow, { centreOn: true });
      bringBack();
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

  // The tag: the town, what we deliver there and the price. "el" is
  // the dropped pin's tag or the pointer's.
  const fill = (el, area) => {
    const tone = toneOf(area);
    const fee = Number(tag.dataset.fee)
      + (tone === "wait" ? Number(tag.dataset.extra) : 0);
    const has = {
      eggs: tone !== "no",
      hen: tone !== "no" && !area.classList.contains("is-eggs"),
    };
    const [town, eggs, hen, price, none] = [
      ".map-tag-town", ".map-tag-icon:nth-of-type(1)",
      ".map-tag-icon:nth-of-type(2)", ".map-tag-fee", ".map-tag-none",
    ].map((s) => el.querySelector(s));

    town.textContent = area.dataset.town || zipOf(area);
    price.textContent = tone === "no" ? "" : `$${fee}`;
    price.hidden = tone === "no";
    none.hidden = tone !== "no";
    for (const [icon, on] of [[eggs, has.eggs], [hen, has.hen]]) {
      icon.classList.toggle("is-off", !on);
      if (el === tag) icon.dataset.on = on;
    }
    const link = el.querySelector(".map-tag-link");

    if (link) link.hidden = tone !== "no";
  };

  // The tag beside the pointer, over a town, with a mouse.

  function hideTip() {
    tip.hidden = true;
  }

  svg.addEventListener("pointermove", (e) => {
    const area = layer() === "delivery" && e.pointerType === "mouse"
      && e.target.closest("[data-zip]");

    if (!area || dragging || zipOf(area) === picked) {
      hideTip();
      return;
    }

    const box = frame.getBoundingClientRect();
    const x = e.clientX - box.left;
    const y = e.clientY - box.top;

    fill(tip, area);
    tip.hidden = false;
    tip.style.left = `${x + 14}px`;
    tip.style.top = `${y + 14}px`;
    if (x + 14 + tip.offsetWidth > box.width - MARGIN) {
      tip.style.left = `${x - 14 - tip.offsetWidth}px`;
    }
    if (y + 14 + tip.offsetHeight > box.height - MARGIN) {
      tip.style.top = `${y - 14 - tip.offsetHeight}px`;
    }
  });
  svg.addEventListener("pointerleave", hideTip);

  // Puts a ZIP in the map's field, which answers and announces it, or
  // on a map without one announces it here. An empty ZIP clears.
  const check = (zip, tone) => {
    if (form) {
      const input = form.querySelector("[name='zip']");

      input.value = zip;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      document.dispatchEvent(new CustomEvent("nff:zip", {
        detail: { zip, tone },
      }));
    }
  };

  // Places: a tap on a pin opens its card; a tap anywhere else closes
  // one. Delivery: a tap on a town picks it, and a tap on the town
  // picked, on water or on a neighbouring state clears the pick.
  const tap = (target) => {
    if (layer() === "places") {
      const pin = target.closest("[data-map-pin]");

      if (pin) show(pin.dataset.mapPin);
      else close();
      return;
    }

    const area = target.closest("[data-zip]");

    if (!area || area.classList.contains("is-land")
      || zipOf(area) === picked) {
      if (picked) check("", "");
      return;
    }
    hideTip();
    check(zipOf(area), toneOf(area));
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
    const area = zip && tone
      && svg.querySelector(`[data-zip="z${CSS.escape(zip)}"]`);

    // SVG elements have no hidden property, so the attribute it is.
    if (!area) {
      picked = null;
      drop.setAttribute("hidden", "");
      tag.hidden = true;
      for (const p of picks) p.setAttribute("hidden", "");
      return;
    }

    picked = zip;
    setLayer("delivery");
    fill(tag, area);
    for (const p of picks) {
      p.setAttribute("d", area.getAttribute("d"));
      p.removeAttribute("hidden");
    }
    dropAt.dataset.x = area.dataset.x;
    dropAt.dataset.y = area.dataset.y;
    drop.dataset.tone = tone;

    // Hidden and shown again, with a layout between, the pin falls anew
    // and the tag fades in again.
    drop.setAttribute("hidden", "");
    tag.hidden = true;
    drop.getBoundingClientRect();
    drop.removeAttribute("hidden");
    tag.hidden = false;
    apply();
  });

  // "See pickup spots", on a map with the Places layer; on one without,
  // the link goes to the home page's.
  tag.querySelector("[data-map-to-places]").addEventListener("click", (e) => {
    if (!tabs.length) return;
    e.preventDefault();
    setLayer("places");
    tabs.find((t) => t.dataset.mapLayer === "places").focus();
  });

  // #places opens the Places layer; #place-… opens that place's card.
  const follow = () => {
    const hash = decodeURIComponent(location.hash.slice(1));

    if (!tabs.length || !hash.startsWith("place")) return;
    const pin = hash === "places" ? null
      : map.querySelector(`[data-map-slug="${CSS.escape(hash)}"]`);

    setLayer("places");
    if (pin) show(pin.dataset.mapPin);
    frame.scrollIntoView({ block: "center" });
  };

  // A link to the section holding the map ("Check your ZIP code") is
  // a link to its ZIP field, which sits at the map's foot: if the jump
  // leaves the field below the window, bring the map's foot up.
  const toField = () => {
    const hash = decodeURIComponent(location.hash.slice(1));
    const at = hash && document.getElementById(hash);
    const input = form && form.querySelector("[name='zip']");

    if (!input || !at || !at.contains(map)) return;
    if (input.getBoundingClientRect().bottom > innerHeight) {
      frame.scrollIntoView({ block: "end" });
    }
  };

  // A jump within the page scrolls smoothly: wait until it stops, two
  // frames at the same place, for a second and a half at most.
  const settled = (fn) => {
    const until = performance.now() + 1500;
    let last = null;
    const step = () => {
      if (scrollY === last || performance.now() > until) {
        fn();
        return;
      }
      last = scrollY;
      requestAnimationFrame(step);
    };

    requestAnimationFrame(step);
  };

  addEventListener("hashchange", () => {
    follow();
    settled(toField);
  });
  addEventListener("load", toField);
  addEventListener("resize", apply);
  apply();
  follow();
};

export const wireMaps = () => {
  for (const map of document.querySelectorAll("[data-map]")) wire(map);
};
