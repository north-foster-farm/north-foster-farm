// Check built HTML against Bootstrap 5.3's grid rules and its v5 class
// names. Run it on a Hugo build:
//
//   bin/grid/check.mjs public
//
// It prints one line per finding and exits 1 if any is an error. The
// rules, with the docs' sentences behind them, are the G numbers here:
// a row sits in a container or a column (G1), its children are
// columns (G2) and hold no bare content (G3), a nested row sits in a
// column (G4), no horizontal spacing utilities fight the gutter on a
// row (G5), no gutter wider than the container's padding (G6), no
// container inside another (G8, a warning), breakpoint classes that
// exist (G10), no v4 names (G12), no grid on an element that cannot
// be a flex container (G13), and no nested row in a column that is
// outside any row (G15, a warning). A .g-0 row may go edge to edge
// without a container (G7).
//
// The HTML is read with a small tag scanner, not a full parser: Hugo's
// output closes its elements, and the scanner closes the few that HTML
// lets go unclosed (p, li, option) when their parent closes.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "source", "track", "wbr",
]);
const RAW = new Set(["script", "style", "textarea", "title"]);
const BP = "(?:sm|md|lg|xl|xxl)";

const isContainer = (c) =>
  new RegExp(`^container(?:-(?:fluid|${BP}))?$`).test(c);
const isCol = (c) =>
  new RegExp(`^col(?:-${BP})?(?:-(?:[1-9]|1[0-2]|auto))?$`).test(c);

// Grid classes that look right but are not in Bootstrap 5.3: the v3
// and v4 "xs" infix, spans past 12, offsets past 11, row-cols past 6.
const BAD_GRID = [
  [/^(?:col|offset|order|row-cols|g|gx|gy)-xs(?:-|$)/,
    "no xs infix in v5: the unprefixed class is xs"],
  [new RegExp(`^col(?:-${BP})?-(?:0|1[3-9]|[2-9]\\d)$`),
    "columns span 1 to 12"],
  [new RegExp(`^offset(?:-${BP})?-(?:1[2-9]|[2-9]\\d)$`),
    "offsets run 0 to 11"],
  [new RegExp(`^row-cols(?:-${BP})?-(?:0|[7-9]|\\d\\d)$`),
    "row-cols run 1 to 6, or auto"],
  [new RegExp(`^(?:col|offset|order|row-cols|container)-(?!${BP}(?:-|$))`
    + "(?:xsm|small|medium|large|xl-|xxxl)"), "not a breakpoint infix"],
];

// Bootstrap 4 names that v5 renamed or dropped (migration guide).
const V4 = [
  [/^(?:m|p)[lr](?:-(?:sm|md|lg|xl))?-(?:n?[0-6]|auto)$/,
    "v5 uses ms/me/ps/pe"],
  [/^(?:float|text|border|rounded)(?:-(?:sm|md|lg|xl))?-(?:left|right)$/,
    "v5 uses start/end"],
  [/^no-gutters$/, "v5 uses g-0"],
  [/^form-(?:row|group|inline)$/, "v5 dropped form layout classes"],
  [/^form-control-(?:file|range)$/, "v5 dropped this class"],
  [/^custom-(?:control|checkbox|radio|switch|select|file|range)$/,
    "v5 uses form-check, form-select, form-range"],
  [/^sr-only(?:-focusable)?$/, "v5 uses visually-hidden"],
  [/^badge-(?:pill|primary|secondary|success|danger|warning|info|light|dark)$/,
    "v5 uses rounded-pill and bg-* on badges"],
  [/^font-weight-/, "v5 uses fw-*"],
  [/^font-italic$/, "v5 uses fst-italic"],
  [/^text-monospace$/, "v5 uses font-monospace"],
  [/^text-hide$/, "v5 dropped text-hide"],
  [/^rounded-(?:sm|lg)$/, "v5 uses rounded-0 to rounded-5"],
  [/^(?:jumbotron|media|card-deck|card-columns)$/, "v5 dropped this"],
  [/^text-muted$/, "deprecated in 5.3: text-body-secondary"],
];
const V4_ATTR = /^data-(?:toggle|target|dismiss|ride|slide|parent|spy|offset)$/;

// Horizontal spacing utilities on a row fight its gutter math.
const ROW_SPACING = new RegExp(
  `^(?:m[xse]|p[xse]?|m)(?:-${BP})?-(?:n?[1-6]|auto)$`);
// With $grid-gutter-width at 2rem the container pads 1rem a side. The
// site's spacer 5 is 2.25rem and 6 is 4rem (_variables.scss), so a
// gutter of either pulls the row past that padding.
const WIDE_GUTTER = new RegExp(`^gx?(?:-${BP})?-([56])$`);
const SPACERS = { 0: 0, 1: 0.1, 2: 0.75, 3: 1, 4: 1.5, 5: 2.25, 6: 4 };

// A container's side padding in rem: 1, or the least px-* on it.
function padding(container) {
  const pads = (container?.classes || [])
    .map((c) => c.match(new RegExp(`^p[xse]?(?:-${BP})?-([0-6])$`)))
    .filter(Boolean)
    .map((p) => SPACERS[p[1]]);
  return pads.length ? Math.min(...pads) : 1;
}
const NOT_FLEX = new Set(["button", "fieldset", "summary", "legend"]);

