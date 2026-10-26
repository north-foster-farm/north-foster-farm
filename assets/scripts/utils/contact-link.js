// A message with "[contact us]" in it, written into an element with
// that phrase as a mailto link to the support address (#240). The
// address comes from the nearest [data-support], which the page writes
// from data/company.json; the rest of the text goes in as text.

const MARK = "[contact us]";

export const say = (element, message) => {
  const holder = element.closest("[data-support]");
  const address = holder && holder.dataset.support;
  const at = String(message).indexOf(MARK);

  element.textContent = "";
  if (at < 0 || !address) {
    element.textContent = String(message).replace(MARK, "contact us");

    return;
  }

  const link = document.createElement("a");

  link.href = `mailto:${address}`;
  link.textContent = "contact us";
  element.append(
    message.slice(0, at), link, message.slice(at + MARK.length)
  );
};
