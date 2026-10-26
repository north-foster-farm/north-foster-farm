{{- /* The figure as Markdown: the photo by its alt text, then its
  caption in italics, as the HTML figure shows them. A news post's
  photo is a JPEG at a fixed address, /mail/<post>/<name>.jpg, because
  the post goes out as Farm News mail (#483) and mail needs a public
  address that never changes, and Hugo's own are fingerprinted. */ -}}
{{- $image := resources.Get (.Get "src") -}}
{{- if not $image -}}
  {{- errorf "figure: no image at assets/%s (%s)" (.Get "src") .Position -}}
{{- end -}}
{{- $caption := .Get "caption" -}}
{{- with .Inner }}{{ $caption = . | strings.TrimSpace }}{{ end -}}
{{- $url := ($image.Resize "1150x webp q82").Permalink -}}
{{- if eq .Page.Section "news" -}}
  {{- $post := path.Base (strings.TrimSuffix "/" .Page.RelPermalink) -}}
  {{- $name := path.Base (.Get "src") | strings.TrimSuffix (path.Ext (.Get "src")) -}}
  {{- $url = (resources.Copy (printf "mail/%s/%s.jpg" $post $name) ($image.Resize "1024x jpg q82")).Permalink -}}
{{- end }}
![{{ .Get "alt" }}]({{ $url }})
{{- with $caption }}

*{{ . }}*
{{- end -}}
