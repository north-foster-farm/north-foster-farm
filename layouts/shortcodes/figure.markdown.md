{{- /* The figure as Markdown: the photo by its alt text, then its
  caption in italics, as the HTML figure shows them. */ -}}
{{- $image := resources.Get (.Get "src") -}}
{{- if not $image -}}
  {{- errorf "figure: no image at assets/%s (%s)" (.Get "src") .Position -}}
{{- end -}}
{{- $caption := .Get "caption" -}}
{{- with .Inner }}{{ $caption = . | strings.TrimSpace }}{{ end }}
![{{ .Get "alt" }}]({{ ($image.Resize "1150x webp q82").Permalink }})
{{- with $caption }}

*{{ . }}*
{{- end -}}
