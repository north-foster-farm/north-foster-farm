{{- /* The About page's markets as Markdown: each market from
  data/markets.json with the lines markets.html shows, then the photo
  and its caption. */ -}}
{{- $photo := resources.Get (.Get "photo") -}}
{{- if not $photo -}}
  {{- errorf "markets: no image at assets/%s (%s)" (.Get "photo") .Position -}}
{{- end -}}
{{- range hugo.Data.markets.markets }}
- **{{ .name }}**: {{ .when }}, {{ partial "market/season.html" . }}. {{ .where }}, RI. {{ .href }}
{{- end }}

![{{ .Get "alt" }}]({{ ($photo.Resize "700x webp q82").Permalink }})
{{- with .Inner | strings.TrimSpace }}

*{{ . }}*
{{- end -}}
