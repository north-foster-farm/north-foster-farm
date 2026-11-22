// The site search's matcher (#402), over /search.json's entries
// (layouts/index.search.json). Every word typed must start a word of
// the entry; plurals match singulars, and "pick-up" matches "pickup".
// A word matched in the title counts most, then in the entry's
// keywords from data/search.yaml, then in its page or detail, then in
// its first words. A whole word beats a prefix, an early word a late
// one. A typed word of five letters or more that starts no word in
// the index is read as the index's word one letter away from it
// ("delivary", "chiken"). Results come in groups, by kind.

// The groups, in the order they show. Their names are drafts.
export const GROUPS = [
  { key: "answers", name: "Answers", kinds: ["fact", "town"] },
  { key: "products", name: "Products", kinds: ["product"] },
  { key: "pages", name: "Pages", kinds: ["section", "page"] },
  { key: "news", name: "News", kinds: ["news"] },
];

const WEIGHTS = { title: 3, words: 2.5, context: 1, snippet: 0.5 };

const TYPO_FROM = 5;

const stem = (w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);

// -> the words of a text, lower case and stemmed, a hyphenated word
// both as its parts and joined.
export const words = (text) => {
  const out = [];

  for (const raw of String(text ?? "").toLowerCase()
    .split(/[^a-z0-9.'’-]+/)) {
    const word = raw.replace(/['’]/g, "").replace(/^[.-]+|[.-]+$/g, "");

    if (!word) continue;

    const parts = word.split("-").filter(Boolean);

    for (const part of parts) out.push(stem(part));
    if (parts.length > 1) out.push(stem(parts.join("")));
  }

  return out;
};

const fieldsOf = (entry) => ({
  title: words([entry.title, entry.group, entry.label].join(" ")),
  words: words([entry.words, ...(entry.zips || [])].join(" ")),
  context: words([entry.page, entry.detail, entry.note].join(" ")),
  snippet: words(entry.snippet),
});

// -> the entries made ready to search, with every word they hold.
export const index = (entries) => {
  const list = entries.map((entry, order) => ({
    entry, order, fields: fieldsOf(entry),
  }));
  const vocab = new Map();

  for (const { fields } of list) {
    for (const field of Object.values(fields)) {
      for (const w of field) vocab.set(w, (vocab.get(w) || 0) + 1);
    }
  }

  return { list, vocab };
};

// -> how many letters apart two words are, up to 2: one added, taken
// away, changed, or two side by side swapped.
const apart = (a, b) => {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 1) return 2;

  let i = 0;

  while (i < a.length && a[i] === b[i]) i += 1;

  const rest = (x, y) => (a.slice(x) === b.slice(y) ? 1 : 2);

  if (a.length === b.length) {
    if (a[i] === b[i + 1] && a[i + 1] === b[i]
      && a.slice(i + 2) === b.slice(i + 2)) return 1;

    return rest(i + 1, i + 1);
  }

  return a.length > b.length ? rest(i + 1, i) : rest(i, i + 1);
};

// A typed word that starts no word in the index, read as the most
// common word one letter away, if there is one.
const mend = (word, raw, vocab) => {
  if (raw.length < TYPO_FROM) return word;
  for (const w of vocab.keys()) if (w.startsWith(word)) return word;

  let best = null;

  for (const [w, n] of vocab) {
    if (apart(word, w) === 1 && (!best || n > best.n)) best = { w, n };
  }

  return best ? best.w : word;
};

const typedWords = (query, vocab) => {
  const raws = String(query ?? "").toLowerCase().split(/\s+/)
    .filter(Boolean);

  return raws.flatMap((raw) => words(raw).map((w) => mend(w, raw, vocab)));
};

// -> how well an entry matches the typed words, or 0 if one is missing.
const score = (fields, typed) => {
  let total = 0;

  for (const word of typed) {
    let best = 0;

    for (const [name, list] of Object.entries(fields)) {
      const at = list.findIndex((w) => w.startsWith(word));

      if (at === -1) continue;

      const whole = list.includes(word);
      const s = WEIGHTS[name] * (whole ? 2 : 1)
        + 0.1 / ((whole ? list.indexOf(word) : at) + 1);

      if (s > best) best = s;
    }
    if (!best) return 0;
    total += best;
  }

  return total;
};

// -> the groups that match, in GROUPS' order, each with its entries
// best first: [{ key, name, entries }]. An empty query matches nothing.
export const search = (indexed, query) => {
  const typed = typedWords(query, indexed.vocab);

  if (!typed.length) return [];

  const scored = indexed.list
    .map((item) => ({ item, s: score(item.fields, typed) }))
    .filter(({ s }) => s > 0)
    .sort((a, b) => b.s - a.s || a.item.order - b.item.order);

  return GROUPS.map(({ key, name, kinds }) => ({
    key,
    name,
    entries: scored.filter(({ item }) => kinds.includes(item.entry.kind))
      .map(({ item }) => item.entry),
  })).filter((group) => group.entries.length);
};
