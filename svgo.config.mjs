// The one SVG clean-up every tracked .svg goes through (#295):
// `npm run svg:clean` writes it, `npm run check:svg` fails on a file
// that differs from it. See docs/svg.md.
//
// Source: James's ~/.bin/svgomg, which holds his SVGOMG settings and
// how each maps to SVGO 4. FEATURES below is its FEATURES list, in
// its order (the run order), with the same four off. Keep the two in
// step: test/svg.test.mjs holds a copy of the reference list and
// fails when this one drifts from it.

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

export const plugins = () => [
  ...FEATURES.filter(([, on]) => on).map(([name, , params]) =>
    params ? { name, params } : name),
  // Not in SVGOMG: the class names no stylesheet, script, template or
  // test uses (#295). bin/svg/strip.mjs says which stay and why.
  stripUnusedClasses,
];

export default {
  multipass: MULTIPASS,
  floatPrecision: FLOAT_PRECISION,
  js2svg: { pretty: PRETTIFY, indent: 2, eol: "lf", finalNewline: true },
  plugins: plugins(),
};
