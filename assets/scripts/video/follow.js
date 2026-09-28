// A signed-in customer's choice for videos playing on their own
// follows them to every browser they sign in on (#161). Each page
// settles the account and this browser once it knows who is signed
// in, then saves a video switch's press to the account. The account
// page saves its own toggle.

import { forget } from "../session/session.js";
import { api } from "../utils/api.js";
import { reconcile } from "./choice.js";
import { Autoplay } from "./video.js";

// Quietly: this browser already follows the press. A save that fails
// is not retried, so a later page brings back the account's value.
const save = async (value) => {
  try {
    const { ok } = await api("/api/account/profile", {
      method: "PATCH", body: { autoplay: value },
    });

    // The next page asks /api/me again rather than trust a cached
    // answer that still holds the old value.
    if (ok) forget();
  } catch {
    // Offline: see above.
  }
};

export const followAccount = (who) => {
  if (!who || !who.signedIn || !who.customer) return;

  const step = reconcile(who.customer.autoplay, Autoplay.stored());

  if (step.adopt) Autoplay.set(step.adopt === "on", { from: "sync" });
  if (step.save) save(step.save);

  document.addEventListener("nff:autoplay", (e) => {
    if (e.detail && e.detail.from === "switch") {
      save(e.detail.on ? "on" : "off");
    }
  });
};
