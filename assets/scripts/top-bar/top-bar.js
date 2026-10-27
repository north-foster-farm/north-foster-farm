// The top bar names the next event until it ends. The build picks the
// event, but no build runs on the day, so the page drops a bar whose
// end has passed.
export const retireTopBar = () => {
  const bar = document.querySelector("[data-top-bar]");

  if (bar && Date.now() > Date.parse(bar.dataset.until)) bar.remove();
};
