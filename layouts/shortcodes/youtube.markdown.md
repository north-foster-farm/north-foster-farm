{{- /* The YouTube embed as Markdown: a link to the video. */ -}}
{{- $id := .Get "id" | default (.Get 0) -}}
[{{ .Get "title" | default "YouTube video" }}](https://www.youtube.com/watch?v={{ $id }})
