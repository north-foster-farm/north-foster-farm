// Project the map's GeoJSON into SVG path data for data/map.json.
// Called by bin/map/build with the frame, the GeoJSON files, the
// Census ZCTA-to-town file and data/delivery.json.
//
// The frame is small enough (under a degree each way) for a plain
// equirectangular projection, scaled for its middle latitude, to pass
// for a proper one. That keeps it simple enough for a template to
// repeat: Hugo places the pins with the numbers in "frame".

import { readFileSync } from "node:fs";

const [west, south, east, north] = process.argv.slice(2, 6).map(Number);
const [zipsFile, bordersFile, centresFile, townsFile, deliveryFile] =
  process.argv.slice(6);
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

// A line as one absolute move and then relative steps, taken between
// the rounded points so the rounding never adds up. A ring closes.
const line = (coords, close) => {
  const points = coords.map(project);
  const last = close ? points.length - 1 : points.length;
  let [px, py] = points[0];
  let d = `M${px} ${py}`;

  for (const [x, y] of points.slice(1, last)) {
    const dx = round(x - px);
    const dy = round(y - py);

    if (dx || dy) d += `l${dx} ${dy}`;
    [px, py] = [x, y];
  }
  return close ? `${d}z` : d;
};

const path = (geometry) => {
  switch (geometry.type) {
    case "Polygon":
      return geometry.coordinates.map((r) => line(r, true)).join("");
    case "MultiPolygon":
      return geometry.coordinates.flat().map((r) => line(r, true)).join("");
    case "LineString":
      return line(geometry.coordinates, false);
    default:
      return geometry.coordinates.map((l) => line(l, false)).join("");
  }
};

// Each ZIP's town: the name the delivery list gives it, or else the
// Census town (county subdivision) holding most of its land.
const named = new Map();

for (const state of JSON.parse(readFileSync(deliveryFile, "utf8")).area
  .states) {
  for (const town of state.towns) {
    for (const zip of town.zips) {
      if (!named.has(zip)) named.set(zip, town.town);
    }
  }
}

const biggest = new Map();

for (const row of readFileSync(townsFile, "utf8").split("\n").slice(1)) {
  const cols = row.split("|");
  const [zip, town, land] = [cols[1], cols[10], Number(cols[16])];

  if (!zip || !town) continue;
  if (!biggest.has(zip) || land > biggest.get(zip).land) {
    biggest.set(zip, {
      land,
      town: town.replace(/ (town|city|CDP)$/, ""),
    });
  }
}

const townOf = (zip) => named.get(zip) || biggest.get(zip)?.town || "";

const centres = new Map(read(centresFile)
  .map((f) => [f.properties.zip, project(f.geometry.coordinates)]));

const map = {
  frame: { west, north, cos, scale, width, height },
  zips: read(zipsFile)
    .map((f) => {
      const { zip, state } = f.properties;
      const [x, y] = centres.get(zip);

      return { zip, state, town: townOf(zip), x, y, d: path(f.geometry) };
    })
    .sort((a, b) => a.zip.localeCompare(b.zip)),
  // A layer without attributes comes out as a GeometryCollection.
  borders: (() => {
    const json = JSON.parse(readFileSync(bordersFile, "utf8"));
    const geometries = json.geometries
      || json.features.map((f) => f.geometry);

    return geometries.map(path).join("");
  })(),
};

process.stdout.write(`${JSON.stringify(map)}\n`);
