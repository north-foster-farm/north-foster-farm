// The delivery map's dropped pin. Each ZIP check on the page announces
// its answer as an nff:zip event; every map on the page outlines that
// ZIP and drops a pin on its middle, coloured by the answer, or lifts
// the pin when the field is cleared. A ZIP the map does not show (a
// PO box, somewhere far off) gets no pin; the check's words still
// answer it. Label wording is a draft for James (#138).

const LABELS = {
  ok: "We deliver here",
  wait: "A little outside our area",
  no: "Outside our area",
};

// Labels near an edge grow inward rather than off the map.
const EDGE = 160;

const drop = (map, { zip, tone }) => {
  const group = map.querySelector("[data-map-drop]");
  const area = zip && LABELS[tone]
    && map.querySelector(`[data-zip="${CSS.escape(zip)}"]`);

  if (!area) {
    group.hidden = true;
    return;
  }

  const { x, y } = area.dataset;
  const width = map.querySelector("svg").viewBox.baseVal.width;
  const label = map.querySelector("[data-map-drop-label]");
  let anchor = "middle";

  if (x < EDGE) anchor = "start";
  if (x > width - EDGE) anchor = "end";
  label.setAttribute("text-anchor", anchor);
  label.setAttribute("x", { start: -15, middle: 0, end: 15 }[anchor]);
  label.textContent = `${zip}: ${LABELS[tone]}`;

  map.querySelector("[data-map-pick]")
    .setAttribute("d", area.getAttribute("d"));
  map.querySelector("[data-map-drop-at]")
    .setAttribute("transform", `translate(${x} ${y})`);
  group.dataset.tone = tone;

  // Hidden and shown again, with a layout between, the pin falls anew.
  group.hidden = true;
  group.getBoundingClientRect();
  group.hidden = false;
};

export const wireMaps = () => {
  const maps = document.querySelectorAll("[data-map]");

  if (!maps.length) return;

  document.addEventListener("nff:zip", (e) => {
    for (const map of maps) drop(map, e.detail);
  });
};
