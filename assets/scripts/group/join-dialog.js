// Joining a buying group (#495, James's decision 5): before a group's
// code, join link or QR code applies for someone not yet in the group,
// the dialog in partials/group/join-dialog.html asks first. The order
// page's code box and link and the sign-up page all ask through here,
// so the question is the same everywhere.
//
// confirmJoin(name) -> a promise of true for "Join group", false for
// Cancel or Escape. With no dialog on the page it is false: nothing
// joins unasked.

export const confirmJoin = (name, { root = document } = {}) => {
  const dialog = root.getElementById("group-join");

  if (!dialog || typeof dialog.showModal !== "function") {
    return Promise.resolve(false);
  }

  const yes = dialog.querySelector("[data-group-join-yes]");
  const no = dialog.querySelector("[data-group-join-no]");
  const returnTo = root.activeElement;

  dialog.querySelector("[data-group-join-name]").textContent = name;

  return new Promise((resolve) => {
    const done = (answer) => {
      yes.removeEventListener("click", onYes);
      no.removeEventListener("click", onNo);
      dialog.removeEventListener("cancel", onCancel);
      if (dialog.open) dialog.close();
      // Back where they were, unless joining moves them on.
      if (!answer && returnTo && returnTo.focus) returnTo.focus();
      resolve(answer);
    };
    const onYes = () => done(true);
    const onNo = () => done(false);
    // Escape is Cancel.
    const onCancel = (e) => {
      e.preventDefault();
      done(false);
    };

    yes.addEventListener("click", onYes);
    no.addEventListener("click", onNo);
    dialog.addEventListener("cancel", onCancel);
    dialog.showModal();
    yes.focus();
  });
};
