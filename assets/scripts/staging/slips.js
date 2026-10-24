// The packing slips: every kind of page the morning packet can hold,
// listed in a sidebar and shown as the PDF itself, each built from
// fixed fake orders by the real packet code, plus today's packet from
// staging's own orders for a chosen day (#334). A view of its own,
// like the signature library, borrowing its look. The list and the
// PDFs come from /api/staging/slips; nothing here sends or stores
// anything.
//
// #slip=<id> on any page opens the view at that page; #slips opens it
// at the top.

const NARROW = "(max-width: 47.99rem)";
const BASE = "/api/staging/slips";
const TODAYS = {
  id: "today", name: "Today's packet",
  note: "Built now from staging's orders for the day below; nothing is " +
    "sent or stored.",
};

export const mountSlips = ({ root, api, onOpen }) => {
  const qs = (sel) => root.querySelector(sel);
  const box = qs("[data-staging-slips]");
  const list = qs("[data-staging-slips-list]");
  const empty = qs("[data-staging-slips-empty]");
  const summary = qs("[data-staging-slips-summary]");
  const count = qs("[data-staging-slips-count]");
  const reader = qs("[data-staging-slips-reader]");
  const frame = qs("[data-staging-slips-frame]");
  const name = qs("[data-staging-slips-name]");
  const note = qs("[data-staging-slips-note]");
  const alone = qs("[data-staging-slips-alone]");
  const download = qs("[data-staging-slips-download]");
  const dayBox = qs("[data-staging-slips-day]");
  const date = qs("[data-staging-slips-date]");
  const item = qs("[data-staging-slips-item]");
  let slips = null;
  let current = null;

  const urlOf = (s) => (s.id === "today"
    ? `${BASE}/today?date=${encodeURIComponent(date.value)}`
    : `${BASE}/${encodeURIComponent(s.id)}`);

  const drawList = () => {
    list.replaceChildren();
    for (const s of slips) {
      const li = item.content.firstElementChild.cloneNode(true);
      const a = li.querySelector("a");

      a.href = `#slip=${encodeURIComponent(s.id)}`;
      a.dataset.id = s.id;
      if (current && current.id === s.id) {
        a.setAttribute("aria-current", "true");
      }
      li.querySelector(".staging-item-name").textContent = s.name;
      li.querySelector(".staging-item-subject").textContent = s.note;
      list.appendChild(li);
    }
    summary.textContent = `${slips.length} pages`;
  };

  // The PDF shown, fetched once and held as a blob URL, so a page is
  // built once (#159): the frame and Download use it, and Open alone
  // the page's own address. A new page or day revokes the old one.
  let blob = null;

  const drop = () => {
    frame.removeAttribute("src");
    if (blob) URL.revokeObjectURL(blob);
    blob = null;
  };

  const link = (url) => {
    for (const a of [alone, download]) {
      if (url) a.href = a === alone ? url : blob;
      else a.removeAttribute("href");
      a.toggleAttribute("aria-disabled", !url);
    }
    download.download = url ? `${current.id}.pdf` : "";
  };

  // A day with nothing to pack, or a page that could not be built,
  // says so plainly, with no frame and nothing to open or download.
  const fail = (words) => {
    drop();
    frame.hidden = true;
    link(null);
    note.textContent = words;
  };

  const show = async () => {
    const url = urlOf(current);
    const shown = current;
    const day = date.value;
    const moved = () => current !== shown || date.value !== day;
    let status = 0;
    let pdf = null;

    note.textContent = shown.note;
    try {
      const res = await fetch(url);

      status = res.status;
      if (res.ok) pdf = await res.blob();
    } catch {
      // A network error: no PDF, said so below.
    }

    // The reader moved on while the page was built.
    if (moved()) return;
    if (status === 404 && shown.id === "today") {
      fail("No orders to pack");

      return;
    }
    if (!pdf) {
      fail("This page couldn't be built. Try again.");

      return;
    }
    drop();
    blob = URL.createObjectURL(pdf);
    frame.src = blob;
    frame.hidden = false;
    link(url);
  };

  const read = (id) => {
    const s = slips && slips.find((x) => x.id === id);

    if (!s) return;
    current = s;
    name.textContent = s.name;
    note.textContent = s.note;
    dayBox.hidden = s.id !== "today";
    show();
    reader.hidden = false;
    box.classList.add("staging-reading");
    drawList();
  };

  const load = async () => {
    if (slips) return;

    const { ok, data } = await api(BASE);

    empty.hidden = ok;
    if (!ok) return;
    slips = [...data.slips, TODAYS];
    date.value = data.today;
    count.textContent = `Pages: ${slips.length}`;
    drawList();
  };

  const open = async (id = null) => {
    onOpen();
    box.hidden = false;
    document.documentElement.classList.add("staging-library-open");
    await load();
    if (!slips) return;
    if (id) read(id);
    else if (!current && !window.matchMedia(NARROW).matches) {
      read(slips[0].id);
    }
  };

  const close = () => {
    box.hidden = true;
    document.documentElement.classList.remove("staging-library-open");
    if (/^#slips?\b/.test(location.hash)) {
      history.replaceState(null, "", location.pathname + location.search);
    }
  };

  const fromHash = () => {
    const m = location.hash.match(/^#slip=([^&]+)/);

    if (m) open(decodeURIComponent(m[1]));
    else if (location.hash === "#slips") open();
  };

  list.addEventListener("click", (ev) => {
    const a = ev.target.closest("a[data-id]");

    if (!a) return;
    ev.preventDefault();
    history.replaceState(null, "", a.getAttribute("href"));
    read(a.dataset.id);
  });
  date.addEventListener("change", () => {
    if (current && date.value) show();
  });
  qs("[data-staging-slips-back]").addEventListener("click", () => {
    current = null;
    reader.hidden = true;
    drop();
    box.classList.remove("staging-reading");
    history.replaceState(null, "", "#slips");
    drawList();
  });
  // The toolbar's button is a link that opens #slips in a new tab.
  for (const b of root.querySelectorAll("[data-staging-slips-close]")) {
    b.addEventListener("click", close);
  }
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !box.hidden) close();
  });
  window.addEventListener("hashchange", fromHash);

  // The count on the toolbar's button, without opening anything.
  return { fromHash, counted: load };
};
