// Project the map's GeoJSON into SVG path data for data/map.json.
// Called by bin/map/build with the frame and three GeoJSON files.
//
// The frame is small enough (under a degree each way) for a plain
// equirectangular projection, scaled for its middle latitude, to pass
// for a proper one. That keeps it simple enough for a template to
// repeat: Hugo places the pins with the numbers in "frame".

import { readFileSync } from "node:fs";

const [west, south, east, north] = process.argv.slice(2, 6).map(Number);
const [landFile, zipsFile, centresFile] = process.argv.slice(6);
const read = (file) => JSON.parse(readFileSync(file, "utf8")).features;

const width = 1000;
const cos = Math.cos(((south + north) / 2) * Math.PI / 180);
const scale = width / ((east - west) * cos);
const height = Math.round((north - south) * scale);

const round = (n) => Math.round(n * 10) / 10;
const project = ([lng, lat]) => [
  round((lng - west) * cos * scale),
  round((north - lat) * scale),
];

// A ring as one absolute move and then relative steps, taken between
// the rounded points so the rounding never adds up.
const ring = (coords) => {
  const points = coords.map(project);
  let [px, py] = points[0];
  let d = `M${px} ${py}`;

  for (const [x, y] of points.slice(1, -1)) {
    const dx = round(x - px);
    const dy = round(y - py);

    if (dx || dy) d += `l${dx} ${dy}`;
    [px, py] = [x, y];
  }
  return `${d}z`;
};

const path = (geometry) => {
  const polygons = geometry.type === "Polygon"
    ? [geometry.coordinates]
    : geometry.coordinates;

  return polygons.flat().map(ring).join("");
};

const centres = new Map(read(centresFile)
  .map((f) => [f.properties.zip, project(f.geometry.coordinates)]));

const map = {
  frame: { west, north, cos, scale, width, height },
  land: read(landFile)
    .map((f) => ({ state: f.properties.state, d: path(f.geometry) }))
    .sort((a, b) => a.state.localeCompare(b.state)),
  zips: read(zipsFile)
    .map((f) => {
      const [x, y] = centres.get(f.properties.zip);

      return { zip: f.properties.zip, x, y, d: path(f.geometry) };
    })
    .sort((a, b) => a.zip.localeCompare(b.zip)),
};

process.stdout.write(`${JSON.stringify(map)}\n`);
