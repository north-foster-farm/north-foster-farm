# Big, popular Hugo sites on GitHub

Compiled 2026-07-30. Every repo in the first table was **verified** as
Hugo by probing its default branch for a real Hugo config
(`hugo.toml` / `hugo.yaml` / `config/_default/*`) or
`archetypes/default.md` — not by GitHub topic tags, which are
unreliable in both directions.

Star counts and repo sizes come from the GitHub API on that date.

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

## Checked but not confirmed

These surfaced in searches and did **not** show a Hugo config where the
probe looked. Listed so nobody re-checks them:

`avelino/awesome-go`, `iluwatar/java-design-patterns`, `knative/docs`,
`cilium/cilium.io`, `linkerd/website`, `prometheus/docs`,
`helm/helm-www`, `cert-manager/website`, `kyverno/website`,
`caddyserver/website`, `openfaas/docs`, `spinnaker/spinnaker.github.io`,
`openebs/website`, `kubevirt/kubevirt.github.io`,
`argoproj/argoproj.github.io`, `hashicorp/consul`, `cncf/landscape`,
`backstage/backstage`.

Treat this as "unconfirmed", not "definitely not Hugo" — several almost
certainly do use Hugo but keep their config somewhere the probe did not
reach.
