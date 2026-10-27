// The farm's maintenance message (#267), shown at the top of the page
// when the site refuses a change because maintenance is on. Styled
// here, not in a class, so nothing for PurgeCSS to strip.

const STYLE = "position:sticky;top:0;z-index:2000;margin:0;" +
  "padding:.75rem 1rem;text-align:center;background:#fff3cd;" +
  "color:#664d03;border-bottom:1px solid #ffecb5";

export const announce = (message) => {
  if (typeof document === "undefined" || !document.body || !message) return;

  let bar = document.getElementById("maintenance-notice");

  if (!bar) {
    bar = document.createElement("p");
    bar.id = "maintenance-notice";
    bar.setAttribute("role", "alert");
    bar.style.cssText = STYLE;
    document.body.prepend(bar);
  }
  bar.textContent = message;
};
