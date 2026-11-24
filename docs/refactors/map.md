# Splitting `map/map.js`

The fifth design under #782 (quality gates in the build), read from
`next` at `fd5daa98`. The rules common to every phase are in
[order-form.md](order-form.md#3-the-phases).

`assets/scripts/map/map.js` is 984 lines, 693 of them code, and
nearly all of it is one function. `wire(map)` runs from line 123 to
line 980: 639 lines of code in a single closure, with some forty
inner functions that share twenty variables. It has no class and no
unit test. What saves it is `e2e/map.spec.mjs`, 1,295 lines and
some thirty-five tests, which pins almost everything a visitor can
do. The work is to give the closure's parts names, files and
arguments, and to draw the arithmetic out where a unit test can
reach it.

## 1. The file today

### What it does

One call of `wire` serves one `[data-map]` on the page, in two
layers.

**Seasons and numbers.** `expire`, `number`, `today`. What has ended
leaves the list, the cards and the pins. The rest are numbered in
the list's order.
e2e: `map` ("the Places list is one list, matching the pins").

**The camera.** `zoom`, `clamp`, `home`, `atHome`, `apply`, `go`,
`zoomAbout`, `toMap`, `onScreen`, `centre`, the zoom buttons, the
wheel with ctrl, the double click, and the window's `resize`. The
view is the SVG's `viewBox`. `apply` writes it and keeps the pins
one size on screen.
Unit: `map-fit.test.mjs` (`fit.mjs`, which `frameTown` calls).
e2e: `map` ("zoom in and out; pins keep their size", "Places frames
its pins, and Delivery the whole state").

**Standing things over the map.** `stand`, `clearZoom`, `placeTag`,
and the pointer's tip. A tag keeps inside the frame and clear of the
zoom buttons.
e2e: `map` ("the tag keeps inside the frame").

**The list's height.** `fitList`, with a `ResizeObserver`.
e2e: `map` ("the places list scrolls when it outruns the map").

**Layers.** `layer`, `setLayer`, `stops`, and the tabs' keys.
e2e: `map`, `keyboard`, `top-bar-places`.

**Cards.** `show`, `close`, `pressed`, `outline`, `homeOf`,
`reveal`, `bringIn`, `frameTown`, `link`, the pins' keys, the rows'
clicks, Escape.
e2e: `map` ("a pin opens its card; Escape closes it to its row",
"the selected pin's town is outlined", "a row and its pin light
each other"), `top-bar-places`, `pickup-days`.

**The schedule.** `schedule`, `arrange`, `rows`, and the
`visibilitychange` listener. `/api/events` orders the list by the
next date the farm attends.
e2e: `map` ("the list follows the next date the farm attends",
"when /api/events can't load, the seasons stay and nothing links").

**Delivery.** `fill`, `hideTip`, the hover tip, `check`, `tap`, the
`nff:zip` listener that drops the pin, and the tag's link to
Places.
Unit: `zip-check.test.mjs` (the answer the event carries).
e2e: `map` (seven tests under "on a touch screen" and after),
`pricing`, `policies`.

**Drags and pinches.** `spread`, `middle`, the pointer handlers,
`up`.
e2e: `map` ("a tap on a pin opens its card; a tap off it closes
it").

**Links into the map.** `follow`, `toField`, `settled`.
e2e: `map-link`, `map` ("the news post's ZIP link leads to the
map's check"), `top-bar-places`.

### State

All of it is `let` and `const` inside `wire`, seen by every inner
function:

- **The camera:** `view`, `tween`.
- **Places:** `open` (the card showing), `pins` (reassigned when a
  season ends), `homes` (each pin's ZIP shape, found once).
- **Delivery:** `picked` (the ZIP under the dropped pin), `tip`.
- **Gestures:** `pointers`, `dragging`, `startView`, `startPoint`,
  `startSpread`, `touched`.
- **Elements:** about twenty, found once at the top.

The layer is kept in the DOM, as `map.dataset.layer`.

### DOM

`layouts/partials/map.html`, by its hooks: `[data-map]`,
`[data-map-frame]`, `[data-map-svg]`, `[data-map-layer]`,
`[data-map-for]`, `[data-map-zoom]`, `[data-map-pin]` (with
`data-x`, `data-y`, `data-nudge`, `data-until`, `data-map-slug`),
`[data-map-show]`, `[data-map-card]`, `[data-map-num]`,
`[data-map-town]`, `[data-map-pick]`, `[data-map-drop]`,
`[data-map-drop-at]`, `[data-map-drop-tag]`,
`[data-map-to-places]`, `[data-zip]` (the ZIP after a `z`),
`[data-zip-check]`, `.map-places`, `.map-key-list`, `.map-zip`,
`.map-zoom`, `.map-field`, and the tag's parts by class.

It writes the `viewBox`, each pin's `transform`, inline `left`,
`top`, `visibility`, `max-height` and `touch-action`, the marks
`data-open`, `data-hot` and `data-tone`, and the ARIA state named
in section 4.

### Events, timers, requests

Listens: on the SVG, `wheel` (not passive), `dblclick`,
`pointerdown` (twice), `pointermove` (twice), `pointerup`,
`pointercancel`, `pointerleave`; on the buttons, tabs, pins and
rows; on the map, `keydown`; on the document, `nff:zip` and
`visibilitychange`; on the window, `resize` (twice), `hashchange`
and `load`.

Sends: an `input` event on the map's ZIP field, or, on a map
without one, `nff:zip` with `{ zip, tone }`.

Timers: a 220 ms tween for the camera; up to 1,500 ms waiting for a
jump within the page to stop.

One request: `GET /api/events`, with no cache, whose failure
changes nothing.

### Imports and importers

It imports `clock/now.js` (`siteNow`) and `./fit.mjs`.

`zip-check/main.js` is the one importer and calls `wireMaps()`. A
page gets the map by setting `pageScript: "zip-check"`.

## 2. The target

`map.js` stays, with `wireMaps` and a `wire` that builds the parts.
Everything else moves into files beside it in
`assets/scripts/map/`.

### Modules

Sizes are code lines, estimated.

Pure:

```
view.mjs      clampView, zoomOf, zoomedAbout, homeView, atHome,
              tweenAt, easeOut, toMap, onScreen, centreOf,
              pannedBy, pinScale                                 120
stand.mjs     standAt, clearOf, tipAt, inFrame                    60
tag.mjs       zipOf, toneOf, tagFacts                             40
seasons.mjs   dayOf, gone, numbersOf, arranged, hashTarget        60
gesture.mjs   spread, middle, isDrag                              25
```

`fit.mjs` stays as it is.

Dumb:

```
parts.js      partsOf(map): every element, found once             30
draw.js       drawView, drawTag, drawPick, drawDrop,
              drawPressed, drawOutline, standOn                  150
seasons.js    expire, number                                      40
```

Smart:

```
camera.js     Camera: the view, go, zoomAbout, home, apply,
              the buttons, the wheel, the double click           130
gestures.js   Gestures: the pointers, a drag, a pinch, a tap     100
layers.js     Layers: setLayer, the tabs, the pins' Tab
              stops, the list's height                            90
cards.js      Cards: show, close, reveal, bringIn, frameTown,
              the hover, Escape                                  150
delivery.js   Delivery: the tip, check, the dropped pin, the
              link to Places                                     120
schedule.js   Schedule: /api/events, the order, what ends
              while the page is open                              60
links.js      follow, toField, settled                            60
map.js        wire, wireMaps                                      70
```

Fifteen new modules and about 1,300 lines for today's 693.

### How state moves

```
a pinch, a drag, a button
  -> gestures.js / camera.js
       view = clampView(...)                    view.mjs
       drawView(parts, view, pins)              draw.js

a tap
  -> gestures.js   onTap(target)
       Places:   cards.show(n) or cards.close()
       Delivery: delivery.check(zip, tone)
                   -> the ZIP field's input, or nff:zip

nff:zip, from any check on the page
  -> delivery.js   picked = zip; layers.set("delivery")
                   drawTag, drawPick, drawDrop; camera.apply()

a tab, a hash, a card
  -> layers.set(name)
       cards.close() on Delivery; delivery.hideTip()
       camera.go(camera.home())
```

- **Each smart part owns its own variables.** `Camera` has `view`
  and `tween`; `Cards` has `open` and `homes`; `Delivery` has
  `picked` and the tip; `Gestures` has the pointers. Nothing else
  writes them.
- **`pins` is one list, held by the root** and handed to the parts
  that read it. `Schedule` replaces it when a season ends, through
  the root.
- **The layer stays in the DOM.** `Layers` is its one writer, and
  tells the others through a callback the root gives it.
- **What crosses between parts crosses through the root:** `wire`
  builds them in order and hands each the two or three functions of
  the others it calls. No part imports another.
- **A map keeps its own set.** Two maps on a page are two calls of
  `wire`, as now.

### What stays as it is

`wireMaps`; `fit.mjs`; `zip-check/main.js`; `clock/now.js`; the
`nff:zip` event; every hook in the markup. No new package.

## 3. The phases

The rules are those of
[order-form.md](order-form.md#3-the-phases). For a change under
`assets/scripts/map/**`, `bin/nff e2e` selects the 26 specs of the
map's entry. `map` and `map-link` are read first after every phase,
then `top-bar-places` and `keyboard`.

### Phase 1: the camera's arithmetic

Moves the sums inside `clamp`, `zoom`, `home`, `atHome`, `go`'s
step, `zoomAbout`, `toMap`, `onScreen`, `centre` and `apply`'s pin
scale to `view.mjs`. `wire` calls them with its own variables.

Criteria (`view.mjs`):

1. `clampView` keeps the width between the whole map's and a fifth
   of it, the height in the map's proportion, and the corner inside
   the map.
2. `zoomedAbout` scales the view by a factor and keeps the given
   point where it was on screen.
3. `homeView` on Delivery, or with no pin showing, is the whole map.
4. On Places it holds every showing pin with a pin's height of room
   around it, centered on them and raised by half a pin.
5. One pin alone is shown at a quarter of the map's width and no
   closer.
6. `atHome` is true within half a unit of the home view's width and
   corner.
7. `tweenAt` is the start at 0, the end at 1, and eases out between.
8. `toMap` and `onScreen` are each other's inverse for a point in
   the frame.
9. `pinScale` keeps a pin 38 px tall at any zoom and any width.
10. `pannedBy` moves the view against the drag, by the drag's
    pixels in map units.

Stay green: `map-fit.test.mjs`.
e2e: `map`, `map-link`.

### Phase 2: tags, tips and where they stand

Moves `stand`, `clearZoom`, `placeTag` and the tip's placing to
`stand.mjs` and `draw.js`; `zipOf`, `toneOf` and `fill` to `tag.mjs`
and `draw.js`.

Criteria:

1. `standAt` centers an element over a point, above it by the lift
   where there is room and below it otherwise, never nearer an edge
   than the margin.
2. `clearOf` leaves an element that does not cover the zoom buttons
   where it is, moves one that does to their left where there is
   room, and under them otherwise.
3. `tipAt` puts the tip below and right of the pointer, and on the
   other side of it where it would pass the frame's edge.
4. `inFrame` is false for a point outside the frame.
5. `toneOf` is ok for a town we deliver to, wait for one a little
   outside, and no for the rest.
6. `tagFacts` gives the town's name, or its ZIP where it has none.
7. It adds the outside-area extra to the fee for a town a little
   outside, and shows no price where we don't deliver.
8. It strikes the hen where a town takes eggs only, and both where
   we don't deliver, and offers the link to Places only then.
9. `zipOf` drops the leading `z`.

Stay green: `zip-check.test.mjs`.
e2e: `map`, `pricing`, `policies`.

### Phase 3: seasons, numbers and the order

Moves `today`, `expire`, `number` and `arrange` to `seasons.mjs` and
`seasons.js`; `schedule` and the `visibilitychange` listener to
`schedule.js`; the hash's reading to `hashTarget`.

Criteria (`seasons.mjs`):

1. `dayOf` is the date on the visitor's clock as `YYYY-MM-DD`.
2. `gone` is true for a day before today, false for today, and
   false with no day.
3. `numbersOf` numbers the showing rows from 1 in the list's order,
   leaving no gap for one that is hidden.
4. `arranged` puts the farm first, then the locations in the order
   `/api/events` names them, then the rest as built.
5. Two locations the events do not tell apart keep their built
   order.
6. `hashTarget` opens Places for `#places` and `#places-scheduled`,
   a place's card for `#place-` and its slug, and nothing for any
   other hash or on a map with no layers.

e2e: `map`, `top-bar-places`, `map-link`.

### Phase 4: the camera

Moves the view, `go`, `zoomAbout`, `home`, `apply`, the zoom
buttons, the wheel, the double click and the resize to `camera.js`;
the element lookups to `parts.js`; `apply`'s writes to `drawView`.

No criteria tests: the arithmetic came in phase 1.
e2e: `map`, `keyboard`.

### Phase 5: gestures

Moves the pointer handlers, `spread`, `middle` and `up` to
`gestures.js` and `gesture.mjs`. A tap is handed to the root.

Criteria (`gesture.mjs`):

1. `spread` is the distance between two pointers, and `middle` the
   point halfway.
2. `isDrag` is false under 6 px of movement and true from there.

e2e: `map`.

### Phase 6: layers and cards

Moves `setLayer`, `stops`, the tabs' keys and `fitList` to
`layers.js`; `show`, `close`, `pressed`, `outline`, `homeOf`,
`reveal`, `bringIn`, `frameTown`, `link`, the pins' keys and Escape
to `cards.js`.

No criteria tests: `fit.mjs` has its own, and the rest is which
element is shown.
Stay green: `map-fit.test.mjs`.
e2e: `map`, `keyboard`, `top-bar-places`, `pickup-days`.

### Phase 7: delivery, links and the root

Moves the tip, `check`, `tap`'s Delivery half, the `nff:zip`
listener and the tag's link to `delivery.js`; `follow`, `toField`
and `settled` to `links.js`. `wire` is what builds the parts, within
the limits, and `map.js` comes off the legacy lists of #782
(quality gates in the build).

No criteria tests.
e2e: every spec named in this document.

## 4. What must not change

- **`nff:zip`:** its name, its `{ zip, tone }`, and that the map
  both hears it from any check on the page and sends it only when
  it has no field of its own.
- **Links:** `#places`, `#places-scheduled`, `#place-<slug>`, and a
  link to the section that holds the map bringing the ZIP field up.
- **ARIA and the keyboard:** `aria-selected` and the one Tab stop
  among the tabs, the arrow keys between them, `aria-labelledby` on
  the frame, `aria-pressed` on pins, `aria-expanded` on rows, pins
  as Tab stops on Places only, Enter and Space on a pin, Escape
  back to the row, the tip hidden from screen readers.
- **Touch:** `touch-action` is `pan-y` at full size and `none`
  zoomed in, so a swipe scrolls the page until the map is zoomed. A
  double tap never zooms. The wheel listener stays not passive.
- **Paint order:** the selected pin is appended last, and put back
  on close.
- **Sizes on screen:** a pin's height, the nudge below zoom 2, the
  margins of a tag.
- **Reduced motion:** the camera jumps.
- **The schedule's failure:** a request that fails leaves the list
  as built.
- **The clock:** today is the visitor's, moved by the staging
  toolbar's (`siteNow`).

The risk is the shared closure. A function that moves out stops
seeing a variable another function reassigns, `pins` above all. So
each phase passes values in and returns them, and the root is the
one place that holds a variable two parts need.

## 5. Where the stall valve is needed

- **`map.js`, phases 1 to 6:** one entry on #791 (the rule
  exceptions log) for the series.
- **`homeView`.** It is fifteen lines of arithmetic that read as
  one thought. It fits the limits only split in two (the pins'
  span, then the view), which the design accepts. No exception is
  expected.

`zip-check/main.js` and `fit.mjs` are within the limits and are not
edited.

## 6. Found while reading

None of these is fixed inside a move.

- No unit test imports `map.js`.
- The SVG has two `pointerdown` and two `pointermove` listeners, and
  the window two `resize` listeners, each doing a different job.
- `show` looks up `homeOf(pin)` twice.
- The `ResizeObserver` and the document's and window's listeners
  are never removed. The map lives as long as the page.
- The tag's link to Places is wired without a check that the markup
  has one. It always does today.
