// "Do we deliver to you?" A ZIP code in, an answer out, from the same
// delivery area and the same rule the order form uses (validate.mjs),
// so the home page can never promise what the form refuses. The area
// rides in the page as JSON; nothing is fetched.

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

export const answerFor = (zip, area) => {
  const z = digitsOf(zip);
  const info = zipInfo(z, area);

  if (info.status === "invalid") {
    return { tone: "", text: "Enter a five-digit ZIP code." };
  }
  if (info.status === "approved") {
    const note = info.state && info.state.note ? ` ${info.state.note}` : "";

    return {
      tone: "ok",
      text: `Yes! We deliver to ${townFor(z, area)} on Thursdays. Order by ` +
        `noon on Wednesday.${note}`,
    };
  }
  if (info.status === "unlisted") {
    return {
      tone: "wait",
      text: "A little outside our usual area: delivery is $3 more, and " +
        "we'll confirm with you before we charge you.",
    };
  }

  return {
    tone: "no",
    text: "That's outside our delivery area. On-farm pickup and the " +
      "Scituate drop site are open to everyone.",
  };
};

const wire = (form) => {
  const area = JSON.parse(form.querySelector("[data-zip-area]").textContent);
  const input = form.querySelector("[name='zip']");
  const result = form.querySelector("[data-zip-result]");
  const show = () => {
    const a = answerFor(input.value, area);

    result.textContent = a.text;
    result.dataset.tone = a.tone;
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
      result.dataset.tone = "";
    }
  });
};

// Under Node (the tests import answerFor) there is no document.
if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    for (const form of document.querySelectorAll("[data-zip-check]")) {
      wire(form);
    }
  });
}
