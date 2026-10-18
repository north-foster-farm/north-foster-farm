// The farm's email signatures, rendered for the staging toolbar's
// Signatures panel (#267). One data file, data/signatures.json, defines
// every variant; this turns each into the HTML a mail app takes on
// paste: a table with inline styles only, no classes, no wrappers.
//
// A variant's `email` is "sales" or "info" (the farm's addresses in
// data/company.json) or an address of its own; `phone` is "company" or
// a number of its own. A field left null is not invented: the preview
// shows a bracketed gap, and `missing` lists it so the panel can say
// what is still owed. Nothing here sends mail.

import company from "../../../data/company.json" with { type: "json" };
import data from "../../../data/signatures.json" with { type: "json" };

const escape = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

const INK = "#1d1c1b";
const MUTED = "#5e5e5f";
const FONT = "font-family:Arial,Helvetica,sans-serif;font-size:13px;" +
  "line-height:1.4";

const ADDRESSES = { sales: company.email, info: company.emailInfo };

const emailOf = (v) => (v.email ? ADDRESSES[v.email] || v.email : null);

const phoneOf = (v) => {
  if (!v.phone) return null;

  return v.phone === "company"
    ? { display: company.phone.display, plain: company.phone.plain }
    : { display: v.phone, plain: v.phone.replace(/[^\d+]/g, "") };
};

// The primary address, so a signature pasted into a real message keeps
// loading its pictures from the live site, not from this deploy.
const imageBase = (env) => (env.SITE_URL || env.URL
  || env.DEPLOY_PRIME_URL || "http://localhost:8888").replace(/\/+$/, "");

export const variants = () => data.variants;

export const entry = (id) => data.variants.find((v) => v.id === id);

// What a variant lacks, by field name.
export const missing = (v) => ["role", "email", "phone"]
  .filter((field) => !v[field]);

const gap = (label) =>
  `<span style="color:${MUTED}">[${escape(label)}]</span>`;

const img = (base, file, alt, size) =>
  `<img src="${escape(`${base}/email-signature/${file}`)}" alt="${
    escape(alt)}" width="${size}" height="${size}" ` +
  `style="display:inline-block;vertical-align:middle;border:0" />`;

export const render = (v, env = process.env) => {
  const base = imageBase(env);
  const email = emailOf(v);
  const phone = phoneOf(v);
  const web = base;
  const { shared } = data;
  const logoSrc = escape(`${base}/email-signature/${shared.logo}`);
  const logo = `<img src="${logoSrc}" alt="${escape(company.name)}" ` +
    `width="240" height="20" style="display:block;border:0" />`;
  const link = (href, text) => `<a href="${escape(href)}" ` +
    `style="color:${INK};text-decoration:underline">${escape(text)}</a>`;

  const lines = [
    `<strong style="font-size:15px">${escape(v.name)}</strong>`,
    v.role ? escape(v.role) : gap("role"),
    email ? link(`mailto:${email}`, email) : gap("email"),
    phone ? link(`tel:${phone.plain}`, phone.display) : gap("phone"),
  ];
  const icons = [
    `<a href="${escape(web)}" style="text-decoration:none">${
      img(base, shared.globe, "Website", 16)}</a>`,
    `<a href="${escape(shared.instagram.url)}" ` +
    `style="text-decoration:none">${
      img(base, shared.instagram.image, "Instagram", 16)}</a>`,
  ];

  const html = `<table cellpadding="0" cellspacing="0" border="0" ` +
    `style="${FONT};color:${INK};border-collapse:collapse">` +
    `<tr><td style="padding:0 0 8px 0">${logo}</td></tr>` +
    `<tr><td style="padding:0 0 0 10px;border-left:2px solid #d6d6d6">` +
    `${lines.join("<br />")}` +
    `<br />${icons.join(" &nbsp;")}</td></tr></table>`;

  const text = [
    v.name,
    v.role || "[role]",
    email || "[email]",
    phone ? phone.display : "[phone]",
    web,
  ].join("\n");

  return { html, text };
};

// The page "Open alone" shows: the signature and nothing else, so
// Select All and Copy picks up only that (James, 2026-10-17).
export const alone = (html) =>
  `<html><head></head><body>${html}</body></html>`;

export const library = (env = process.env) => data.variants.map((v) => ({
  id: v.id,
  label: v.label,
  missing: missing(v),
  ...render(v, env),
}));
