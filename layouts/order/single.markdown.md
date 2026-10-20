{{- /*
  The order page as Markdown, for llms.txt (Q21a): its words, then the
  items on offer as partials/order/catalog.html lists them, from the
  same groups, in stock only: the page's default view (#267). Prices
  as of the build; the page's stock check is live.
*/ -}}
# {{ .Title }}

{{ .RenderShortcodes | strings.TrimSpace }}
{{ range where (partial "order/groups.html" .) "out" false }}
## {{ .short }}{{ with .unit }} ({{ . }}){{ end }}

{{ range where .items "out" false -}}
- {{ .label }}: ${{ .price }}{{ with .unit }} {{ . }}{{ end }}{{ with .note }} · {{ . }}{{ end }}
{{ end -}}
{{- end -}}
