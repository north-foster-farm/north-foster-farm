{{- /* The clip as Markdown: its poster, named by the clip's label and
  linked to the MP4, then its caption in italics. */ -}}
{{- $poster := resources.Get (.Get "poster") -}}
{{- if not $poster -}}
  {{- errorf "video: no poster at assets/%s (%s)" (.Get "poster") .Position -}}
{{- end -}}
[![{{ .Get "label" }}]({{ ($poster.Resize "1150x webp q82").Permalink }})]({{ printf "%s.mp4" (.Get "src") | absURL }})
{{- with .Inner | strings.TrimSpace }}

*{{ . }}*
{{- end -}}
