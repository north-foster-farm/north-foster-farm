// The farm's email signatures, rendered for the staging toolbar's
// Signatures panel (#267, #335). data/signatures.json holds the parts
// every signature shares and each variant's name; this turns each into
// the HTML a mail app takes on paste. Nothing here sends mail.

import company from "../../../data/company.json" with { type: "json" };
import data from "../../../data/signatures.json" with { type: "json" };

const escape = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

// A closing without its mark, for labels and ids: "Talk soon!" is
// "Talk soon" and talk-soon. The signature keeps the mark as listed.
const bare = (closing) => closing.replace(/[,.!]+$/, "");

const slug = (closing) => bare(closing).toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Each person's signature as James made it, then one per closing in
// data/signatures.json with the closing baked in, so an email never
// ends on "Thanks," with nothing under it (James, 2026-10-25). A
// label reads "James: Thanks", for picking one in the mail app.
export const variants = () => data.variants.flatMap((v) => [
  v,
  ...data.closings.map((closing) => ({
    ...v,
    id: `${v.id}-${slug(closing)}`,
    label: `${v.label}: ${bare(closing)}`,
    closing,
  })),
]);

export const entry = (id) => variants().find((v) => v.id === id);

// Nothing is left to fill in: James's final markup has a name, the
// logo, two links and the thanks line, and no role, email or phone.
export const missing = () => [];

const ICON = "display: inline-block; border: 0; vertical-align: middle; " +
  "padding-right: 8px;";

const row = (pad, inner) => `  <tr>
    <td align="left" valign="top"${
  pad ? ` style="padding-top: ${pad}px;"` : ""}>
      ${inner}
    </td>
  </tr>`;

// James's markup for a signature (2026-10-24), the same for every
// variant but the name and the closing, a line of its own just above
// the name. The pictures load from the live site, which serves them
// only once a release carries static/email-signature/.
const build = (v, images) => {
  const { shared } = data;
  const link = (href, text) => `<a href="${escape(href)}" style="color: ${
    shared.color}; text-decoration: none;">${escape(text)}</a>`;
  const icon = (file) => `<img src="${escape(
    `${images}/${file}`)}" alt="" width="13" height="13" ` +
    `style="${ICON}">`;
  const logo = `<img src="${escape(`${images}/${shared.logo}`)}" ` +
    `alt="${escape(company.name)}" width="192" height="16" style="display: ` +
    `block; border: 0; width: 192px; max-width: 100%; height: auto;">`;

  const host = shared.site.replace(/^https?:\/\/(www\.)?/, "");
  const links = `${icon(shared.globe)}${link(shared.site, host)}<br>
      ${icon(shared.instagram.image)}${
  link(shared.instagram.url, shared.instagram.handle)}`;

  const html = `<table border="0" cellpadding="0" cellspacing="0" ` +
    `style="border-collapse: collapse; font-family: Roboto, Helvetica, ` +
    `Arial, sans-serif; line-height: 18px">
  <tr>
    <td>&nbsp;</td>
  </tr>
${v.closing ? `${row(0, escape(v.closing))}\n` : ""}${
  row(0, `<b>${escape(v.name)}</b>`)}
${row(7, logo)}
${row(11, links)}
${row(11, `<i>${escape(shared.thanks)}</i>`)}
</table>`;

  const text = [
    ...v.closing ? [v.closing] : [],
    v.name,
    shared.site,
    shared.instagram.url,
    shared.thanks,
  ].join("\n");

  return { html, text };
};

export const render = (v) => build(v, data.shared.images);

// The staging panel's own preview. Its srcdoc frame answers to the
// page's CSP, whose img-src leaves out the live site's host, so the
// preview takes the pictures from the deploy's own /email-signature/
// instead. Copy and Open alone keep the live URLs (#335).
const previewImages = new URL(data.shared.images).pathname;

export const preview = (v) => build(v, previewImages).html;

// The page "Open alone" shows: the signature and nothing else, so
// Select All and Copy picks up only that (James, 2026-10-17).
export const alone = (html) =>
  `<html><head></head><body>${html}</body></html>`;

export const library = () => variants().map((v) => ({
  id: v.id,
  label: v.label,
  missing: missing(v),
  ...render(v),
  preview: preview(v),
}));
