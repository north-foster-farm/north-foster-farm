{{- /*
  The order page as Markdown, for llms.txt (Q21a): its words, then the
  items on offer as partials/order/catalog.html lists them, from the
  same groups (in stock only). Prices as of the build; the page's
  stock check is live.
*/ -}}
# {{ .Title }}

{{ .RenderShortcodes | strings.TrimSpace }}
{{ range partial "order/groups.html" . }}
## {{ .short }}{{ with .unit }} ({{ . }}){{ end }}

{{ range .items -}}
- {{ .label }}: ${{ .price }}{{ with .unit }} {{ . }}{{ end }}{{ with .note }} · {{ . }}{{ end }}
{{ end -}}
{{- end -}}
