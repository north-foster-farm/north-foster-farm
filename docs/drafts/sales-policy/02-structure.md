# 2. Proposed structure (#415)

These are my recommendations, built as decided per `docs/cloud-lanes.md`.
James overrules any of them.

## Names and URLs

- **Parent: "Sales policy"** at `/sales-policy/`. It reads as plain
  as "Privacy policy". The page says "sales and refund" in its first
  line and its description, so a search for refunds finds it. "Terms of
  sale" sounds like a contract, which is a lawyer's call (Q14).
- **Child: the delivery policy stays a separate page at
  `/delivery-policy/`**, retitled **"Delivery and pickup"** in the
  page heading and the footer. The URL does not change, so there is
  **no redirect to add** and nothing breaks. The existing
  `/local-delivery-policy` redirect keeps working.

Why a page, not a section: delivery and pickup need a long page (area
table, map, drop site, markets). A section inside the sales policy would
bury the money rules the checkout agrees to. Two pages, each short
enough to read.

## What moves

| Topic | Where it lives now | Where it goes |
| --- | --- | --- |
| Prices, weight ranges, discounts | delivery policy | **sales** (fee table stays in delivery) |
| How you pay | delivery policy | **sales** |
| Sold out, mistakes | nowhere | **sales** |
| Changing and canceling | delivery policy | **sales** |
| Refunds | delivery policy | **sales** |
| Problems after handover | one line | **sales** |
| Food safety and handling | nowhere | **sales** |
| Consent | delivery policy | **sales** (covers every order) |
| Contact | delivery policy | both |
| Days, cutoff, window, holidays | delivery policy | delivery (stays) |
| Delivery fee, minimum, area | delivery policy | delivery (stays) |
| Missed delivery and the kept fee | delivery policy | delivery (stays), the refund consequence links to sales |
| Delivery area, map | delivery policy | delivery (stays) |
| On-farm and scheduled pickup | delivery policy | delivery page (stays, see below) |

## Pickup

Pickup is the other way to get the order, so it belongs with delivery
as a **"how you get your order"** child, not as a third page. The page
keeps its `#on-farm-pickup` and `#scheduled-pickup` anchors, which
`about.md` links. Only the money rules for pickup (cancel, refund, the
cutoff) live in the sales policy, once, so they cannot drift apart.

## Links that change (section 4, after approval)

- `#how-you-pay`, `#changing-or-canceling-an-order`, `#refunds` and
  `#your-consent` leave the delivery page. I found no link to any of
  them in `content/`, `layouts/` or `data/`. `#delivery-area` and
  `#scheduled-pickup` stay.
- Order page agreement: "By placing an order you agree to our sales
  policy and, for delivery or pickup, our delivery and pickup policy."
  (`layouts/partials/order/wrap.html:26`)
- Footer (`config/_default/menus.toml`): add **Sales**, rename
  Delivery to **Delivery and pickup**.
- `layouts/index.llms.txt:21`: add `/sales-policy`. It is generated
  from that list, not hand-written.
- `outputs: ["html", "markdown"]` on the new page so the policy has an
  `index.md` like the others, and a `netlify.toml` header block copying
  the delivery policy's (`netlify.toml:357`). That file is off limits to
  a cloud lane, so the coordinator adds it.
- Confirmation email, cancel email, account page cancel panel and the
  packing slip: link to the sales policy (Q13).
- `privacy.md:125` names the sales policy.
- `accessibility.md` link to the delivery area stays valid.
- The fee table shortcode (`bulk-tiers`) has a delivery-fee column. The
  sales page does not need it, so the draft describes discounts in
  words and leaves the table in the delivery page.

## Launch

The checkout asks people to agree to a policy. This one is more
complete than what exists now, and #405 should list it. Q1 asks James
whether it blocks launch.
