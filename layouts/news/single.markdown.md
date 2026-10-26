{{- /* A news post as Markdown, for llms.txt (Q21a): its title, date
  and text, shortcodes filled in by their .markdown.md twins. */ -}}
# {{ .Title }}

{{ .Date.Format "January 2, 2006" }}

{{ .RenderShortcodes | replaceRE `\n{3,}` "\n\n" | strings.TrimSpace }}
