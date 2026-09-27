// The delivery map (partials/map.html), made to answer.
//
// - A ZIP names its town and whether we deliver there as the pointer
//   passes over it; a tap on it puts it in the map's ZIP check, which
//   answers in words and announces an nff:zip event.
// - On nff:zip, from any check on the page, the map outlines that ZIP
//   and drops a pin onto its middle, coloured by the answer, with a
//   tag: the town, an egg and a hen (coloured where we deliver them)
//   and the delivery fee.
// - A second tap on that town, or a tap on water or on a neighbouring
//   state, clears the check, the pin and the outline. One tap makes
//   one change: with a card open, a tap off the pins only closes it.
// - A pin, or its line in the key, opens a card with the details.
//   Pins that share a ZIP stack there; each tap on the stack brings
//   the next to the front and shows its card.
// - It zooms with its buttons, a pinch (a trackpad's too), a double
//   click (not a double tap) or ctrl and the wheel, and pans with a
//   drag once zoomed. At full size a swipe still scrolls the page.
//
// Wording of the labels is a draft for James (#138).

const LABELS = {
  ok: "We deliver here",
  wait: "A little outside our area",
  no: "Outside our area",
};

// Where we deliver eggs only (Connecticut).
const EGGS_ONLY = "We deliver eggs here";

const TONE_OF = {
  "is-ours": "ok",
  "is-eggs": "ok",
  "is-away": "wait",
  "is-land": "no",
};

const MAX_ZOOM = 5;

// Pins stand this tall on screen at any zoom and any width; the shape
// is drawn 45 units tall.
const PIN_PX = 38;
const PIN_UNITS = 45;

// Pins in a stack step this far up and right of the one before, in
// pin units.
const STEP = 8;

// A pointer that moves further than this is dragging, not tapping.
const SLOP = 6;

// The dropped pin's tag, in screen pixels: its padding, its two lines
// and the icons in the second, and how far it keeps from the frame's
// edges and the zoom buttons.
const TAG = { pad: 6, line: 17, gap: 3, icon: 16, egg: 16, hen: 13.1 };
const MARGIN = 8;

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

const labelOf = (area, tone) => (area.classList.contains("is-eggs")
  ? EGGS_ONLY : LABELS[tone]);

const easeOut = (t) => 1 - (1 - t) ** 3;

