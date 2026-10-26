// The product photos (#486): a thumbnail in each row is a button that
// shows the photo large in one dialog (partials/order/catalog.html),
// with the cut's name under it. The dialog is native: Escape and the
// backdrop close it, and focus returns to the thumbnail.

export const initPhotos = (root = document) => {
  const dialog = root.getElementById("order-photo");

  if (!dialog || typeof dialog.showModal !== "function") return;

  const img = dialog.querySelector("[data-photo-img]");
  const title = dialog.querySelector("[data-photo-title]");

  root.addEventListener("click", (e) => {
    const button = e.target.closest("[data-photo]");

    if (button && !dialog.open) {
      img.src = button.dataset.photoSrc;
      img.srcset = button.dataset.photoSrcset || "";
      img.alt = button.dataset.photoAlt || "";
      title.textContent = button.dataset.photoTitle || "";
      dialog.showModal();
      return;
    }

    if (!dialog.open) return;

    // The backdrop is the dialog's own box outside its panel.
    if (e.target === dialog || e.target.closest("[data-photo-close]")) {
      dialog.close();
    }
  });

  // Let the large image go once the dialog closes, so the next one
  // never flashes the last.
  dialog.addEventListener("close", () => {
    img.removeAttribute("srcset");
    img.removeAttribute("src");
  });
};
