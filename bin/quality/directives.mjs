// The exception directives in a file, for check:exceptions (#782 step
// 3). One form for every tool: its narrowest directive, the rule's
// name, then its entry on #791 (rule exceptions log) and the reason:
//
//   // eslint-disable-next-line max-params -- #791 c7075001234: reason
//   /* stylelint-disable-next-line declaration-no-important -- #791 c…: … */
//   // @ts-expect-error TS2345 -- #791 c7075001234: reason
//   # shellcheck disable=SC2034 # #791 c7075001234: reason
//
// Scripts are read through ESLint's parser, so text that only looks
// like a directive (a test's seed in a string) is not one.
import { Linter } from "eslint";

export const CITE = /#791 c\d+/;

const linter = new Linter({ "configType": "flat" });

// A script's comments, as { line, text }, or [] if it does not parse.
const scriptComments = (text) => {
  for (const sourceType of ["module", "script"]) {
    const messages = linter.verify(text, [{ "languageOptions": {
      "ecmaVersion": "latest", sourceType } }]);
    if (!messages.some((m) => m.fatal)) {
      return linter.getSourceCode().getAllComments()
        .map((c) => ({ "line": c.loc.start.line, "text": c.value.trim() }));
    }
  }
  return [];
};

// A stylesheet's comments: block comments, and SCSS's line comments.
const styleComments = (text) => [
  ...text.matchAll(/\/\*([\s\S]*?)\*\/|\/\/([^\n]*)/g),
].map((m) => ({
  "line": text.slice(0, m.index).split("\n").length,
  "text": (m[1] ?? m[2]).trim(),
}));

const LINT = /^(eslint|stylelint)-disable(?:-next-line|-line)?(?=\s|$)(.*)$/s;

// What is wrong with one comment, or null.
const commentFault = ({ text }) => {
  if (/^@ts-(?:ignore|nocheck)\b/.test(text)) {
    return "@ts-ignore and @ts-nocheck are never allowed";
  }
  if (/^@ts-expect-error\b/.test(text) && !CITE.test(text)) {
    return "@ts-expect-error cites no #791 c<id>";
  }
  const match = LINT.exec(text);
  if (!match) return null;
  const [rules, ...reason] = match[2].split("--");
  if (!rules.trim()) return `${match[1]}-disable names no rule`;
  if (!CITE.test(reason.join("--"))) {
    return `${match[1]} directive cites no #791 c<id>`;
  }
  return null;
};

const shellFaults = (text) => text.split("\n").flatMap((line, i) =>
  (/^\s*#\s*shellcheck\s+disable=/.test(line) && !CITE.test(line)
    ? [{ "line": i + 1, "fault": "shellcheck disable cites no #791 c<id>" }]
    : []));

const KINDS = {
  "script": scriptComments,
  "style": styleComments,
};

// Every fault in a file of the given kind, as { line, fault }.
export const directiveFaults = (kind, text) => {
  if (kind === "shell") return shellFaults(text);
  return KINDS[kind](text).flatMap((comment) => {
    const fault = commentFault(comment);
    return fault ? [{ "line": comment.line, fault }] : [];
  });
};

// A tracked file's kind, from its name and first line, or null.
export const kindOf = (path, firstLine) => {
  if (/\.(?:js|mjs|cjs)$/.test(path)) return "script";
  if (/\.(?:scss|css)$/.test(path)) return "style";
  if (/\.(?:sh|bash)$/.test(path)) return "shell";
  if (/\.[^/]+$/.test(path) || !firstLine.startsWith("#!")) return null;
  if (/\bnode\b/.test(firstLine)) return "script";
  return /\b(?:sh|bash|dash)\b/.test(firstLine) ? "shell" : null;
};