// A comment or doctype, or a tag: its slash, name, attributes and
// self-closing slash.
const VALUE = String.raw`(?:"[^"]*"|'[^']*'|[^\s"'>]+)`;
const TAG = new RegExp(String.raw`<!--[\s\S]*?-->|<!\w[^>]*>|`
  + String.raw`<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=/>]+(?:\s*=\s*${VALUE})?)*)`
  + String.raw`\s*(\/?)>`, "g");
const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function attrs(text) {
  const out = {};
  for (const m of text.matchAll(ATTR)) {
    out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
}

// A short name for an element in a message: tag#id.class.class
function label(el) {
  const id = el.attrs.id ? `#${el.attrs.id}` : "";
  const cls = el.classes.length ? `.${el.classes.join(".")}` : "";
  return `${el.tag}${id}${cls}`;
}

export function checkHtml(html) {
  const findings = [];
  const lineAt = (i) => html.slice(0, i).split("\n").length;
  const add = (rule, level, at, message) =>
    findings.push({ rule, level, line: lineAt(at), message });

  const root = { tag: "#root", classes: [], attrs: {} };
  const stack = [root];
  let last = 0;

  const text = (from, to) => {
    const parent = stack[stack.length - 1];
    if (parent.isRow && html.slice(from, to).trim()) {
      add("G3", "error", from,
        `text directly in ${label(parent)}; put it in a column`);
    }
  };

  // The nearest container, row or column above the top of the stack. A
  // template's content lands wherever a script puts it, so the search
  // stops there, and a row in one answers to G1 only by hand.
  const gridAncestor = () => {
    for (let i = stack.length - 1; i > 0; i--) {
      const el = stack[i];
      if (el.isContainer || el.isRow || el.isCol) return el;
      if (el.tag === "template") return el;
    }
    return null;
  };

  TAG.lastIndex = 0;
  let m;
  while ((m = TAG.exec(html))) {
    text(last, m.index);
    last = TAG.lastIndex;
    if (!m[2]) continue;
    const tag = m[2].toLowerCase();
    if (m[1]) {
      const at = stack.findLastIndex((el) => el.tag === tag);
      if (at > 0) stack.length = at;
      continue;
    }
    const a = attrs(m[3]);
    const classes = (a.class || "").split(/\s+/).filter(Boolean);
    const el = {
      tag, attrs: a, classes,
      isContainer: classes.some(isContainer),
      isRow: classes.includes("row"),
      isCol: classes.some(isCol),
    };
    const parent = stack[stack.length - 1];
    const name = label(el);

    for (const c of classes) {
      for (const [re, why] of BAD_GRID) {
        if (re.test(c)) add("G10", "error", m.index, `${name}: ${c}, ${why}`);
      }
      for (const [re, why] of V4) {
        if (re.test(c)) add("G12", "error", m.index, `${name}: ${c}, ${why}`);
      }
    }
    for (const k of Object.keys(a)) {
      if (V4_ATTR.test(k)) {
        add("G12", "error", m.index, `${name}: ${k}, v5 uses data-bs-*`);
      }
    }

    if (parent.isRow && !el.isCol && !RAW.has(tag) && tag !== "template") {
      add("G2", "error", m.index,
        `${name} is a direct child of ${label(parent)}; only columns are`);
    }

    if (el.isRow) {
      const up = gridAncestor();
      const edgeToEdge = classes.some((c) => /^gx?-0$/.test(c));
      if (!up && !edgeToEdge) {
        add("G1", "error", m.index, `${name} is not inside a container`);
      } else if (up?.isRow) {
        add("G4", "error", m.index,
          `${name} sits in ${label(up)} without a column between`);
      } else if (up?.isCol && !up.inRow) {
        add("G15", "warn", m.index,
          `${name} sits in ${label(up)}, a column outside any row`);
      }
      for (const c of classes) {
        if (ROW_SPACING.test(c)) {
          add("G5", "error", m.index,
            `${name}: ${c} on a row changes the gutter's margins`);
        }
        const wide = c.match(WIDE_GUTTER);
        const container = stack.findLast((x) => x.isContainer);
        if (wide && !parent.classes.includes("overflow-hidden")
          && padding(container) < SPACERS[wide[1]] / 2) {
          add("G6", "warn", m.index,
            `${name}: ${c} is wider than the container's padding`);
        }
      }
      if (NOT_FLEX.has(tag)) {
        add("G13", "error", m.index, `${name}: a ${tag} cannot be a flex row`);
      }
    }

    if (el.isContainer) {
      const outer = stack.slice(1).findLast((x) => x.isContainer);
      if (outer) {
        add("G8", "warn", m.index, `${name} is nested in ${label(outer)}`);
      }
    }

    if (el.isCol) el.inRow = parent.isRow;

    if (VOID.has(tag) || m[4]) continue;
    if (RAW.has(tag)) {
      const close = html.indexOf(`</${tag}`, TAG.lastIndex);
      TAG.lastIndex = last = close < 0 ? html.length : close;
      continue;
    }
    stack.push(el);
  }
  text(last, html.length);
  return findings;
}

function* htmlFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* htmlFiles(path);
    else if (name.endsWith(".html")) yield path;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] || "public";
  let errors = 0;
  let warnings = 0;
  for (const file of htmlFiles(dir)) {
    for (const f of checkHtml(readFileSync(file, "utf8"))) {
      if (f.level === "error") errors++;
      else warnings++;
      const where = `${relative(dir, file)}:${f.line}`;
      console.log(`${where} ${f.rule} ${f.level}: ${f.message}`);
    }
  }
  console.log(`grid check: ${errors} errors, ${warnings} warnings`);
  process.exitCode = errors ? 1 : 0;
}
