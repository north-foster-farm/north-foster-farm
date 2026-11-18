# Host guide: ordering from the farm as a group

Draft for James (#471). Every line is his to approve or reword before
it reaches the host. The group's name, its code and its dates are
settings; the rules are the farm's policy as of 2026-10-26.

## How members order

1. Open the farm's order page and add what you want.
2. Open **Add discount** in the cart and enter the group's code. Someone
   not yet in the group is asked "Join {group name}?" first, and told
   the host can see their name and email address. After **Join
   group**, the note says "Code applied. Welcome to the group!" (for
   someone already in it, "You're already in the group.") and the
   pickup days now include the gym. **Cancel** leaves the code off.
3. Choose the gym under **Pickup days**, enter your details, and pay.
   Cards, Apple Pay, Google Pay, Cash App Pay and Venmo all work.

The link the host hands out does the same as the code: it opens the
order page with the code in the box, and asks the same question. The
group's QR code joins
the group without an order (see the Membership tab, below).

Once you have ordered with the code, your email address is on the
group's list. Sign in with it on your next visit and the gym and your
prices are there without the code.

## Rounds

- Pickup is at the gym every other Sunday, 8:30 to 9:00 AM. The first
  is Sunday, November 22, 2026.
- Orders for a round close at 11:59 PM the Saturday before. The next
  round opens the moment one closes.
- Each member pays when they order, and the farm packs the round as
  one: one list, packed by member, one trip.
- Prices: the group's prices are today's prices, locked through
  December 31, 2027. If the farm's prices rise before then, the group
  stays on today's.
- There is no delivery fee on a pickup round. A member who wants an
  order left in the gym's cooler on a Thursday can choose that on the
  order page: it is a regular delivery, with the usual minimum and
  fee.
- Someone who buys at the gym without ordering ahead can be counted in
  the round if the farm has their email address.

## The host reward

- When a round closes, the host earns 10% of the round's total as
  credit, worked out on money actually paid, not on credit spent, and
  only when that money reaches $300.
- Each amount is rounded down to the dollar.
- The host chooses what to do with it by the close of the next round:
  - **Keep it**: it becomes credit on the host's own account, to spend
    on any order.
  - **Share it**: it is split among the members of the next round in
    proportion to what each spent, and lands on their accounts as
    credit when that round closes. Someone no longer in the group by
    then gets no share.
  - With no choice by then, it is kept.
- Credit comes off an order by itself when the member is signed in,
  after the order's discounts. It covers products, not the delivery
  fee: a delivery always has its fee to pay. If it covers everything
  else, there is nothing more to pay.
- Credit expires at the end of the year it was granted. Credit granted
  in December runs to the end of the following year.
- A refund of an order paid with credit returns the credit first, then
  the money.
- A reward is worked out once, when the round closes. A later refund
  does not change it.

## The Membership tab

Members see a Membership tab on their account page, and in the
account menu at the top of every page. It shows the group's name and
pickup address, then the pickups: the open round's pickup day and
window with when ordering closes and a button to the order page, and
the next round's with when it opens. From a round's close until its
pickup is over, that pickup stays at the top, marked Closed
(2026-11-18, #602 and #600: this replaced the rows of labels and the
"every 2 weeks" line, and before it the pickup left the tab at the
close). A member also sees their membership QR code, marked "Coming
soon" until scanning it does something at a market, and can leave the
group there.

As the host, you also see:

- **Invite members**: the group's QR code, with a button to download it for a sign.
  Anyone who scans it can join: it opens a page where they enter their
  name and email address, and the link we email them adds them to the
  group. The typed code works as before.
- **The join link**, the address the QR code holds, with a Copy
  button, to send instead of the code (2026-11-14, #579). It is the
  short link, northfosterfarm.com/vff, easy to post or say out loud.
  It always opens the group's sign-up page, so it and the QR code
  never need replacing (2026-11-16, #587, #589).
- **The members**: each one's name, email address, the date they
  joined and how. You can remove someone. Their open orders stay as
  placed, and they can't move an order to a gym pickup after that.

There is no button to replace the QR code or the link (2026-11-16,
#589: Generate new QR code and link is gone). With the short link,
a new one would stop no one. If a long sign-up link (one with
`/join/?t=` in it) has spread further than it should, the farm
replaces it from the CLI with `bin/nff groups qr <key> --rotate`: the
old long link stops at once, and the short link and every printed QR
code lead to the new one.

## Questions

Members write to sales@northfosterfarm.com. The host can answer what
this guide covers; anything about money, an order or an account goes
to the farm.
