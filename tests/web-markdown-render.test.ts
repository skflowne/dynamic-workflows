import assert from "node:assert/strict";
import test from "node:test";
import { looksLikeMarkdown, renderResultString, renderResultValue } from "../web-src/src/render.js";

interface MarkdownHarness {
  looksLikeMarkdown(text: string): boolean;
  renderResultString(text: string): string;
  renderResultValue(value: unknown, depth: number): string;
}

const harness: MarkdownHarness = { looksLikeMarkdown, renderResultString, renderResultValue };

test("web result renderer renders markdown strings with capped prose container", () => {
  const md = harness;
  assert.equal(md.looksLikeMarkdown("plain result text"), false);
  const html = md.renderResultString("# Title\n\nThis is **bold** with `code`.\n\n- one\n- two");
  assert.match(html, /class="result-markdown"/);
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
});

test("web result markdown renderer escapes html and blocks unsafe link protocols", () => {
  const md = harness;
  const html = md.renderResultString('# Hi <img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1))\n\n[ok](https://example.com)');
  assert.doesNotMatch(html, /<img\b/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.doesNotMatch(md.renderResultString("[protocol-relative](//example.com)"), /href="\/\/example.com"/);

  const code = md.renderResultString("```html\n<script>alert(1)</script>\n```");
  assert.doesNotMatch(code, /<script>/i);
  assert.match(code, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("web result renderer applies markdown inside string fields and scalar lists", () => {
  const md = harness;
  const objectHtml = md.renderResultValue({ summary: "## Summary\n\n| A | B |\n| --- | --- |\n| 1 | 2 |" }, 0);
  assert.match(objectHtml, /<h2>Summary<\/h2>/);
  assert.match(objectHtml, /<table><thead>/);

  const listHtml = md.renderResultValue(["plain", "**marked**"], 0);
  assert.match(listHtml, /plain/);
  assert.match(listHtml, /class="result-markdown compact"/);
  assert.match(listHtml, /<strong>marked<\/strong>/);
});
