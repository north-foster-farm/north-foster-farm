// Whether the Membership tab shows, and what its pane holds (#577).
// /api/me alone decides the tab, as it does the account menu's
// Membership: someone in no group loses the tab and its pane, and
// anyone in one keeps them. /api/membership only fills the pane, and
// when it fails the pane says so, with Try again, inside the tab.

import { whileLoading } from "../../utils/skeleton.js";

// { inGroup, region, request, render, reveal, remove } -> the pane's
// view once rendered, or null (not in a group, or the request failed).
//
// - inGroup: /api/me's membership, true for a member or a host;
// - region: the pane's loading region (partials/skeleton/status.html);
// - request(): -> /api/membership's { ok, data }; may reject;
// - render(view): fills the pane from the endpoint's data;
// - reveal(): shows the tab, before the request is answered;
// - remove(): takes the tab and its pane off the page.
export const showMembership = ({
  inGroup, region, request, render, reveal, remove, giveUpMs,
}) => {
  if (!inGroup) {
    remove();

    return Promise.resolve(null);
  }
  reveal();

  const load = () => whileLoading(region, request, {
    render: (res) => render(res.data),
    retry: load,
    ...(giveUpMs ? { giveUpMs } : {}),
  }).then((res) => (res ? res.data : null));

  return load();
};
