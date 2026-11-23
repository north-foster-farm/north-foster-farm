// The library's elements, all inside the toolbar
// (layouts/partials/staging-toolbar.html), found by data-staging-*
// (docs/refactors/staging-library.md, phase 1).

const reviewOf = (qs) => ({
  bar: qs("[data-staging-review]"),
  status: qs("[data-staging-review-status]"),
  approve: qs("[data-staging-approve]"),
  rewrite: qs("[data-staging-rewrite]"),
  withdraw: qs("[data-staging-withdraw]"),
  revert: qs("[data-staging-revert]"),
  error: qs("[data-staging-review-error]"),
});

const editorOf = (qs) => ({
  form: qs("[data-staging-editor]"),
  subject: qs("[data-staging-edit-subject]"),
  text: qs("[data-staging-edit-text]"),
  dropped: qs("[data-staging-edit-dropped]"),
  error: qs("[data-staging-edit-error]"),
});

export const elementsOf = (root) => {
  const qs = (sel) => root.querySelector(sel);

  return {
    box: qs("[data-staging-library]"),
    shelf: qs("[data-staging-shelf]"),
    empty: qs("[data-staging-shelf-empty]"),
    search: qs("[data-staging-search]"),
    summary: qs("[data-staging-library-summary]"),
    count: qs("[data-staging-library-count]"),
    reader: qs("[data-staging-reader]"),
    frame: qs("[data-staging-frame]"),
    textView: qs("[data-staging-text]"),
    rewritten: qs("[data-staging-rewritten]"),
    item: qs("[data-staging-item]"),
    tokenTemplate: qs("[data-staging-token]"),
    filters: root.querySelectorAll("[data-staging-filter]"),
    views: root.querySelectorAll("[data-staging-view]"),
    review: reviewOf(qs),
    editor: editorOf(qs),
  };
};
