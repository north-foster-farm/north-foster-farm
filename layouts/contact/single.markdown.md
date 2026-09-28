{{- /* The contact page as Markdown, for llms.txt (Q21a): its lead,
  the ways to reach the farm as the page lists them, from the same
  data, and its note. The form is left out. */ -}}
{{- $address := partial "address.html" . -}}
{{- $phone := partial "phone.html" . -}}
{{- $instagram := hugo.Data.socialMedia.instagram.url -}}
# {{ .Title }}

{{ .Params.lead | replaceRE `\]\(#contact-form\)` (printf "](%s#contact-form)" .Permalink) }}

- Call or text: {{ $phone.display }}
- Email: {{ hugo.Data.company.email }}
- Instagram: [@{{ path.Base $instagram }}]({{ $instagram }})
- The farm: {{ $address.street }}, {{ $address.city }}, {{ $address.state }} {{ $address.zip }}

{{ .Params.note }}
