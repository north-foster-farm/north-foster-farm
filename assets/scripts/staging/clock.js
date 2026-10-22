// The toolbar's clock (#294): sets or resets this browser's time for
// the site, in the farm's zone, and says plainly whenever it is set.
// The server keeps it (an offset in the nff_clock cookie) and reads it
// for every request from this browser; see netlify/functions/lib/
// clock.mjs. The page reloads after a change, so everything on it, the
// order page's date lists included, comes from the new time.

import { instant, isoDate, parts } from "../order/lib/zoned.mjs";
import { isBusy, setBusy } from "../utils/busy-button.js";

const pad = (n) => String(n).padStart(2, "0");

// "2026-12-31T06:00", the value a datetime-local field takes, for an
// instant as the farm's clocks read it.
export const fieldValue = (date, timeZone) => {
  const p = parts(date, timeZone);

  return `${isoDate(p)}T${pad(p.hour)}:${pad(p.minute)}`;
};

// The field's value, read as farm time -> the instant, or null.
export const fromField = (value, timeZone) => {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(value || "");

  return m ? instant(m[1], Number(m[2]), Number(m[3]), timeZone) : null;
};

export const spoken = (date, timeZone) => date.toLocaleString("en-US", {
  timeZone, weekday: "short", month: "short", day: "numeric",
  year: "numeric", hour: "numeric", minute: "2-digit",
});

export const mountClock = ({ root, api, timeZone, reload }) => {
  const qs = (sel) => root.querySelector(sel);
  const form = qs("[data-staging-clock]");
  const field = qs("[data-staging-clock-at]");
  const now = qs("[data-staging-clock-now]");
  const banner = qs("[data-staging-clock-banner]");
  const tabClock = qs("[data-staging-tab-clock]");
  const out = qs("[data-staging-out]");

  const draw = (clock) => {
    const at = new Date(clock.now);
    const on = clock.offset !== 0;
    const when = spoken(at, timeZone);

    field.value = fieldValue(at, timeZone);
    now.textContent = on
      ? `Set: the site reads ${when}.`
      : `Off: the site reads the real time, ${when}.`;
    banner.hidden = !on;
    banner.textContent = on ? `Clock set: ${when}, farm time.` : "";
    tabClock.hidden = !on;
    tabClock.textContent = on ? ` · ${when}` : "";
    root.classList.toggle("staging-is-clocked", on);
  };

  const failed = (data) => {
    out.textContent = `Clock: ${(data && data.error) || "failed"}`;
    out.hidden = false;
  };

  // The button stays busy until the page reloads, or the change fails.
  const change = async (button, method, body) => {
    if (isBusy(button)) return;
    setBusy(button, true);

    let answer;

    try {
      answer = await api("/api/staging/clock", { method, body });
    } catch {
      answer = { ok: false, data: { error: "the site didn't answer" } };
    }

    const { ok, data } = answer;

    if (ok) {
      reload();
    } else {
      setBusy(button, false);
      failed(data);
    }
  };

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();

    const at = fromField(field.value, timeZone);

    if (at) {
      change(form.querySelector(".busy-button"), "PUT",
        { at: at.toISOString() });
    }
  });
  qs("[data-staging-clock-reset]").addEventListener("click",
    (ev) => change(ev.currentTarget, "DELETE"));

  return { draw };
};
