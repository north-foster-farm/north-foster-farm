// The one SVG clean-up every tracked .svg goes through (#295):
// `npm run svg:clean` writes it, `npm run check:svg` fails on a file
// that differs from it. See docs/svg.md.
//
// Source: James's ~/.bin/svgomg, which holds his SVGOMG settings and
// how each maps to SVGO 4. FEATURES below is its FEATURES list, in
// its order (the run order), with the same four off. Keep the two in
// step: test/svg.test.mjs holds a copy of the reference list and
// fails when this one drifts from it.

import { relative, resolve, sep } from "node:path";

import { stripUnusedClasses } from "./bin/svg/strip.mjs";

export const PRETTIFY = true;
export const MULTIPASS = true;
export const FLOAT_PRECISION = 10;
export const TRANSFORM_PRECISION = 10;

const P = { floatPrecision: FLOAT_PRECISION };

// [name, on, params?], as in ~/.bin/svgomg.
export const FEATURES = [
  ["removeDoctype", true],
  ["removeXMLProcInst", true],
  ["removeComments", true],
  ["removeMetadata", true],
  ["removeXMLNS", false],
  ["removeEditorsNSData", true],
  ["cleanupAttrs", true],
  ["mergeStyles", true],
  ["inlineStyles", true],
  ["minifyStyles", true],
  ["convertStyleToAttrs", false],
  ["cleanupIds", true],
  ["removeRasterImages", true],
  ["removeUselessDefs", true],
  ["cleanupNumericValues", true, P],
  ["cleanupListOfValues", true, P],
  ["convertColors", true],
  ["removeUnknownsAndDefaults", true],
  ["removeNonInheritableGroupAttrs", true],
  ["removeUselessStrokeAndFill", true],
  ["removeViewBox", false],
  ["cleanupEnableBackground", true],
  ["removeHiddenElems", true],
  ["removeEmptyText", true],
  ["convertShapeToPath", true, P],
  ["moveElemsAttrsToGroup", true],
  ["moveGroupAttrsToElems", true],
  ["collapseGroups", true],
  ["convertPathData", true, P],
  ["convertEllipseToCircle", true],
  ["convertTransform", true,
    { ...P, transformPrecision: TRANSFORM_PRECISION }],
  ["removeEmptyAttrs", true],
  ["removeEmptyContainers", true],
  ["mergePaths", true, P],
  ["removeUnusedNS", true],
  ["reusePaths", true],
  ["sortAttrs", true],
  ["sortDefsChildren", true],
  ["removeTitle", true],
  ["removeDesc", true],
  ["removeDimensions", true],
  ["removeStyleElement", true],
  ["removeScripts", true],
  ["removeOffCanvasPaths", true],
  ["convertOneStopGradients", true],
  ["removeDeprecatedAttrs", true],
  ["removeXlink", false],
];

// The files that differ from the settings above, each for a reason
// (#295). `off` turns features off for that file; `classes` names the
// classes the strip keeps there. Every entry says why. check:svg cleans
// and checks these files with their overrides, like any other, and
// test/svg.test.mjs fails on an override nothing needs any longer.
const AVATAR_IDS = "each symbol's id is the avatar's key, which the " +
  "templates and assets/scripts/account and session point <use> at";

export const OVERRIDES = {
  "assets/images/logo.svg": {
    classes: {
      black: "the header colors the logo's paths through .black " +
        "(assets/styles/components/_header.scss)",
    },
  },
  "assets/images/logo-mark.svg": {
    classes: {
      black: "the header colors the mark's paths through .black " +
        "(assets/styles/components/_header.scss)",
    },
  },
  "assets/images/apppa-logo.svg": {
    classes: {
      background: "the footer fills the badge with the theme's white " +
        "through .background (assets/styles/components/_footer.scss)",
    },
  },
  "assets/images/icons/egg-spinner.svg": {
    off: {
      reusePaths: "the track and the running stroke are the same egg, " +
        "styled apart; this would draw both from one path with an id, " +
        "dropping their classes and pathLength, and the spinner repeats " +
        "on a page (one per busy button)",
    },
    classes: {
      "egg-spinner-track": "the outline's color " +
        "(assets/styles/components/_busy-button.scss)",
      "egg-spinner-run": "the running stroke's dash and animation " +
        "(assets/styles/components/_busy-button.scss)",
    },
  },
  "assets/images/avatars.svg": {
    off: {
      cleanupIds: AVATAR_IDS,
      removeHiddenElems: "it removes a symbol nothing in the file uses, " +
        "which is all of them: the page uses them",
      reusePaths: "it would add ids of its own to every page that " +
        "includes the sprite",
    },
  },
};

const ROOT = import.meta.dirname;

// A file's override, by its path from the repo root.
export const overrideFor = (file = "") =>
  OVERRIDES[relative(ROOT, resolve(ROOT, file)).split(sep).join("/")]
  ?? {};

export const plugins = (override = {}) => [
  ...FEATURES
    .filter(([name, on]) => on && !Object.hasOwn(override.off ?? {}, name))
    .map(([name, , params]) => params ? { name, params } : name),
  // Not in SVGOMG: the class names no stylesheet, script, template or
  // test uses (#295). bin/svg/strip.mjs says how.
  stripUnusedClasses(Object.keys(override.classes ?? {})),
];

export const configFor = (file) => ({
  multipass: MULTIPASS,
  floatPrecision: FLOAT_PRECISION,
  js2svg: { pretty: PRETTIFY, indent: 2, eol: "lf", finalNewline: true },
  plugins: plugins(overrideFor(file)),
});

export default configFor();
