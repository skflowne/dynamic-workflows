import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

interface MarkdownHarness {
  looksLikeMarkdown(text: string): boolean;
  renderResultString(text: string): string;
  renderResultValue(value: unknown, depth: number): string;
}

async function loadHarness(): Promise<MarkdownHarness> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const app = await readFile(path.join(root, "web", "app.js"), "utf8");
  const renderOnly = app.split("/* ----------------------------- Events / routing")[0];
  const context = {
    document: { querySelector: () => null, getElementById: () => null },
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (fn: () => void) => fn(),
    console,
  } as Record<string, unknown>;
  runInNewContext(
    `${renderOnly}
globalThis.__md = { looksLikeMarkdown, renderResultString, renderResultValue };`,
    context,
    { filename: "web/app.js" },
  );
  return context.__md as MarkdownHarness;
}

test("web result renderer renders markdown strings with capped prose container", async () => {
  const md = await loadHarness();
  assert.equal(md.looksLikeMarkdown("plain result text"), false);
  const html = md.renderResultString("# Title\n\nThis is **bold** with `code`.\n\n- one\n- two");
  assert.match(html, /class="result-markdown"/);
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
});

test("web result markdown renderer escapes html and blocks unsafe link protocols", async () => {
  const md = await loadHarness();
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

test("web result renderer applies markdown inside string fields and scalar lists", async () => {
  const md = await loadHarness();
  const objectHtml = md.renderResultValue({ summary: "## Summary\n\n| A | B |\n| --- | --- |\n| 1 | 2 |" }, 0);
  assert.match(objectHtml, /<h2>Summary<\/h2>/);
  assert.match(objectHtml, /<table><thead>/);

  const listHtml = md.renderResultValue(["plain", "**marked**"], 0);
  assert.match(listHtml, /plain/);
  assert.match(listHtml, /class="result-markdown compact"/);
  assert.match(listHtml, /<strong>marked<\/strong>/);
});
