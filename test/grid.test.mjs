import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkHtml } from "../bin/grid/check.mjs";

const rules = (html) => checkHtml(html).map((f) => f.rule);

describe("the grid check", () => {
  it("passes a container, a row and its columns", () => {
    assert.deepEqual(rules(`
      <div class="container"><section>
        <div class="row g-3">
          <div class="col-md-6"><p>One</p></div>
          <label class="col-sm-3 col-form-label">Two</label>
          <div class="col-12">
            <div class="row"><div class="col">3</div></div>
          </div>
        </div>
      </section></div>`), []);
  });

  it("finds a row outside a container, unless it has no gutter", () => {
    assert.deepEqual(rules(`<div class="row"><div class="col">1</div></div>`),
      ["G1"]);
    assert.deepEqual(
      rules(`<div class="row g-0"><div class="col">1</div></div>`), []);
  });

  it("finds a row's non-column children and bare text", () => {
    assert.deepEqual(rules(`<div class="container"><div class="row">
      <p>Words</p> loose <div class="col">ok</div></div></div>`),
    ["G2", "G3"]);
  });

  it("finds a row straight inside a row", () => {
    assert.deepEqual(rules(`<div class="container"><div class="row">
      <div class="col"><div class="row"><div class="row">
      <div class="col">x</div></div></div></div></div></div>`),
    ["G2", "G4"]);
  });

  it("leaves a row in a template to where the script puts it", () => {
    assert.deepEqual(rules(`<template id="t"><form>
      <div class="row g-3"><div class="col-md-6">x</div></div>
      </form></template>`), []);
  });

  it("finds spacing that fights the gutter, and wide gutters", () => {
    assert.deepEqual(rules(`<div class="container"><div class="row px-3">
      <div class="col">x</div></div></div>`), ["G5"]);
    assert.deepEqual(rules(`<div class="container"><div class="row g-lg-5">
      <div class="col">x</div></div></div>`), ["G6"]);
    assert.deepEqual(rules(`<div class="container"><div class="overflow-hidden">
      <div class="row g-lg-5"><div class="col">x</div></div></div></div>`),
    []);
    assert.deepEqual(rules(`<div class="container px-4"><div class="row gx-5">
      <div class="col">x</div></div></div>`), []);
  });

  it("warns of a container in a container", () => {
    assert.deepEqual(rules(`<div class="container"><div class="container-md">
      </div></div>`), ["G8"]);
  });

  it("finds classes Bootstrap 5.3 does not have", () => {
    assert.deepEqual(rules(`<div class="col-xs-6 col-md-13 ml-2 text-left
      no-gutters sr-only" data-toggle="collapse"></div>`),
    ["G10", "G10", "G12", "G12", "G12", "G12", "G12"]);
  });

  it("finds a row on an element that cannot be a flex container", () => {
    assert.deepEqual(rules(`<div class="container"><fieldset class="row">
      <div class="col">x</div></fieldset></div>`), ["G13"]);
  });

  it("skips scripts and comments, and names the line", () => {
    const html = `<div class="container">
      <script>const s = '<div class="row">';</script>
      <!-- <div class="row">x</div> -->
      <div class="row">text</div></div>`;
    assert.deepEqual(checkHtml(html).map((f) => [f.rule, f.line]),
      [["G3", 4]]);
  });
});
