// Tab completion for bin/nff, built from the usage text the CLI already
// prints, so the two cannot drift: a command added to the usage is
// completed with no second list to keep. `bin/nff completion zsh|bash`
// prints the script (README, "Tab completion").
//
// The usage's layout is what this reads. A command starts a line with
// `  bin/nff`: its words (a group, then an action, and so on, with `a|b`
// for alternatives), then its arguments, which name the flags it takes.
// A flag line continuing it sits deeper (`  [--x ...]`); a description
// sits deeper still and is ignored. A placeholder such as <csv>, <file>
// or <waivers.json> marks an argument that is a file, and a flag
// followed by one (`--out <file>`) takes a file.

const WORD = /^[a-z][a-z-]*(?:\|[a-z][a-z-]*)*$/;
const FILEISH = /^<(?:csv|file|dir|path)[^>]*>$|^<[^>|]*\.(?:json|csv)>$/;
const FLAGS = /--([a-z][a-z0-9-]*)(=?)/g;
const FLAG_FILE = /--([a-z][a-z0-9-]*)\s+(<[^>]*>)/g;
const CONTINUES = /^ {4,36}([[<-].*)$/;

export const SHELLS = ["zsh", "bash"];

// Flags any command accepts, whatever the usage line says: the context
// flags come from the CLI's own table (passed in), these are the rest.
export const ALSO_ACCEPTED = ["--yes", "--no-email", "--scratch"];

const unique = (list) => [...new Set(list)];

// The usage text -> { children, flags, files, fileFlags }.
//   children   Map: a command path ("" or "orders" or "orders cancel")
//              to the words that may follow it.
//   flags      Map: a command path to its flags (a trailing = where the
//              usage writes --flag=value).
//   files      Set: the paths whose arguments are files.
//   fileFlags  the flags that take a file, for any command.
export const parseUsage = (text) => {
  const entries = [];
  let entry = null;

  for (const line of String(text).split("\n")) {
    const head = line.match(/^ {2}bin\/nff (\S.*)$/);

    if (head) {
      const tokens = head[1].split(/\s{2,}/)[0].trim().split(/\s+/);
      let at = 0;

      while (at < tokens.length && tokens[at].startsWith("--")) at += 1;

      const words = [];

      while (at < tokens.length && WORD.test(tokens[at])) {
        words.push(tokens[at].split("|"));
        at += 1;
      }
      entry = {
        words, args: [...tokens.slice(0, at).filter((t) => t.startsWith("--")),
          ...tokens.slice(at)].join(" "),
      };
      entries.push(entry);
    } else if (entry && CONTINUES.test(line)) {
      entry.args += ` ${line.match(CONTINUES)[1]}`;
    } else if (!/^ {37,}\S/.test(line)) {
      // A description line keeps the entry open, since a flag line can
      // follow it; anything else (a blank line, a heading) ends it.
      if (!line.trim() || /^\S/.test(line)) entry = null;
    }
  }

  const children = new Map();
  const flags = new Map();
  const files = new Set();
  const fileFlags = new Set();
  const plain = new Map();

  const add = (map, key, value) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(value);
  };

  for (const { words, args } of entries) {
    const paths = words.reduce((all, options) => all.flatMap(
      (path) => options.map((word) => [...path, word])), [[]]);
    const tokens = args.split(/\s+/).filter(Boolean);
    const positionalFile = tokens.some((t, i) => FILEISH.test(t)
      && !(tokens[i - 1] || "").startsWith("--"));

    for (const m of args.matchAll(FLAG_FILE)) {
      if (FILEISH.test(m[2])) fileFlags.add(`--${m[1]}`);
    }
    for (const path of paths) {
      for (let k = 0; k <= path.length; k += 1) {
        if (k < path.length) add(children, path.slice(0, k).join(" "), path[k]);
      }

      const node = path.join(" ");

      for (const m of args.matchAll(FLAGS)) {
        add(flags, node, `--${m[1]}`);
        add(plain, `${node}\u0000--${m[1]}`, m[2] ? "=" : "");
      }
      if (positionalFile) files.add(node);
    }
  }

  // A flag the usage always writes with = keeps it, so the completion
  // leaves the cursor beside the value.
  const flagged = new Map([...flags].map(([node, set]) => [node,
    [...set].sort().map((flag) => (
      [...plain.get(`${node}\u0000${flag}`)].every((x) => x === "=")
        ? `${flag}=` : flag))]));

  return {
    children: new Map([...children].map(([node, set]) =>
      [node, [...set].sort()])),
    flags: flagged,
    files,
    fileFlags: [...fileFlags].sort(),
  };
};

