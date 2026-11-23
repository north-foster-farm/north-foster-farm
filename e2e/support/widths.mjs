// The widths a header or search spec runs at: in the desktop project
// the widths it names, in the phone project its own (null).

export const widthsFor = (project, widths) => (project === "desktop"
  ? widths : [null]);

export const label = (w) => (w ? `${w} px` : "the phone's width");

export const atWidth = async (page, width) => {
  if (width) {
    await page.setViewportSize({ width, height: width >= 992 ? 900 : 664 });
  }
};

// Sets each width the project runs in turn, and yields its label:
// for await (const at of eachWidth(page, info.project.name, [390])).
export async function* eachWidth(page, project, widths) {
  for (const width of widthsFor(project, widths)) {
    await atWidth(page, width);
    yield label(width);
  }
}
