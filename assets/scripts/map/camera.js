// The camera (#862, phase 4 of docs/refactors/map.md): the view, the
// SVG's viewBox, and the moves between views: the zoom buttons, ctrl
// and the wheel, the double click and the window's resize. The sums
// are view.mjs's and drawView writes. map.js hands it the pins and the
// layer to read, and `drawn`, called after each draw.

import { drawView } from "./draw.js";
import {
  atHome, centreOf, clampView, easeOut, homeView, onScreen, toMap,
  tweenAt, zoomOf, zoomedAbout,
} from "./view.mjs";

export class Camera {
  #view;
  #tween = 0;
  // A double tap is two taps: picking towns quickly must not zoom.
  #touched = false;

  // `parts` is partsOf's; `pins` and `layer` give the pins held now and
  // the layer showing.
  constructor(parts, { pins, layer, drawn }) {
    const full = parts.svg.viewBox.baseVal;

    this.parts = parts;
    this.pins = pins;
    this.layer = layer;
    this.drawn = drawn;
    // The whole map's size, read before the first draw moves the view.
    this.size = { W: full.width, H: full.height };
    this.#view = { x: 0, y: 0, w: this.size.W, h: this.size.H };
    this.#listen();
  }

  // The view showing, a copy.
  get view() {
    return { ...this.#view };
  }

  zoom() {
    return zoomOf(this.#view, this.size);
  }

  // The SVG's width on screen, or the map's before it is laid out.
  #width() {
    return this.parts.svg.getBoundingClientRect().width || this.size.W;
  }

  // The layer's own view: the whole state on Delivery; on Places the
  // box of the pins showing (homeView).
  home() {
    const { size } = this;
    const layer = this.layer();
    const shown = this.pins().filter((p) => !p.hasAttribute("hidden"));

    if (layer !== "places" || !shown.length) {
      return homeView({ size, layer, pins: [], width: size.W });
    }

    return homeView({
      size,
      layer,
      pins: shown.map((p) => ({ x: Number(p.dataset.x),
        y: Number(p.dataset.y) })),
      width: this.#width(),
    });
  }

  // A point in map units on screen, in pixels from the frame's corner,
  // with the frame's size.
  onScreen(x, y) {
    const box = this.parts.svg.getBoundingClientRect();

    return {
      ...onScreen(this.#view, box, { x, y }),
      width: box.width,
      height: box.height,
    };
  }

  // A point on screen in map units.
  toMap(clientX, clientY) {
    return toMap(this.#view, this.parts.svg.getBoundingClientRect(),
      { x: clientX, y: clientY });
  }

  apply() {
    const k = this.zoom();

    drawView(this.parts, this.#view, this.pins(), {
      k,
      width: this.#width(),
      // True at the layer's own view, where the globe has nothing to do.
      atHome: () => atHome(this.#view, this.home()),
    });
    this.drawn();
  }

  go(target, animate = true) {
    const to = clampView(target, this.size);

    cancelAnimationFrame(this.#tween);
    if (!animate || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.#view = to;
      this.apply();
      return;
    }
    this.#glide({ ...this.#view }, to);
  }

  // From one view to another in 220 ms, eased.
  #glide(from, to) {
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / 220);

      this.#view = tweenAt(from, to, t);
      this.apply();
      // Runs until the eased step reaches the end.
      if (easeOut(t) < 1) this.#tween = requestAnimationFrame(step);
    };

    this.#tween = requestAnimationFrame(step);
  }

  // Zoom by a factor about a point in map units.
  zoomAbout(factor, px, py, animate) {
    this.go(zoomedAbout(this.#view, factor, { x: px, y: py }), animate);
  }

  #zoomCentre(factor) {
    const c = centreOf(this.#view);

    this.zoomAbout(factor, c.x, c.y, true);
  }

  // A trackpad pinch arrives as the wheel with ctrl held.
  #wheel(e) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();

    const p = this.toMap(e.clientX, e.clientY);

    this.zoomAbout(Math.exp(-e.deltaY * 0.01), p.x, p.y, false);
  }

  #doubleClick(e) {
    e.preventDefault();
    if (this.#touched) return;
    const p = this.toMap(e.clientX, e.clientY);

    this.zoomAbout(2, p.x, p.y, true);
  }

  #listen() {
    const { svg, zoomIn, zoomOut, reset } = this.parts;

    zoomIn.addEventListener("click", () => this.#zoomCentre(2));
    zoomOut.addEventListener("click", () => this.#zoomCentre(0.5));
    reset.addEventListener("click", () => this.go(this.home()));
    svg.addEventListener("wheel", (e) => this.#wheel(e), { passive: false });
    svg.addEventListener("pointerdown", (e) => {
      this.#touched = e.pointerType === "touch";
    });
    svg.addEventListener("dblclick", (e) => this.#doubleClick(e));
  }

  // The first draw, and one on each resize of the window. map.js calls
  // it last, after the rest of the map is wired.
  start() {
    addEventListener("resize", () => this.apply());
    this.apply();
  }
}