// The shared data, as shell functions that print one word a line: the
// same text for both shells, so what they complete cannot differ.
const data = (model, globals) => {
  const arm = (node, words) => `    ${JSON.stringify(node)}) printf '%s\\n' ${
    words.join(" ")};;`;
  const tree = [...model.children].sort(([a], [b]) => a.localeCompare(b))
    .map(([node, words]) => arm(node, words));
  const own = [...model.flags].sort(([a], [b]) => a.localeCompare(b))
    .filter(([, list]) => list.length)
    .map(([node, list]) => arm(node, list));
  const files = [...model.files].sort()
    .map((node) => JSON.stringify(node)).join("|");

  return [
    "_nff_children() {", "  case \"$1\" in", ...tree, "  esac", "}", "",
    "_nff_flags() {", "  case \"$1\" in", ...own, "  esac", "}", "",
    "_nff_globals() {", `  printf '%s\\n' ${globals.join(" ")}`, "}", "",
    "_nff_files() {", "  case \"$1\" in",
    ...(files ? [`    ${files}) return 0;;`] : []),
    "  esac", "  return 1", "}", "",
    "_nff_fileflag() {", "  case \"$1\" in",
    ...(model.fileFlags.length
      ? [`    ${model.fileFlags.join("|")}) return 0;;`] : []),
    "  esac", "  return 1", "}", "",
    "_nff_has() {",
    "  [[ \" $(_nff_children \"$1\" | tr '\\n' ' ') \" == *\" $2 \"* ]]",
    "}", "",
  ];
};

const ZSH = [
  "_nff() {",
  "  local node=\"\" extra=0 i word cur prev",
  "  local -a items",
  "  cur=\"${words[CURRENT]}\"",
  "  prev=\"${words[CURRENT-1]}\"",
  "  for (( i = 2; i < CURRENT; i++ )); do",
  "    word=\"${words[i]}\"",
  "    [[ \"$word\" == -* ]] && continue",
  "    if (( extra == 0 )) && _nff_has \"$node\" \"$word\"; then",
  "      node=\"${node:+$node }$word\"",
  "    else",
  "      (( extra++ ))",
  "    fi",
  "  done",
  "  if [[ \"$cur\" == -* ]]; then",
  "    items=( ${(f)\"$(_nff_flags \"$node\")\"} ${(f)\"$(_nff_globals)\"} )",
  "    compadd -- ${items:#*=}",
  "    compadd -S '' -- ${(M)items:#*=}",
  "  elif _nff_fileflag \"$prev\"; then",
  "    _files",
  "  elif (( extra == 0 )) && [[ -n \"$(_nff_children \"$node\")\" ]]; then",
  "    items=( ${(f)\"$(_nff_children \"$node\")\"} )",
  "    compadd -- $items",
  "  elif _nff_files \"$node\"; then",
  "    _files",
  "  fi",
  "}",
  "",
  "# compinit must have run; this runs it if it has not.",
  "if (( ! $+functions[compdef] )); then",
  "  autoload -Uz compinit && compinit",
  "fi",
  "compdef _nff nff bin/nff ./bin/nff",
];

const BASH = [
  "_nff_complete() {",
  "  local node=\"\" extra=0 i word cur prev",
  "  cur=\"${COMP_WORDS[COMP_CWORD]}\"",
  "  prev=\"${COMP_WORDS[COMP_CWORD-1]}\"",
  "  COMPREPLY=()",
  "  for (( i = 1; i < COMP_CWORD; i++ )); do",
  "    word=\"${COMP_WORDS[i]}\"",
  "    [[ \"$word\" == -* ]] && continue",
  "    if (( extra == 0 )) && _nff_has \"$node\" \"$word\"; then",
  "      node=\"${node:+$node }$word\"",
  "    else",
  "      (( extra++ ))",
  "    fi",
  "  done",
  "  if [[ \"$cur\" == -* ]]; then",
  "    COMPREPLY=( $(compgen -W \"$(_nff_flags \"$node\") $(_nff_globals)\" " +
    "-- \"$cur\" | sort -u) )",
  "    if (( ${#COMPREPLY[@]} == 1 )) && [[ \"${COMPREPLY[0]}\" == *= ]]; " +
    "then",
  "      compopt -o nospace 2>/dev/null",
  "    fi",
  "  elif _nff_fileflag \"$prev\"; then",
  "    compopt -o filenames 2>/dev/null",
  "    COMPREPLY=( $(compgen -f -- \"$cur\") )",
  "  elif (( extra == 0 )) && [[ -n \"$(_nff_children \"$node\")\" ]]; then",
  "    COMPREPLY=( $(compgen -W \"$(_nff_children \"$node\")\" -- \"$cur\") )",
  "  elif _nff_files \"$node\"; then",
  "    compopt -o filenames 2>/dev/null",
  "    COMPREPLY=( $(compgen -f -- \"$cur\") )",
  "  fi",
  "}",
  "",
  "complete -F _nff_complete nff bin/nff ./bin/nff",
];

// The usage text -> the script for `shell`. `contexts` are the flags
// that pick a deploy context (from the CLI's own table).
export const completionScript = (shell, usage, { contexts = [] } = {}) => {
  if (!SHELLS.includes(shell)) {
    throw new Error(`Which shell? bin/nff completion ${SHELLS.join("|")}`);
  }

  const model = parseUsage(usage);
  const globals = unique([...contexts.map((c) => `--${c}`), ...ALSO_ACCEPTED]);

  return [
    `# Tab completion for bin/nff (${shell}), made by \`bin/nff completion ${
      shell}\` from its usage text.`,
    "# Regenerate it after the commands change; do not edit it.",
    "",
    ...data(model, globals),
    ...(shell === "zsh" ? ZSH : BASH),
    "",
  ].join("\n");
};
