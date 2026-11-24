// The library's shelf drawn (docs/refactors/staging-library.md,
// phase 1): the groups search.mjs gives, each email a row from the
// [data-staging-item] template, and the summary's two lines. Every
// value is written as text.

import { LABELS, summaryLine, tally } from "./search.mjs";

export const day = (iso) => new Date(iso).toLocaleString(undefined, {
  month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});

export const badge = (el, e) => {
  el.textContent = LABELS[e.approval] || e.approval;
  el.dataset.approval = e.approval;
};

// One group's section, its heading counting what it lists.
const section = (title, count) => {
  const group = document.createElement("section");
  const h = document.createElement("h2");
  const ol = document.createElement("ol");

  group.className = "staging-group";
  h.textContent = `${title} (${count})`;
  group.append(h, ol);

  return { group, ol };
};

const row = (item) => item.content.firstElementChild.cloneNode(true);

const emailRow = (item, e, current) => {
  const li = row(item);
  const a = li.querySelector("a");
  const tags = li.querySelector(".staging-item-tags");

  a.href = `#email=${encodeURIComponent(e.id)}`;
  a.dataset.id = e.id;
  if (current && current.id === e.id) {
    a.setAttribute("aria-current", "true");
  }
  li.querySelector(".staging-item-name").textContent = e.name;
  li.querySelector(".staging-item-subject").textContent = e.subject;
  badge(tags.firstElementChild, e);
  for (const tag of e.tags) {
    const t = document.createElement("button");

    t.type = "button";
    t.className = "staging-tag";
    t.dataset.tag = tag;
    t.textContent = tag;
    tags.appendChild(t);
  }

  return li;
};

// Every email the deploy wrote, from every session and none, each
// opening as the customer would get it.
const sentRow = (item, m) => {
  const li = row(item);
  const a = li.querySelector("a");

  a.href = `/api/staging/outbox/${encodeURIComponent(m.id)}`;
  a.target = "_blank";
  a.rel = "noopener";
  li.querySelector(".staging-item-name").textContent = m.subject;
  li.querySelector(".staging-item-subject").textContent =
    `${day(m.at)} · to ${[].concat(m.to).join(", ")}`;
  li.querySelector(".staging-item-tags").remove();

  return li;
};

// James's alone (#294); search.mjs leaves it out for anyone else.
const drawSent = (el, { title, items }) => {
  const { group, ol } = section(title, items.length);

  for (const m of items) ol.appendChild(sentRow(el.item, m));
  el.shelf.appendChild(group);
};

const drawGroup = (el, { title, items }, current) => {
  const { group, ol } = section(title, items.length);

  for (const e of items) ol.appendChild(emailRow(el.item, e, current));
  el.shelf.appendChild(group);
};

// The groups are search.mjs's grouped; current is the open email, or
// null.
export const drawShelf = (el, groups, current) => {
  for (const old of el.shelf.querySelectorAll(".staging-group")) old.remove();
  for (const g of groups) {
    if (g.key === "sent") drawSent(el, g);
    else drawGroup(el, g, current);
  }
  el.empty.hidden = !groups.some((g) => g.items.length);
};

export const drawSummary = (el, emails) => {
  el.summary.textContent = summaryLine(emails);
  el.count.textContent = tally(emails);
};
