// A centred line of items with a dot between each pair. Where the line
// wraps, the item that starts a new row loses its dot, so no row opens
// with one. The dot takes no width, so dropping it never reflows.

const mark = (list) => {
  let top = null;

  for (const item of list.children) {
    const starts = item.offsetTop !== top;

    item.toggleAttribute("data-row-start", starts);
    top = item.offsetTop;
  }
};

export const wireDotLists = () => {
  const lists = document.querySelectorAll("[data-dot-list]");

  if (!lists.length) return;

  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) mark(entry.target);
  });

  for (const list of lists) {
    mark(list);
    observer.observe(list);
  }
};
