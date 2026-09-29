{{- /* The delivery area as Markdown: a table of towns and ZIP codes
  per state, as the HTML shortcode draws them. */ -}}
{{- range hugo.Data.delivery.area.states }}

### {{ .name }}
{{ with .note }}
{{ . }}
{{ end }}
| Town | ZIP codes |
| ---- | --------- |
{{ range .towns -}}
| {{ .town }} | {{ delimit .zips ", " }} |
{{ end -}}
{{- end }}
