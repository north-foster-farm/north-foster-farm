// The tag's facts (#860, phase 2 of docs/refactors/map.md): the town,
// what we deliver there and the price. No DOM: map.js reads the shape
// and draw.js writes the tag.

// The ZIP a shape stands for, from its data-zip. The markup writes it
// after a "z": the minifier reads a bare "02825" in an SVG as a number
// and drops its leading zero.
export const zipOf = (attribute) => attribute.slice(1);

// A town's tone, from its class names.
export const toneOf = (classes) => {
  if (classes.includes("is-ours")) return "ok";
  if (classes.includes("is-away")) return "wait";
  return "no";
};

// What the tag shows for a town: its name, or its ZIP where it has
// none; the fee, with the outside-area extra a little outside, and no
// price where we don't deliver; whether the egg and the hen are offered
// (not struck), and whether the link to Places shows.
export const tagFacts = ({ town, zip, tone, eggsOnly, fee, extra }) => {
  const none = tone === "no";

  return {
    town: town || zip,
    price: none ? "" : `$${fee + (tone === "wait" ? extra : 0)}`,
    none,
    eggs: !none,
    hen: !none && !eggsOnly,
    link: none,
  };
};
