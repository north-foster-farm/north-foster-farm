// A news post sent as a Farm News email (#483): the Markdown Hugo
// writes for it, set in the list template.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RESEND_UNSUBSCRIBE, postBlocks, postFile, postMail,
} from "../netlify/functions/lib/post-mail.mjs";
import { listBlocks } from "../netlify/functions/lib/templates.mjs";

const links = { site: "https://x" };
const PHOTO = "https://www.northfosterfarm.com/mail/year/hens.jpg";

const POST = [
  "# Three Quarters",
  "October 18, 2026",
  "## Spring",
  "A **bold** start, *softly*, with [our map](/#map).",
  `![Hens on grass](${PHOTO})`,
  "*The hens, up early.*",
  "Second line of\nthe same paragraph.",
  "— James and Jim",
  "[See what's in stock](/order/).",
  "* * *",
  "We'd love to\n[hear how it goes](mailto:sales@example.com).",
].join("\n\n");

describe("a post as Farm News mail", () => {
  const mail = postMail(POST, { links });

  it("takes the post's title as the subject, once, and no date", () => {
    assert.equal(mail.subject, "Three Quarters");
    assert.match(mail.html, /<h1[^>]*>Three Quarters<\/h1>/);
    assert.doesNotMatch(mail.html, /October 18/);
    assert.doesNotMatch(mail.text, /October 18/);
  });

  it("makes a section of a heading", () => {
    assert.match(mail.html, /<h2[^>]*>Spring<\/h2>/);
    assert.match(mail.text, /^SPRING$/m);
  });

  it("keeps bold, italics and links, with the site's address on the links",
    () => {
      assert.match(mail.html, /<strong>bold<\/strong>/);
      assert.match(mail.html, /<em>softly<\/em>/);
      assert.match(mail.html, /href="https:\/\/x\/#map"[^>]*>our map<\/a>/);
      assert.match(mail.html, /href="mailto:sales@example\.com"/);
      assert.match(mail.text, /our map \(https:\/\/x\/#map\)/);
    });

  it("joins a wrapped paragraph's lines", () => {
    assert.match(mail.text, /Second line of the same paragraph\./);
  });

  it("sets a photo and its caption at the site's fixed address", () => {
    assert.match(mail.html, /src="https:\/\/x\/mail\/year\/hens\.jpg"/);
    assert.match(mail.html, /alt="Hens on grass"/);
    assert.match(mail.html, />The hens, up early\.</);
    assert.match(mail.text, /\[Photo: Hens on grass\]\nThe hens, up early\./);
  });

  it("sets the signature, the quiet shop link and the dinkus", () => {
    assert.match(mail.html, /<p style="margin:32px 0 16px">— James and Jim/);
    assert.match(mail.text, /^— James and Jim$/m);
    assert.match(mail.html,
      /<p[^>]*><a href="https:\/\/x\/order\/"[^>]*>See what's in stock<\/a>\./);
    assert.match(mail.text, /See what's in stock \(https:\/\/x\/order\/\)\./);
    assert.match(mail.html, /role="separator"[^>]*>\*&#8201;\*&#8201;\*/);
    assert.match(mail.text, /^\* \* \*$/m);
  });

  it("carries the list's footer, with Resend's unsubscribe link", () => {
    assert.match(mail.html, /99 East Killingly Road/);
    assert.match(mail.text, /Unsubscribe in one click: \{\{\{RESEND_UNSUB/);
    assert.match(mail.html, new RegExp(
      `href="${RESEND_UNSUBSCRIBE.replace(/[{}]/g, "\\$&")}"`));
    assert.match(mail.text, /because you joined our Farm News list/);
  });

  it("leaves out the website's footer", () => {
    assert.doesNotMatch(mail.text, /Sign up for news like this/);
    assert.doesNotMatch(mail.text, /More from the farm/);
  });

  it("takes the preview text and an unsubscribe link when given", () => {
    const m = postMail(POST, {
      links, preview: "Peek", unsubscribeUrl: "https://x/u",
    });

    assert.match(m.html, /display:none[^>]*>Peek/);
    assert.match(m.text, /https:\/\/x\/u/);
  });
});

describe("what a post may hold", () => {
  const blocks = (md) => postBlocks(`# T\n\n${md}`, "https://x").blocks;

  it("refuses a photo that is not at a fixed address", () => {
    assert.throws(() => blocks(
      "![A](https://www.northfosterfarm.com/images/hens_hu_abc.webp)"),
    /not at a fixed address/);
  });

  it("refuses what the email has no block for", () => {
    for (const md of ["- one\n- two", "1. one", "> quoted", "### Lower",
      "| a | b |", "<div>x</div>", "Words ![A](https://x/mail/a.jpg)"]) {
      assert.throws(() => blocks(md), /no email form/, md);
    }
  });

  it("refuses a link to anything but a site, web or mail address", () => {
    assert.throws(() => blocks("[x](javascript:alert)"), /a link to/);
  });

  it("wants a title", () => {
    assert.throws(() => postBlocks("Words", "https://x"), /no title/);
  });

  it("takes only a post's name for its file", () => {
    assert.throws(() => postFile("../x"), /post mail/);
    assert.match(postFile("a-b").pathname, /public\/news\/a-b\/index\.md$/);
  });
});

describe("the post blocks", () => {
  const HOSTILE = "<script>alert(1)</script> \"x\" & ";

  it("escape what a post says", () => {
    const html = [
      listBlocks.title(HOSTILE),
      listBlocks.rich([{ text: HOSTILE, url: "https://x/?a=\"b\"" }]),
      listBlocks.signature(HOSTILE),
    ].map((b) => b.html).join("");

    assert.doesNotMatch(html, /<script/);
    assert.doesNotMatch(html, /href="[^"]*"b/);
  });

  it("refuse a link that runs a script", () => {
    assert.throws(() => listBlocks.rich([{ text: "x", url: "javascript:1" }]),
      /a link to/);
  });
});
