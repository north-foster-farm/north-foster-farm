# Media provenance

Every photo, video, logo, mark, icon, illustration and font the site
uses, with who made it and where its source lives (#220). Add a line
when a file lands. A renamed or exported file is not a source. Where
no record says who made a file, it says Unknown; ask before reusing
it.

Credit is how the file must be credited wherever it is used, blank
when none is needed (#239). Every commit is authored as James because
agents commit under his name, so a commit's author proves nothing;
the sources below are commit messages, issues and file metadata. The
evidence for each row is in the two audit comments on #220.

## Photos

The farm's phones are James's or Jim's (W33d on #192). Hugo re-encodes
every photo it serves, which drops EXIF, so no served image carries
location data; the originals marked GPS still hold it in the
repository.

| File | Made by | Credit | Source and notes |
| --- | --- | --- | --- |
| `assets/images/chicken-suit.jpg` | Jim | | Photo of the farm's table at the Foster Farmers Market, fall 2025, someone in a chicken suit behind it. No person in it can be identified, so no permission is needed. James supplied the file for #224. |
| `assets/images/grill.jpg` | James | | A whole chicken and its parts cooking on a round charcoal grill, which James cooked and photographed on 2026-10-26 (13:35 by the file's own timestamp) with the farm's iPhone 14 Pro, exported in Pixelmator Pro. It is the first of two shots a minute apart. James chose and supplied the file (#303): the second shot first (comment 6423373984), then this one instead. Resized to 2400px wide, uncropped, EXIF and GPS stripped. Beside How to buy on the home page. It replaced `cooked.jpg`, so the home page carries no photo credit. |
| `assets/images/chicks.jpg` | James or Jim | | Farm iPhone, exported in Pixelmator Pro. June post. Original has GPS. |
| `assets/images/ivy-sniffs-chick.jpg` | James or Jim | | Farm iPhone, Pixelmator Pro. June post. Original has GPS. |
| `assets/images/photogenic-hen.jpg` | James or Jim | | Farm iPhone, Pixelmator Pro. June post. Original has GPS. |
| `assets/images/tilted-market.jpg` | James or Jim | | Farm iPhone, Pixelmator Pro. August post, home markets band. Original has GPS. |
| `assets/images/winter-tunnel.jpg` | James or Jim | | iPhone 14 Pro, Pixelmator Pro. Home ways band (#137), Instagram slide 5. Original has GPS. |
| `assets/images/egg-basket.jpg` | James or Jim | | Farm iPhone, Pixelmator Pro, 2024. Unused on the site; kept for the Instagram questions on #192. Original has GPS. |
| `assets/images/chickens.jpg` | James or Jim | | iPhone 13 Pro Max, 2024. The ordering-tour post's closing figure (#430); until then unused, kept for the Instagram questions on #192. |
| `assets/images/brooder.jpg` | James | | Three-day-old chicks in the brooder, 2000 × 1125, handed to the coordinator directly (2026-10-26). EXIF and location stripped. Spring figure of the "Three Quarters of the Way" post (#431). |
| `assets/images/sheep-with-broilers.jpg` | James | | A sheep by a pen of broilers, from IMG_7109: the clean original of the Instagram post's cover (not the mockup with text on it), scaled from 4032 to 2400 wide. EXIF and location stripped. Summer figure of the "Three Quarters of the Way" post (#431). |
| `assets/images/tilted-tent-square.jpg` | James | | The farm's tent at the Tilted Barn (#233 item 31): the Instagram folder's `photos/tilted-tent-square.jpg` (see below), resized to 2400px with sips for #430. No EXIF or location in either. Ordering-tour post. |
| `assets/images/linus-featured.jpg` | James | | Byte for byte `~/Code/nff/linus-featured.jpg`, which James supplied. The ordering-tour post's thumbnail until #430; unused on the site since. |
| `assets/images/linus.jpg` | Unknown | | A tighter crop of the `linus-featured.jpg` scene (c1893a8, walkthrough finding 24); who cropped it is not recorded. About, egg mask. |
| `assets/images/sunset.jpg` | James | | `~/Code/nff/sunset.jpg`, scaled from 4030 to 2400 wide. Unused since James removed it from the ordering-tour post and the launch email (2026-10-17). |
| `assets/images/delivery-flyer.jpg` | James | | His original design (D-MA1, 2026-10-17). In production's tree, not on `next`. |
| `assets/images/lily.jpg` | Unknown | | Metadata stripped; PR #67, the August post's hero and news thumbnail. |
| `assets/images/scituate-market.jpg` | Unknown | | Metadata stripped; PR #67, August post. James on #192: not the farm's stand. |
| `assets/images/mc-1.jpg` | Unknown | | Metadata stripped; the mobile coop, About (c1893a8, walkthrough finding 22). |
| `assets/images/online-ordering.png` | Unknown | | A screenshot of deploy-preview-106 set in a MacBook frame (f76da25); who composited it is not recorded. Launch email; the ordering-tour post's lead figure until #430. A stopgap until James's photo of the site on the laptop. |

Photos in `~/Code/nff/`, not in the repository; EXIF and location
stripped, but their `*.jpg_original` backups still hold GPS and are
never committed or uploaded (#230):

| File | Made by | Credit | Source and notes |
| --- | --- | --- | --- |
| `broilers.jpg`, `broilers-square.jpg` | James | | Broilers on pasture, from IMG_7035. The square one is Instagram slide 2 (#230). Its resized copy in `assets/images` served the ordering-tour post until #431 replaced it. |
| `sheep-with-broilers.jpg`, `sheep-with-broilers-square.jpg` | James | | Sheep by a pen of broilers, from IMG_7109. The square one is the Instagram post's cover and its Story. |
| `cooked.jpg` | Jess Brayton (@fussica) | @fussica, her choice | Instagram slide 3. Its resized copy, `assets/images/cooked.jpg`, left the site when `grill.jpg` replaced it on the home page. |
| `tilted-tent.jpg`, `tilted-tent-square.jpg` | James | | The farm's tent at the Tilted Barn; James took it (#233 item 31). No metadata in either. The square one is Instagram slide 4, untagged, and, resized, `assets/images/tilted-tent-square.jpg` (#430). |

## Video and posters

| File | Made by | Credit | Source and notes |
| --- | --- | --- | --- |
| `static/videos/opening-the-coop-loop.mp4`, `.webm` | Unknown (footage); an agent (cut) | | The first 14 s of `opening-the-coop.mp4`, a HandBrake HEVC clip left untracked in the main checkout, cut with ffmpeg for #133 (37b6f09). Who shot it is not recorded. Home hero. |
| `assets/images/opening-the-coop.jpg` | Unknown | | Poster exported from Pixelmator Pro 3.8, graded warmer than the clip (#133). Home hero. |
| `static/videos/tight-quarters.mp4`, `.webm` | Unknown (footage); an agent (encode) | | No source clip in the workspace. Re-encoded at 8 bits from the earlier 10-bit MP4 in ca39990, which records the commands. About. |
| `assets/images/tight-quarters.jpg` | Unknown | | Poster exported from Pixelmator Pro 3.8 (6594fea). About. |

## The farm's logo and marks

The logo's original vector files are in `bin/logos/originals/`:
original vector files supplied by James; wordmark by an unnamed
designer (#220, L1). `bin/logos/build.mjs` writes every logo file
below from them, paths as drawn; run it after changing an original.

| File | Made by | Credit | Source and notes |
| --- | --- | --- | --- |
| `bin/logos/originals/*.svg` | Original vector files supplied by James; wordmark by an unnamed designer | | `wordmark.svg` (the wordmark) and `halo-chicken.svg` (the hen and arc), both exported from Pixelmator Pro 3.8; `halo-chicken-wordmark.svg` (the two on one line) and `halo-chicken-tight.svg` (the hen and arc, cropped). |
| `assets/images/logo.svg` | Built from the originals | | `wordmark.svg`. Header wordmark. |
| `assets/images/logo-mark.svg` | Built from the originals | | The hen and arc of `halo-chicken.svg`. Header hen, README, news placeholder tiles. |
| `assets/images/search/hen.svg` | Built from the originals | | The hen of `halo-chicken.svg`, recolored (#142). Search placeholder, the map's dropped pin. |
| `assets/images/logo-horizontal.svg`, `static/logo-horizontal.svg` | Built from the originals | | `halo-chicken-wordmark.svg`, unchanged. Public; unused on the pages (L3). |
| `static/images/email/logo.png` | Built from the originals | | Inkscape render of `logo.svg` in the header green. Every email's header. |
| `assets/images/logo-mark.png` | Built from the originals | | Inkscape render of the hen and arc of `halo-chicken.svg` in its own green, 512 wide. JSON-LD `logo` (`params.logo`). |
| `static/images/silhouette-4.svg`, `silhouette-4_2.svg`, `silhouette-4_2-sm.svg` | James | | His final files for the footer (#226 comment of 2026-10-20 10:17, launch-guide 026d16c, `feedback/ft-silhouette/`), exported from Pixelmator Pro: the high tunnel and the two coops at full width (xl and up), a middle crop (md to xl) and a crop for phones. Through svgo 4.1.0 at its default preset, plus `preserveAspectRatio="none"` in place of the width and height. Footer's top edge (#277). |
| `assets/images/share-card.png` | James | | Made 2026-09-24 (1352220). `og:image` on every page. |
| `static/email-signature/logo-horizontal.png` | James | | "New image files for general use outside of this project" (57e89d5). Public URL, likely his email signature. |
| `bin/favicons/emblem.mjs` and `static/favicons/*` | An agent, from James's choice | | The gingham egg James chose (#145). `bin/favicons/build` writes every favicon file from the script; a rebuild reproduces them pixel for pixel. |

## Drawn in code

| File | Made by | Credit | Source and notes |
| --- | --- | --- | --- |
| `assets/images/avatars.svg` | An agent | | The six chicken avatars a customer picks in account settings (`data/avatars.json`), SVG symbols drawn from shapes in `layouts/partials/avatars.html` (8a5bf6f). No file or icon set behind them. Moved from the template into the file for #295; the shapes are unchanged. |
| `icons/egg-spinner.svg` | An agent | | The busy button's spinner, an egg outline drawn in `layouts/partials/busy-button.html` (995dabd). Moved into the file for #295. |
| `icons/play.svg`, `pause.svg` | An agent | | The video toggles, drawn in the video shortcode (dd03b4c). Moved into files for #295. |
| `icons/check.svg` | An agent | | The order page's success mark, drawn in `layouts/partials/order/form.html` (adf0e36). Moved into the file for #295. |

## Icons

Licenses and notices for Lucide, Feather and Tabler are in `NOTICE`.
Icons marked "James supplied" came from files he put in `~/Code/nff/`
or named in an issue; the others an agent took from the set named.
Every SVG is stored as the clean-up writes it (`docs/svg.md`), which
changes how its paths are spelled but not its shapes.

| File | Made by | Credit | Source and notes |
| --- | --- | --- | --- |
| `icons/account.svg`, `orders.svg`, `receipt.svg`, `sign-out.svg` | Lucide; James supplied | NOTICE | His round-three notes. |
| `icons/sign.svg` | Lucide; James supplied | NOTICE | a0179ec. |
| `icons/changes.svg`, `lot-location.svg` | Lucide; James supplied | NOTICE | #137, #159. |
| `icons/panel-open.svg`, `panel-close.svg` | Lucide; James supplied | NOTICE | Byte-identical to `~/Code/nff/panel-*.svg`. |
| `icons/copy.svg` | Lucide | NOTICE | Lucide's `copy`, from `lucide-static@0.460.0` (unpkg), shapes unchanged, attributes as the set's others. James approved it on #294 (2026-10-21) for the staging sandbox card's copy buttons. |
| `icons/chevrons-right.svg` | Lucide; James supplied | NOTICE | `~/Code/nff/chevrons-right.svg`, class stripped (2e8a846, #228). Order page's section marker. |
| `icons/wallet.svg` | Lucide; James supplied | NOTICE | `~/Code/nff/wallet.svg`, class stripped (1610f12, #212). Home ways band, cost line. |
| `icons/cart.svg`, `tractor.svg` | Lucide; supplier not recorded | NOTICE | From lucide.dev's page, going by its `preview-icon` class (3225811). `cart.svg` matches no icon in lucide-react 1.28.0: another release, or edited. |
| `icons/arrow-down.svg` | Lucide; supplier not recorded | NOTICE | 7ba68f6. |
| `icons/chevron-down.svg`, `chevron-right.svg` | Lucide; supplier not recorded | NOTICE | 0d2667b; an agent later set `chevron-down` to stroke width 3. |
| `icons/credit-card.svg` | Lucide; supplier not recorded | NOTICE | c456cb9. Matches no icon in lucide-react 1.28.0. |
| `icons/calendar.svg`, `map-pin.svg` | Lucide; an agent | NOTICE | Stand-ins for #212 (7cce958); James kept them (G1 on #233). |
| `icons/barn.svg`, `delivery.svg` | Tabler; James supplied | NOTICE | #137. |
| `icons/search.svg`, `search-close.svg` | Tabler; James supplied | NOTICE | #142. |
| `icons/leaves/*.svg` (ten) | Tabler; James supplied | NOTICE | #143, "I added 10". The five "b" leaves are mirrors of the "a" ones. News tiles. |
| `icons/x.svg` | Tabler; an agent | NOTICE | 86c1ad5, #208. Search's close button. |
| `icons/eggs.svg` | James | | From his own original banner design for the farm's market stall (James, 2026-10-18, #267), so no credit is owed. It came into the repo in his commit 57e89d5 ("new image files for general use"); one filled path. Checked 2026-10-17 (D-MA1): not Lucide, not Tabler. Swapped for Tabler's outline `eggs` in 757574b while its source was unknown, and restored 2026-10-18. The map's egg tag and key, and the search palette's card for eggs. |
| `icons/globe.svg` | Lucide; an agent | NOTICE | Replaced 2026-10-17 (D-MA1) with Lucide's `globe`, lucide-static 1.59.0, ISC. The file before it was not Lucide: a filled outline on a 129.741 x 129.841 canvas, with the marks of an SF Symbols export (James's commit be0c1fe); Apple's terms bar those off Apple platforms. The map's whole-map button. |
| `static/email-signature/globe.png` | James (export); glyph Unknown | | Exported from Pixelmator Pro 2025-02-08 (be0c1fe); the glyph is the old `globe.svg`'s, so probably SF Symbols. Public URL, likely his email signature; not changed, and James has not been asked about it. |

## Other organizations' marks

| File | Made by | Credit | Source and notes |
| --- | --- | --- | --- |
| `assets/images/apppa-logo.svg` | APPPA; James supplied | | The 2025 full lockup, `apppa-logo-2025_full-lockup.svg`, supplied by James 2026-10-21 (#296), already in his svgomg settings; only an unused `fill-rule` was removed, and the badge got `fill="#fff"` as a fallback outside the site. The logo's colors are inline fills; James added the white badge behind it (class `background`), which takes the theme's white. It replaced the mark from 900f21b (2025), whose supplier was not recorded. Unused since the footer dropped it (#303). |
| `icons/facebook.svg`, `instagram.svg` | Meta; supplier not recorded | | First commit, 2024. |
| `icons/venmo-monogram.svg` | Venmo; James supplied | | 57e89d5. |
| `icons/apple.svg`, `google-maps.svg` | Apple, Google; an agent | | Directions links (b8df96c, #177). |
| `static/email-signature/instagram.png` | Instagram's glyph; James exported it | | Pixelmator Pro, 2025-02-08 (be0c1fe). Public URL. |

## Fonts

| File | Made by | Credit | Source and notes |
| --- | --- | --- | --- |
| `static/fonts/aller-*.woff`, `.woff2` (twelve) | Dalton Maag | `static/fonts/aller-license.txt` | Aller, converted with Font Squirrel's Webfont Generator on 2024-05-25. Licensed to the farm under Dalton Maag's Free Licence Agreement on top of its EULA v1.2, from Font Squirrel's official package; James accepted it on 2026-10-22 (MA2, #220). The text sits beside the fonts. It allows self-hosting on the site (up to 25,000 visitors a day) and fonts in business mail such as receipts and sign-in links, but not in a newsletter, so the email templates no longer load Aller. |