const wire = (map) => {
  const frame = map.querySelector("[data-map-frame]");
  const svg = map.querySelector("[data-map-svg]");
  const tip = map.querySelector("[data-map-tip]");
  const drop = map.querySelector("[data-map-drop]");
  const dropAt = map.querySelector("[data-map-drop-at]");
  const tag = map.querySelector("[data-map-drop-tag]");
  const zooms = map.querySelector(".map-zoom");
  const zoomIn = map.querySelector("[data-map-zoom='in']");
  const zoomOut = map.querySelector("[data-map-zoom='out']");
  const reset = map.querySelector("[data-map-zoom='reset']");
  const layer = map.querySelector(".map-pins");
  const pins = [...map.querySelectorAll("[data-map-pin]")];
  // A pin by its number in the key; the markup draws them in
  // reverse, so what is on now lies on top.
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

  // The pointers down on the map, for drags and pinches.
  const pointers = new Map();
  let dragging = false;
  let startView = null;
  let startPoint = null;
  let startSpread = 0;

  // Stacks: the pins that stand in one ZIP, all at the place of the
  // first in the key, each a step up and to the right of the one
  // before. Showing a pin's card brings it to the front, the pins
  // before it going to the back; closing the card puts the stack back
  // in key order. A pin alone is a stack of one.

  const areas = [...svg.querySelectorAll("[data-zip]")];
  const stackOf = new Map();
  const orderOf = new Map();
  const atOf = new Map();
  const shiftOf = new Map();

  {
    const byZip = new Map();
    const inOrder = [...pins].sort(
      (a, b) => a.dataset.mapPin - b.dataset.mapPin
    );

    for (const pin of inOrder) {
      const point = new DOMPoint(Number(pin.dataset.x), Number(pin.dataset.y));
      const area = areas.find((a) => a.isPointInFill(point));
      const key = area ? area.dataset.zip : `pin${pin.dataset.mapPin}`;

      if (!byZip.has(key)) byZip.set(key, []);
      byZip.get(key).push(pin);
    }
    for (const [key, stack] of byZip) {
      const [first] = stack;

      orderOf.set(stack, [...stack]);
      for (const pin of stack) {
        stackOf.set(pin, stack);
        atOf.set(pin, { x: first.dataset.x, y: first.dataset.y });
        shiftOf.set(pin, { x: 0, y: 0 });
        if (stack.length > 1) pin.dataset.stack = key;
      }
    }
  }

  // Half a pin's width and its height above its tip, in pin units.
  const size = (pin) => {
    const k = pin.classList.contains("is-off") ? 0.78 : 1;

    return pin.classList.contains("map-pin-farm")
      ? { half: 22 * k, tall: 59 * k }
      : { half: 15 * k, tall: 45 * k };
  };

  // Each pin's top right corner a step beyond the one before it,
  // whatever their sizes, the front pin on the stack's place.
  const lay = (stack) => {
    const order = orderOf.get(stack);
    const front = size(order[0]);

    for (const [i, pin] of order.entries()) {
      const own = size(pin);
      const shift = {
        x: front.half - own.half + STEP * i,
        y: own.tall - front.tall - STEP * i,
      };

      shiftOf.set(pin, shift);
      pin.querySelector(".map-pin-shift").style.transform =
        `translate(${shift.x}px, ${shift.y}px)`;
    }
  };

  // SVG paints in source order, so the front pin goes last.
  const toFront = (pin) => {
    const stack = stackOf.get(pin);
    const order = orderOf.get(stack);

    if (stack.length < 2 || order[0] === pin) return;

    const i = order.indexOf(pin);

    orderOf.set(stack, [...order.slice(i), ...order.slice(0, i)]);
    lay(stack);
    for (const p of [...orderOf.get(stack)].reverse()) layer.append(p);
  };

  const restack = (stack) => {
    if (stack.length < 2 || orderOf.get(stack)[0] === stack[0]) return;
    orderOf.set(stack, [...stack]);
    lay(stack);
    for (const p of pins) layer.append(p);
  };

  // Stacked from the start, without sliding there.
  for (const stack of new Set(stackOf.values())) {
    if (stack.length < 2) continue;
    for (const pin of stack) {
      pin.querySelector(".map-pin-shift").style.transition = "none";
    }
    lay(stack);
    svg.getBoundingClientRect();
    for (const pin of stack) {
      pin.querySelector(".map-pin-shift").style.transition = "";
    }
  }

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

  const place = () => {
    if (!open) return;

    const pin = pinOf(open.dataset.mapCard);
    const box = frame.getBoundingClientRect();
    const at = atOf.get(pin);
    const shift = shiftOf.get(pin);
    const x = (at.x - view.x) / view.w * box.width
      + shift.x * PIN_PX / PIN_UNITS;
    const y = (at.y - view.y) / view.h * box.height
      + shift.y * PIN_PX / PIN_UNITS;

    // A pin panned out of view takes its card with it, once the
    // view has come to rest.
    if (x < 0 || x > box.width || y < 0 || y > box.height) {
      if (moving) return;
      close();
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

  // The tag's box and lines, measured once its words are in and it
  // shows: the town on top, centred, then the icons and the fee.
  const layTag = () => {
    const town = tag.querySelector("[data-map-drop-town]");
    const fee = tag.querySelector("[data-map-drop-fee]");
    const feeW = fee.textContent ? fee.getComputedTextLength() : 0;
    const lineW = TAG.egg + 4 + TAG.hen + (feeW ? 6 + feeW : 0);
    const w = Math.ceil(Math.max(town.getComputedTextLength(), lineW))
      + 2 * TAG.pad;
    const top = TAG.pad + TAG.line + TAG.gap;
    const h = top + TAG.icon + TAG.pad;
    const x0 = (w - lineW) / 2;
    const box = tag.querySelector("[data-map-drop-box]");

    box.setAttribute("width", w);
    box.setAttribute("height", h);
    town.setAttribute("x", w / 2);
    town.setAttribute("y", TAG.pad + 13);
    tag.querySelector("[data-map-drop-has='eggs']")
      .setAttribute("transform", `translate(${x0} ${top})`);
    tag.querySelector("[data-map-drop-has='hen']")
      .setAttribute("transform", `translate(${x0 + TAG.egg + 4} ${top})`);
    fee.setAttribute("x", x0 + TAG.egg + 4 + TAG.hen + 6);
    fee.setAttribute("y", top + 13);
    tag.dataset.w = w;
    tag.dataset.h = h;
  };

  // Above the pin, or below its tip where the top of the frame is too
  // near; never past an edge or under the zoom buttons.
  const placeTag = () => {
    if (!dropAt.dataset.x || !tag.dataset.w) return;

    const box = svg.getBoundingClientRect();
    const x = (dropAt.dataset.x - view.x) / view.w * box.width;
    const y = (dropAt.dataset.y - view.y) / view.h * box.height;
    const w = Number(tag.dataset.w);
    const h = Number(tag.dataset.h);

    if (x < 0 || x > box.width || y < 0 || y > box.height) {
      tag.setAttribute("visibility", "hidden");
      return;
    }
    tag.removeAttribute("visibility");

    const above = y - PIN_PX - 6 - h;
    const top = Math.max(MARGIN, Math.min(box.height - h - MARGIN,
      above >= MARGIN ? above : y + MARGIN));
    const z = zooms.getBoundingClientRect();
    const beside = top < z.bottom - box.top + MARGIN
      && top + h > z.top - box.top - MARGIN;
    const right = (beside ? z.left - box.left : box.width) - MARGIN;
    const left = Math.max(MARGIN, Math.min(right - w, x - w / 2));
    const k = view.w / box.width;

    tag.setAttribute("transform", `translate(${view.x + left * k} `
      + `${view.y + top * k}) scale(${k})`);
  };

  const apply = () => {
    const k = zoom();
    const width = svg.getBoundingClientRect().width || W;
    const s = (PIN_PX / PIN_UNITS * view.w / width).toFixed(4);

    svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
    for (const pin of pins) {
      const at = atOf.get(pin);

      pin.setAttribute("transform",
        `translate(${at.x} ${at.y}) scale(${s})`);
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

  // Cards.

  const hide = () => {
    open.hidden = true;
    pinOf(open.dataset.mapCard).setAttribute("aria-pressed", "false");
    open = null;
  };

  function close() {
    if (!open) return;

    const stack = stackOf.get(pinOf(open.dataset.mapCard));

    hide();
    restack(stack);
  }

  const show = (n, { focus = false, centreOn = false } = {}) => {
    const card = map.querySelector(`[data-map-card="${n}"]`);
    const pin = pinOf(n);
    const stack = stackOf.get(pin);

    if (open === card) {
      close();
      return;
    }
    // Within a stack, the stack stays as it is while the card swaps.
    if (open && stack.includes(pinOf(open.dataset.mapCard))) hide();
    else close();
    toFront(pin);
    open = card;
    card.hidden = false;
    pin.setAttribute("aria-pressed", "true");
    if (stack.length > 1) {
      const line = card.querySelector("[data-map-card-stack]");

      line.textContent = `${stack.indexOf(pin) + 1} of ${stack.length} `
        + "here. Tap the pin again for the next.";
      line.hidden = false;
    }
    if (centreOn && zoom() > 1.01) {
      const at = atOf.get(pin);

      go({
        ...view,
        x: at.x - view.w / 2,
        y: at.y - view.h / 2,
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

    tip.textContent = `${town}${zipOf(area)}: ${labelOf(area, toneOf(area))}`;
    tip.hidden = false;
    tip.style.left = `${e.clientX - box.left}px`;
    tip.style.top = `${e.clientY - box.top}px`;
    tip.style.transform = e.clientX - box.left > box.width / 2
      ? "translate(calc(-100% - 12px), 12px)"
      : "translate(12px, 12px)";
  });
  svg.addEventListener("pointerleave", hideTip);

  // Puts a ZIP in the map's check, which answers and announces it, or
  // on a page without one announces it here. An empty ZIP clears. On a
  // phone the answer stands above the map, and the map must not move
  // from under the finger as it grows or goes.
  const check = (zip, tone) => {
    const was = frame.getBoundingClientRect().top;

    if (form) {
      const input = form.querySelector("[name='zip']");

      input.value = zip;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      document.dispatchEvent(new CustomEvent("nff:zip", {
        detail: { zip, tone },
      }));
    }

    const moved = frame.getBoundingClientRect().top - was;

    if (moved) scrollBy({ top: moved, behavior: "instant" });
  };

  // A tap on a pin opens its card; on a stack whose card is open, the
  // next pin's. Otherwise a tap closes an open card and does no more;
  // with none open, a tap on a town picks it, and a tap on the town
  // picked, on water or on a neighbouring state clears the pick.
  const tap = (target) => {
    const pin = target.closest("[data-map-pin]");

    if (pin) {
      const order = orderOf.get(stackOf.get(pin));
      const showing = open && order.includes(pinOf(open.dataset.mapCard));
      const next = order.length > 1 && showing ? order[1] : order[0];

      show(Number((order.length > 1 ? next : pin).dataset.mapPin));
      return;
    }
    if (open) {
      close();
      return;
    }

    const area = target.closest("[data-zip]");

    if (!area || area.classList.contains("is-land")
      || zipOf(area) === picked) {
      if (picked) check("", "");
      return;
    }
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
    const area = zip && LABELS[tone]
      && svg.querySelector(`[data-zip="z${CSS.escape(zip)}"]`);

    // SVG elements have no hidden property, so the attribute it is.
    if (!area) {
      picked = null;
      drop.setAttribute("hidden", "");
      for (const p of picks) p.setAttribute("hidden", "");
      return;
    }

    const { x, y } = area.dataset;
    const fee = Number(tag.dataset.fee)
      + (tone === "wait" ? Number(tag.dataset.extra) : 0);
    const has = {
      eggs: tone !== "no",
      hen: tone !== "no" && !area.classList.contains("is-eggs"),
    };

    picked = zip;
    tag.querySelector("[data-map-drop-town]").textContent =
      area.dataset.town || zip;
    tag.querySelector("[data-map-drop-fee]").textContent =
      tone === "no" ? "" : `$${fee}`;
    for (const [what, on] of Object.entries(has)) {
      tag.querySelector(`[data-map-drop-has='${what}']`).dataset.on = on;
    }

    for (const p of picks) {
      p.setAttribute("d", area.getAttribute("d"));
      p.removeAttribute("hidden");
    }
    dropAt.dataset.x = x;
    dropAt.dataset.y = y;
    drop.dataset.tone = tone;

    // Hidden and shown again, with a layout between, the pin falls anew.
    drop.setAttribute("hidden", "");
    drop.getBoundingClientRect();
    drop.removeAttribute("hidden");
    layTag();
    apply();
  });

  addEventListener("resize", apply);
  apply();
};

export const wireMaps = () => {
  for (const map of document.querySelectorAll("[data-map]")) wire(map);
};
