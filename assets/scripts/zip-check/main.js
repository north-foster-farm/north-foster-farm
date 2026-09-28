// The delivery map's ZIP field (#214). A ZIP code in, an answer out,
// from the same delivery area and the same rule the order form uses
// (validate.mjs), so the map can never promise what the form refuses.
// The area rides in the page as JSON; nothing is fetched. Each answer
// is announced as an nff:zip event, and the map drops its pin on that
// ZIP, whose tag shows the answer. The words here are for screen
// readers only, and say what the tag shows: what we deliver there and
// the price. Drafts for James.

import { wireMaps } from "../map/map.js";
import { zipInfo } from "../order/lib/validate.mjs";

const digitsOf = (value) => String(value || "").replace(/\D/g, "").slice(0, 5);

// The town a ZIP belongs to; the first listed when two share one.
const townFor = (zip, area) => {
  for (const state of area.states) {
    for (const town of state.towns) {
      if (town.zips.includes(zip)) return town.town;
    }
  }

  return null;
};

// "fees" is the delivery fee and what outside our area adds to it.
export const answerFor = (zip, area, fees = { fee: 5, extra: 3 }) => {
  const z = digitsOf(zip);
  const info = zipInfo(z, area);

  if (info.status === "invalid") {
    return { tone: "", text: "Enter a five-digit ZIP code." };
  }
  if (info.status === "approved") {
    const town = townFor(z, area);
    const only = info.state && info.state.onlyGroups;

    return {
      tone: "ok",
      text: only
        ? `We deliver eggs to ${town} for $${fees.fee}, but not chicken.`
        : `We deliver eggs and chicken to ${town} for $${fees.fee}.`,
    };
  }
  if (info.status === "unlisted") {
    return {
      tone: "wait",
      text: `We deliver eggs and chicken to ${z} for ` +
        `$${fees.fee + fees.extra}.`,
    };
  }

  return { tone: "no", text: `No delivery to ${z}.` };
};

const wire = (form) => {
  const area = JSON.parse(form.querySelector("[data-zip-area]").textContent);
  const fees = {
    fee: Number(form.dataset.fee),
    extra: Number(form.dataset.extra),
  };
  const input = form.querySelector("[name='zip']");
  const result = form.querySelector("[data-zip-result]");
  const announce = (zip, tone) => {
    document.dispatchEvent(new CustomEvent("nff:zip", {
      detail: { zip, tone },
    }));
  };
  const show = () => {
    const a = answerFor(input.value, area, fees);

    result.textContent = a.text;
    announce(digitsOf(input.value), a.tone);
  };

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    show();
  });
  // Five digits typed is an answer; an emptied field clears it.
  input.addEventListener("input", () => {
    const z = digitsOf(input.value);

    if (z.length === 5) {
      show();
    } else if (!z.length) {
      result.textContent = "";
      announce("", "");
    }
  });
};

// Under Node (the tests import answerFor) there is no document.
if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    for (const form of document.querySelectorAll("[data-zip-check]")) {
      wire(form);
    }
    wireMaps();
  });
}
