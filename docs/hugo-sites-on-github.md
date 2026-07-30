# Big, popular Hugo sites on GitHub

Compiled 2026-07-30. Every repo listed here was **verified** as Hugo by
reading its file tree through the authenticated GitHub API, looking for
a real Hugo config (`hugo.toml` / `hugo.yaml` / `config/_default/*`),
`archetypes/`, or `layouts/` — never by GitHub topic tags, which are
unreliable in both directions.

Star counts and repo sizes come from the GitHub API on that date.

Contents:

- [Production sites built with Hugo](#production-sites-built-with-hugo)
- [Popular Hugo themes and starters](#popular-hugo-themes-and-starters)
- [Checked and ruled out](#checked-and-ruled-out)
- [E-commerce with Hugo](#e-commerce-with-hugo)
- [Tailwind CSS with Hugo](#tailwind-css-with-hugo)

## Production sites built with Hugo

Sorted by stars. "Size" is the full repo, the best available proxy for
how big the site really is.

| Repo | Stars | Size | Live site |
| --- | ---: | ---: | --- |
| [twbs/bootstrap](https://github.com/twbs/bootstrap) | 174,536 | 316 MB | [getbootstrap.com](https://getbootstrap.com) |
| [thanos-io/thanos](https://github.com/thanos-io/thanos) | 14,159 | 245 MB | [thanos.io](https://thanos.io) |
| [conventional-commits/conventionalcommits.org](https://github.com/conventional-commits/conventionalcommits.org) | 9,115 | 1.5 MB | [conventionalcommits.org](https://www.conventionalcommits.org) |
| [kubernetes/website](https://github.com/kubernetes/website) | 5,326 | 560 MB | [kubernetes.io](https://kubernetes.io) |
| [docker/docs](https://github.com/docker/docs) | 4,619 | 739 MB | [docs.docker.com](https://docs.docker.com) |
| [SeleniumHQ/seleniumhq.github.io](https://github.com/SeleniumHQ/seleniumhq.github.io) | 1,400 | 3.9 GB | [selenium.dev](https://www.selenium.dev) |
| [gohugoio/hugoDocs](https://github.com/gohugoio/hugoDocs) | 1,161 | 181 MB | [gohugo.io](https://gohugo.io) |
| [dapr/docs](https://github.com/dapr/docs) | 1,013 | 391 MB | [docs.dapr.io](https://docs.dapr.io) |
| [open-telemetry/opentelemetry.io](https://github.com/open-telemetry/opentelemetry.io) | 942 | 112 MB | [opentelemetry.io](https://opentelemetry.io) |
| [letsencrypt/website](https://github.com/letsencrypt/website) | 908 | 142 MB | [letsencrypt.org](https://letsencrypt.org) |
| [istio/istio.io](https://github.com/istio/istio.io) | 820 | 466 MB | [istio.io](https://istio.io) |
| [etcd-io/website](https://github.com/etcd-io/website) | 192 | 17 MB | [etcd.io](https://etcd.io) |
| [kubeflow/website](https://github.com/kubeflow/website) | 185 | 141 MB | [kubeflow.org](https://www.kubeflow.org) |
| [chef/chef-web-docs](https://github.com/chef/chef-web-docs) | 142 | 163 MB | [docs.chef.io](https://docs.chef.io) |
| [rancher/docs](https://github.com/rancher/docs) | 141 | 108 MB | [rancher.com/docs](https://rancher.com/docs) |
| [jaegertracing/documentation](https://github.com/jaegertracing/documentation) | 84 | 10 MB | [jaegertracing.io](https://www.jaegertracing.io) |
| [influxdata/docs-v2](https://github.com/influxdata/docs-v2) | 80 | 237 MB | [docs.influxdata.com](https://docs.influxdata.com) |
| [vitessio/website](https://github.com/vitessio/website) | 69 | 197 MB | [vitess.io](https://vitess.io) |
| [tektoncd/website](https://github.com/tektoncd/website) | 68 | 22 MB | [tekton.dev](https://tekton.dev) |
| [fluxcd/website](https://github.com/fluxcd/website) | 65 | 102 MB | [fluxcd.io](https://fluxcd.io) |
| [linkerd/website](https://github.com/linkerd/website) | 60 | 234 MB | [linkerd.io](https://linkerd.io) |
| [crossplane/docs](https://github.com/crossplane/docs) | 59 | 26 MB | [docs.crossplane.io](https://docs.crossplane.io) |
| [goharbor/website](https://github.com/goharbor/website) | 46 | 73 MB | [goharbor.io](https://goharbor.io) |
| [falcosecurity/falco-website](https://github.com/falcosecurity/falco-website) | 39 | 94 MB | [falco.org](https://falco.org) |
| [containerd/containerd.io](https://github.com/containerd/containerd.io) | 39 | 4 MB | [containerd.io](https://containerd.io) |
| [keptn/keptn.sh](https://github.com/keptn/keptn.sh) | 32 | 56 MB | [keptn.sh](https://keptn.sh) |

Notes on the outliers:

- **Bootstrap** tops the list on stars, but those are for the CSS
  framework. The Hugo part is the docs site under `site/`, configured
  from `config.yml` in the repo root.
- **Selenium** is by far the biggest checkout at 3.9 GB. Its Hugo site
  is in `website_and_docs/`; most of the bulk is translations and
  release history, not page content.
- **Thanos** is likewise a project repo whose Hugo site sits in
  `website/`.
- **Kubernetes** and **Docker** are the best examples of very large,
  multi-language, actively maintained Hugo sites. Read those first to
  see Hugo under real load.

Many of the CNCF projects above run the **Docsy** theme, so their
internals look strikingly similar. That similarity is exactly why the
three examples in `example-projects/` were picked from different
niches instead.

## Popular Hugo themes and starters

Not sites, but useful reference implementations.

| Repo | Stars | Demo |
| --- | ---: | --- |
| [adityatelange/hugo-PaperMod](https://github.com/adityatelange/hugo-PaperMod) | 13,806 | [demo](https://adityatelange.github.io/hugo-PaperMod/) |
| [HugoBlox/kit](https://github.com/HugoBlox/kit) | 9,605 | [hugoblox.com](https://hugoblox.com) |
| [CaiJimmy/hugo-theme-stack](https://github.com/CaiJimmy/hugo-theme-stack) | 6,442 | [demo](https://stack.jimmycai.com) |
| [HugoBlox/hugo-theme-academic-cv](https://github.com/HugoBlox/hugo-theme-academic-cv) | 5,010 | [demo](https://hugoblox.com/templates/academic-cv) |
| [alex-shpak/hugo-book](https://github.com/alex-shpak/hugo-book) | 4,073 | [demo](https://hugo-book-demo.netlify.app) |
| [dillonzq/LoveIt](https://github.com/dillonzq/LoveIt) | 3,870 | [demo](https://hugoloveit.com) |
| [luizdepra/hugo-coder](https://github.com/luizdepra/hugo-coder) | 3,100 | [demo](https://hugo-coder.netlify.app) |
| [google/docsy](https://github.com/google/docsy) | 2,954 | [docsy.dev](https://www.docsy.dev) |
| [nunocoracao/blowfish](https://github.com/nunocoracao/blowfish) | 2,854 | [blowfish.page](https://blowfish.page) |
| [panr/hugo-theme-terminal](https://github.com/panr/hugo-theme-terminal) | 2,789 | [demo](https://hugo-theme-terminal.vercel.app) |
| [thuliteio/doks](https://github.com/thuliteio/doks) | 2,354 | [getdoks.org](https://getdoks.org) |
| [imfing/hextra](https://github.com/imfing/hextra) | 2,295 | [demo](https://imfing.github.io/hextra/) |
| [gohugoio/hugoThemes](https://github.com/gohugoio/hugoThemes) | 1,802 | [themes.gohugo.io](https://themes.gohugo.io/) |
| [jpanther/congo](https://github.com/jpanther/congo) | 1,645 | [demo](https://jpanther.github.io/congo/) |
| [zeon-studio/hugoplate](https://github.com/zeon-studio/hugoplate) | 1,575 | [demo](https://zeon.studio/preview?project=hugoplate) |

## Checked and ruled out

An earlier pass left these 18 repos "unconfirmed" because an
unauthenticated API budget only allowed probing a few guessed paths.
They have since been settled properly: each repo's **complete file
tree** was read via the authenticated API, so these are conclusions, not
absences of evidence. None of the trees were truncated.

One was wrong and has been corrected: **linkerd/website is Hugo** and
now appears in the table above. Its config lives under
`config/_default/`, which the original probe missed.

The other 17 are genuinely not Hugo. What they actually use:

| Repo | Generator |
| --- | --- |
| `avelino/awesome-go` | Custom Go program (`main.go`) |
| `backstage/backstage` | Docusaurus + MkDocs |
| `caddyserver/website` | Custom (no standard generator) |
| `cert-manager/website` | Next.js |
| `cilium/cilium.io` | Gatsby |
| `cncf/landscape` | Custom React app |
| `hashicorp/consul` | Next.js |
| `helm/helm-www` | Docusaurus |
| `iluwatar/java-design-patterns` | Site built outside the repo |
| `knative/docs` | MkDocs |
| `kubevirt/kubevirt.github.io` | Jekyll |
| `kyverno/website` | Astro |
| `openebs/website` | Docusaurus |
| `openfaas/docs` | MkDocs |
| `prometheus/docs` | Next.js |
| `spinnaker/spinnaker.github.io` | Jekyll |
| `argoproj/argoproj.github.io` | Published output only |

Worth noting on `avelino/awesome-go`: it does contain a `config.yml`,
which is what made the first pass hesitate. That file is a GitHub
issue-template config. The site is generated by a Go program in the repo
root.

## E-commerce with Hugo

**There is no healthy open-source Hugo e-commerce ecosystem.** This is
the honest finding, and it is worth knowing before spending time
looking. Searches across several phrasings returned a top result of 11
stars, and almost everything is a personal experiment abandoned years
ago:

| Repo | Stars | Last push | Notes |
| --- | ---: | --- | --- |
| [LeeU1911/hugo-ecommerce-theme](https://github.com/LeeU1911/hugo-ecommerce-theme) | 11 | 2018 | Product display, no cart |
| [snipcart/ponzu-hugo-snipcart](https://github.com/snipcart/ponzu-hugo-snipcart) | 34 | 2019 | Snipcart's own tutorial demo |
| [dwalkr/snipcart-hugo-demo](https://github.com/dwalkr/snipcart-hugo-demo) | 6 | 2021 | Demo store |

Every one of these is unmaintained. Do not adopt them as a base.

The reason is structural rather than a gap someone forgot to fill: Hugo
outputs static files and cannot hold cart state, process payment, or
track inventory. In practice the store is a hosted service and Hugo only
renders the catalogue:

- **Snipcart** — add `data-item-*` attributes to a normal button; their
  JS builds the cart. The most common Hugo pairing, and what all the
  demos above use.
- **Shopify Buy Button** — Shopify holds products and checkout; you
  embed a snippet.
- **Stripe Payment Links / Checkout** — best when the catalogue is
  small and fixed. No cart, one link per product.
- **Lemon Squeezy / Ecwid / Foxy.io** — same shape, different vendors.

For a farm stand selling a handful of items, Stripe Payment Links needs
the least machinery: keep products in `data/`, render them with a
partial, and point each button at its link. Snipcart is the step up when
a real multi-item cart is needed.

## Tailwind CSS with Hugo

Unlike e-commerce, this is well supported and actively maintained.

Relevant to us: **Hugo 0.164 has a built-in `css.TailwindCSS`
function**, which handles Tailwind v4 without PostCSS in the pipeline.
Anything below still routes Tailwind through PostCSS, so check which
approach a starter uses before copying its build.

All of the following were confirmed as Hugo, with the Tailwind version
read from their `package.json`:

| Repo | Stars | Tailwind | Last push |
| --- | ---: | --- | --- |
| [nunocoracao/blowfish](https://github.com/nunocoracao/blowfish) | 2,854 | 4.3 | 2026-07-29 |
| [imfing/hextra](https://github.com/imfing/hextra) | 2,295 | 4.3 | 2026-07-22 |
| [jpanther/congo](https://github.com/jpanther/congo) | 1,645 | 3.4 | 2026-07-25 |
| [zeon-studio/hugoplate](https://github.com/zeon-studio/hugoplate) | 1,575 | 4.3 | 2026-07-25 |
| [4044ever/Hugo-Tailwind-4.x](https://github.com/4044ever/Hugo-Tailwind-4.x) | 85 | 4.1 | 2025-07-19 |
| [odhyp/hugo-tailwindcss-starter](https://github.com/odhyp/hugo-tailwindcss-starter) | 19 | 4.3 | 2026-07-06 |

`hugoplate` is already cloned in `example-projects/`, so start there.

One correction to a popular recommendation:
[dirkolbrich/hugo-tailwindcss-starter-theme](https://github.com/dirkolbrich/hugo-tailwindcss-starter-theme)
is the most-starred result at 405 stars and still tops search rankings,
but it was last pushed in **March 2024** and pins Tailwind 3. It is
stale — prefer the maintained options above.

### On Tailwind UI

**Tailwind UI (now Tailwind Plus) is a commercial product**, not an
open-source library. Its components are licensed per developer and
cannot be redistributed, so there is no legitimate Hugo theme shipping
them. Any repo that appears to contain Tailwind UI components is
violating that licence — do not copy from it.

If a component library is wanted alongside Tailwind, these are free and
genuinely open source:

| Library | Licence | Notes |
| --- | --- | --- |
| [Flowbite](https://github.com/themesberg/flowbite) | MIT | 9,313 stars, closest in feel to Tailwind UI |
| [daisyUI](https://github.com/saadeghi/daisyui) | MIT | Semantic class names, less markup churn |
| [HyperUI](https://github.com/markmead/hyperui) | MIT | Copy-paste, no dependency |
| [Preline](https://github.com/htmlstreamofficial/preline) | MIT | Large marketing-page set |

Buying a Tailwind Plus licence is of course fine — the restriction is on
lifting the components from someone else's repository.
