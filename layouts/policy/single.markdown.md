{{- /*
  The page as Markdown, at index.md beside its HTML, for llms.txt to
  link in place of a paraphrase (Q21a, #192): the same source, with
  its shortcodes filled in from the same data. A page opts in with
  outputs: ["html", "markdown"] in its front matter. Shortcodes that
  draw HTML have a .markdown.md twin in layouts/shortcodes/.
*/ -}}
# {{ .Title }}

{{ .RenderShortcodes | replaceRE `\n{3,}` "\n\n" | strings.TrimSpace }}
