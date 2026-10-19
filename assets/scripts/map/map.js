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
// - A second tap on that town, or a tap on water, clears the check,
//   the pin and the outline (M1). A town we don't deliver to, in
//   Connecticut or beyond, picks like any other, outlined in grey.
//
// Places:
// - A pin, or its row in the list beside the map, opens the place's
//   card in its row, one at a time. Each pin carries the number of its
//   row. The farm and the Foster market stand apart at the whole map.
//   A place, or a line on its card, past its date goes, and the rest
//   are numbered again.
// - The selected pin is lighter, with a glow, and its town is outlined
//   in the brand green, as Delivery outlines the ZIP picked.
// - The top bar's link to a pop-up, #place-…, opens its card.
//
// Places opens framed on its pins, and refits when they change;
// Delivery shows the whole state. The list beside the map scrolls when
// it runs longer than the map.
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
const PIN_WIDTH_PX = PIN_PX * 30 / PIN_UNITS;

// Places frames its pins with a pin's height to spare, and never closer
// than a town: one pin alone is shown at this zoom (#214).
const FIT_PAD_PX = PIN_PX;
const FIT_MAX_ZOOM = 4;

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

// What has ended, or not begun, goes: a card's line, a row in the
// list, a pin. A drop site left without its market loses the market's
// links.
const expire = (map) => {
  const day = today();
  const gone = (el) => (el.dataset.until && el.dataset.until < day)
    || (el.dataset.from && el.dataset.from > day);

  for (const line of map.querySelectorAll(".map-card-when [data-until]")) {
    if (!gone(line)) continue;
    const card = line.closest("[data-map-card]");

    if (line.dataset.alone) {
      const links = card.querySelector(".map-card-links");

      for (const a of links?.querySelectorAll("a") || []) {
        if (a.textContent.startsWith("Market ")) a.remove();
      }
      if (links && !links.querySelector("a")) {
        links.previousElementSibling.remove();
        links.remove();
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

// The numbers on the rows and the pins, in the order of the list: a
// place that has ended leaves no gap. The Scituate market's row wears
// the drop site's number, being its pin's.
const number = (map) => {
  const rows = [...map.querySelectorAll("[data-map-show]:not([data-also])")];
  const numbers = new Map(rows.map((row, i) => [row.dataset.mapShow, i + 1]));

  for (const el of map.querySelectorAll("[data-map-show], [data-map-pin]")) {
    const n = numbers.get(el.dataset.mapShow || el.dataset.mapPin);

    el.querySelector("[data-map-num], .map-pin-num").textContent = n;
  }
};

const wire = (map) => {
  expire(map);
  number(map);

  const frame = map.querySelector("[data-map-frame]");
  const svg = map.querySelector("[data-map-svg]");
  const drop = map.querySelector("[data-map-drop]");
  const dropAt = map.querySelector("[data-map-drop-at]");
  const tag = map.querySelector("[data-map-drop-tag]");
  const zoomIn = map.querySelector("[data-map-zoom='in']");
  const zoomOut = map.querySelector("[data-map-zoom='out']");
  const reset = map.querySelector("[data-map-zoom='reset']");
  const tabs = [...map.querySelectorAll("[data-map-layer]")];
  let pins = [...map.querySelectorAll("[data-map-pin]")];
  const pinOf = (n) => map.querySelector(`[data-map-pin="${n}"]`);
  const list = map.querySelector(".map-places");
  const picks = [...map.querySelectorAll("[data-map-pick]")];
  const towns = [...map.querySelectorAll("[data-map-town]")];
  const form = map.querySelector("[data-zip-check]");
  const full = svg.viewBox.baseVal;
  const W = full.width;
  const H = full.height;
  let view = { x: 0, y: 0, w: W, h: H };
  let open = null;
  let tween = 0;
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
  // screen whatever the zoom (pins, the dropped pin and its tag).

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

  // The layer's own view: the whole state on Delivery; on Places the
  // box of the pins, a pin's height of room around each, at no more
  // than a town's zoom.
  const home = () => {
    const whole = { x: 0, y: 0, w: W, h: H };

    if (layer() !== "places" || !pins.length) return whole;

    const width = svg.getBoundingClientRect().width || W;
    const height = width * H / W;
    const xs = pins.map((p) => Number(p.dataset.x));
    const ys = pins.map((p) => Number(p.dataset.y));
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    // The room a pin takes on screen, and its margin, which come out of
    // the view's width: solve for the width that holds the pins' span
    // plus those pixels.
    const roomX = PIN_WIDTH_PX + 2 * (FIT_PAD_PX + NUDGE_PX);
    const roomY = PIN_PX + 2 * FIT_PAD_PX;
    const wideX = spanX / Math.max(0.05, 1 - roomX / width);
    const wideY = spanY / Math.max(0.05, 1 - roomY / height) * W / H;
    const w = Math.max(W / FIT_MAX_ZOOM, wideX, wideY);
    const units = w / width;

    return clamp({
      w,
      h: w * H / W,
      x: (Math.min(...xs) + Math.max(...xs)) / 2 - w / 2,
      // The pins stand above their tips: the box is higher by half a pin.
      y: (Math.min(...ys) + Math.max(...ys)) / 2 - PIN_PX / 2 * units
        - w * H / W / 2,
    });
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

  // The zoom stands over the map's top right: an element that would
  // cover it moves aside, left of it where there is room, else under.
  const clearZoom = (el) => {
    const f = frame.getBoundingClientRect();
    const z = map.querySelector(".map-zoom").getBoundingClientRect();
    const [zl, zr, zt, zb] = [z.left - f.left, z.right - f.left,
      z.top - f.top, z.bottom - f.top];
    const [w, h] = [el.offsetWidth, el.offsetHeight];
    const left = parseFloat(el.style.left);
    const top = parseFloat(el.style.top);

    if (left + w <= zl || left >= zr || top + h <= zt || top >= zb) return;
    if (zl - w - 6 >= MARGIN) el.style.left = `${zl - w - 6}px`;
    else el.style.top = `${zb + 6}px`;
  };

  const placeTag = () => {
    if (tag.hidden || !dropAt.dataset.x) return;

    const at = onScreen(Number(dropAt.dataset.x), Number(dropAt.dataset.y));

    tag.style.visibility = at.x < 0 || at.x > at.width || at.y < 0
      || at.y > at.height ? "hidden" : "";
    stand(tag, at, PIN_PX);
    clearZoom(tag);
  };

  // True at the layer's own view, where the globe has nothing to do.
  const atHome = () => {
    const h = home();

    return Math.abs(h.w - view.w) < 0.5 && Math.abs(h.x - view.x) < 0.5
      && Math.abs(h.y - view.y) < 0.5;
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
    reset.hidden = atHome();
    // Zoomed in, a drag pans the map; at full size it scrolls the page.
    svg.style.touchAction = k > 1.01 ? "none" : "pan-y";
    placeTag();
  };

  const go = (target, animate = true) => {
    const to = clamp(target);

    cancelAnimationFrame(tween);
    if (!animate || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      view = to;
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
      apply();
      if (t < 1) tween = requestAnimationFrame(step);
    };

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
  reset.addEventListener("click", () => go(home()));

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

  // The list beside the map ends where the map does, and scrolls. On a
  // phone it sits below the map and the page scrolls instead.
  const side = matchMedia("(min-width: 992px)");
  const fitList = () => {
    if (!list) return;
    if (list.hidden || !side.matches) {
      list.style.removeProperty("max-height");
      return;
    }
    list.style.maxHeight = `${Math.max(0, frame.getBoundingClientRect().bottom
      - list.getBoundingClientRect().top)}px`;
  };

  if (list && "ResizeObserver" in window) {
    new ResizeObserver(fitList).observe(frame);
  }
  addEventListener("resize", fitList);

  // Layers.

  const layer = () => map.dataset.layer;

  // Pins are Tab stops only where they show: Safari still stops on
  // the ones Delivery hides with display: none.
  const stops = () => {
    for (const pin of pins) pin.tabIndex = layer() === "places" ? 0 : -1;
  };

  stops();

  function setLayer(name) {
    if (!tabs.length || layer() === name) return;
    map.dataset.layer = name;
    stops();
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
    go(home());
    fitList();
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

  const rowOf = (n) => (list
    ? list.querySelector(`[data-map-show="${n}"]:not([data-also])`) : null);

  const pressed = (n) => {
    for (const pin of pins) {
      pin.setAttribute("aria-pressed", String(pin.dataset.mapPin === n));
    }
    for (const b of map.querySelectorAll(
      "[data-map-show]:not([data-also])"
    )) {
      const on = b.dataset.mapShow === n;

      b.setAttribute("aria-expanded", String(on));
      b.closest("li").toggleAttribute("data-open", on);
    }
  };

  // The ZIP shape a pin stands in, found once, by its tip.
  const shapes = [...svg.querySelectorAll(".map-zip")];
  const homes = new Map();
  const homeOf = (pin) => {
    if (!homes.has(pin)) {
      const at = new DOMPoint(Number(pin.dataset.x), Number(pin.dataset.y));

      homes.set(pin, shapes.find((s) => s.isPointInFill(at)) || null);
    }

    return homes.get(pin);
  };

  const outline = (home) => {
    for (const t of towns) {
      if (home) {
        t.setAttribute("d", home.getAttribute("d"));
        t.removeAttribute("hidden");
      } else {
        t.setAttribute("hidden", "");
      }
    }
  };

  function close() {
    if (!open) return;
    open.hidden = true;
    open = null;
    pressed(null);
    outline(null);
    // The selected pin painted last; back in its place.
    for (const pin of pins) pin.parentNode.append(pin);
  }

  // The row, with its card, brought into view: in the list alone where
  // the list scrolls, in the page where it sits below the map.
  const reveal = (row) => {
    const item = row.closest("li");
    const at = item.getBoundingClientRect();

    if (list.scrollHeight > list.clientHeight) {
      const box = list.getBoundingClientRect();

      if (at.top < box.top) list.scrollTop += at.top - box.top;
      else if (at.bottom > box.bottom) list.scrollTop += at.bottom - box.bottom;
    } else if (at.top < 0 || at.bottom > innerHeight) {
      item.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  };

  // A pin out of view, or too near an edge to show, is brought in.
  const bringIn = (pin) => {
    const at = onScreen(Number(pin.dataset.x), Number(pin.dataset.y));
    const edge = PIN_PX / 2;

    if (at.x > edge && at.x < at.width - edge && at.y > PIN_PX + MARGIN
      && at.y < at.height - MARGIN) return;
    go({
      ...view,
      x: Number(pin.dataset.x) - view.w / 2,
      y: Number(pin.dataset.y) - view.h / 2,
    });
  };

  const show = (n, { focus = false } = {}) => {
    const card = map.querySelector(`[data-map-card="${n}"]`);
    const pin = pinOf(n);
    const row = rowOf(n);

    if (!card || !pin || !row) return;
    if (open === card) {
      close();
      return;
    }
    close();
    setLayer("places");
    open = card;
    card.hidden = false;
    pressed(String(n));
    outline(homeOf(pin));
    reveal(row);
    // SVG paints in source order: the selected pin goes on top.
    pin.parentNode.append(pin);
    bringIn(pin);
    if (focus) row.focus();
  };

  for (const pin of pins) {
    pin.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      show(pin.dataset.mapPin, { focus: true });
    });
  }

  for (const button of map.querySelectorAll("[data-map-show]")) {
    button.addEventListener("click", () => show(button.dataset.mapShow));
  }

  // A row and its pin light each other under a mouse.
  const link = (n, on) => {
    for (const el of [pinOf(n), rowOf(n)]) el?.toggleAttribute("data-hot", on);
  };

  for (const el of map.querySelectorAll("[data-map-show], [data-map-pin]")) {
    const n = () => el.dataset.mapShow || el.dataset.mapPin;

    el.addEventListener("pointerenter", (e) => {
      if (e.pointerType !== "touch") link(n(), true);
    });
    el.addEventListener("pointerleave", () => link(n(), false));
  }

  // Escape closes the open card and returns to its row.
  map.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !open) return;

    const n = open.dataset.mapCard;

    close();
    rowOf(n)?.focus();
  });

  // What ends while the page is open leaves the list and the map, and
  // Places frames the pins that remain.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;

    const before = pins.length;

    expire(map);
    pins = [...map.querySelectorAll("[data-map-pin]")];
    number(map);
    if (open && !open.isConnected) {
      open = null;
      pressed(null);
      outline(null);
    }
    if (pins.length !== before && layer() === "places") go(home());
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
  // picked or on water clears the pick.
  const tap = (target) => {
    if (layer() === "places") {
      const pin = target.closest("[data-map-pin]");

      if (pin) show(pin.dataset.mapPin);
      else close();
      return;
    }

    const area = target.closest("[data-zip]");

    if (!area || zipOf(area) === picked) {
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
      p.dataset.tone = tone;
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
