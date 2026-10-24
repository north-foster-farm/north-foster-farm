// The step after SVGOMG's settings (#295): drop every class name an
// SVG carries that the project does not use. Most are Lucide's
// (`lucide`, `lucide-copy`), which come with every icon copied from
// lucide.dev and style nothing here.
//
// A file keeps only the classes its entry in OVERRIDES
// (svgo.config.mjs) names, each with why. bin/svg/clean.mjs checks
// before it writes: when a class it would drop is named in a
// stylesheet, script, template or test, it stops and says where, so a
// class in use is never lost silently.

export const stripUnusedClasses = (keep = []) => ({
  name: "stripUnusedClasses",
  fn: () => ({
    element: {
      enter: (node) => {
        if (node.attributes.class === undefined) return;
        const names = node.attributes.class.split(/\s+/)
          .filter((name) => keep.includes(name));

        if (names.length) node.attributes.class = names.join(" ");
        else delete node.attributes.class;
      },
    },
  }),
});
