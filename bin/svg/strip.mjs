// The step after SVGOMG's settings (#295): drop every class name an
// SVG carries that the project does not use. Most are Lucide's
// (`lucide`, `lucide-copy`), which come with every icon copied from
// lucide.dev and style nothing here.
//
// KEEP names the classes the project does use, each with why. Every
// other class goes. bin/svg/clean.mjs checks before it writes: when a
// class it would drop is named in a stylesheet, script, template or
// test, it stops and says where, so a class in use is never lost
// silently. test/svg.test.mjs fails when a KEEP entry is no longer
// used anywhere.

export const KEEP = {
  black: "the header colors the logo's paths through .black " +
    "(assets/styles/components/_header.scss)",
  background: "the footer fills the APPPA logo's badge with the " +
    "theme's white through .background " +
    "(assets/styles/components/_footer.scss)",
};

const kept = (value) =>
  value.split(/\s+/).filter((name) => Object.hasOwn(KEEP, name));

export const stripUnusedClasses = {
  name: "stripUnusedClasses",
  fn: () => ({
    element: {
      enter: (node) => {
        if (node.attributes.class === undefined) return;
        const names = kept(node.attributes.class);

        if (names.length) node.attributes.class = names.join(" ");
        else delete node.attributes.class;
      },
    },
  }),
};
