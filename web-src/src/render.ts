export function escapeHtml(value: unknown): string {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return c;
    }
  });
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return "-";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

export function fmtTime(ts: number | null | undefined): string {
  if (!ts) return "-";
  const d = new Date(ts);
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function fmtNum(value: number | null | undefined): string {
  return value == null ? "-" : Number(value).toLocaleString();
}

export function highlightJson(obj: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(obj, null, 2);
  } catch {
    return escapeHtml(String(obj));
  }
  return escapeHtml(json).replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = "n";
      if (/^"/.test(match)) cls = /:$/.test(match) ? "k" : "s";
      else if (/true|false|null/.test(match)) cls = "b";
      return `<span class="${cls}">${match}</span>`;
    },
  );
}

export function renderResultValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return `<span class="result-scalar">-</span>`;
  if (typeof value === "string") return renderResultString(value);
  if (typeof value !== "object") return `<span class="result-scalar">${escapeHtml(String(value))}</span>`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `<span class="result-scalar">-</span>`;
    if (value.every((item) => item === null || typeof item !== "object")) {
      return `<ul class="result-list">${value.map((item) => `<li>${renderScalarListValue(item)}</li>`).join("")}</ul>`;
    }
    if (canRenderObjectTable(value)) return renderObjectTable(value);
    return `<div class="result-items">${value.map((item) => `<div class="result-subcard">${renderResultValue(item, depth + 1)}</div>`).join("")}</div>`;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return `<span class="result-scalar">{}</span>`;
  if (depth > 3) return `<div class="json-block">${highlightJson(value)}</div>`;

  let out = "";
  let bucket: Array<[string, unknown]> = [];
  const flush = () => {
    if (bucket.length === 0) return;
    if (bucket.length === 1) {
      const [key, val] = bucket[0] as [string, unknown];
      out += `<div class="result-field"><div class="result-key">${escapeHtml(humanizeKey(key))}</div><div class="result-fieldval">${renderResultValue(val, depth + 1)}</div></div>`;
      bucket = [];
      return;
    }
    out += `<div class="result-grid">${bucket
      .map(
        ([key, val]) =>
          `<div class="result-cell"><div class="result-key">${escapeHtml(humanizeKey(key))}</div><div class="result-cellval">${escapeHtml(formatScalar(val))}</div></div>`,
      )
      .join("")}</div>`;
    bucket = [];
  };

  for (const [key, val] of entries) {
    if (isCompact(val)) {
      bucket.push([key, val]);
    } else {
      flush();
      const nested = val !== null && typeof val === "object";
      out += `<div class="result-field"><div class="result-key">${escapeHtml(humanizeKey(key))}</div><div class="result-fieldval${nested ? " nested" : ""}">${renderResultValue(val, depth + 1)}</div></div>`;
    }
  }
  flush();
  return out;
}

export function renderResultString(text: string): string {
  if (looksLikeMarkdown(text)) return `<div class="result-markdown">${renderMarkdown(text)}</div>`;
  return `<div class="result-text">${escapeHtml(text)}</div>`;
}

function renderScalarListValue(value: unknown): string {
  if (typeof value === "string" && looksLikeMarkdown(value)) return `<div class="result-markdown compact">${renderMarkdown(value)}</div>`;
  return escapeHtml(formatScalar(value));
}

export function looksLikeMarkdown(text: string): boolean {
  const s = String(text ?? "");
  if (!s.trim()) return false;
  return (
    /^ {0,3}#{1,6}\s+\S/m.test(s) ||
    /^ {0,3}```/m.test(s) ||
    /^ {0,3}>\s+\S/m.test(s) ||
    /^ {0,3}(?:[-*+]\s+|\d+[.)]\s+)\S/m.test(s) ||
    /^ {0,3}[-*_](?:\s*[-*_]){2,}\s*$/m.test(s) ||
    hasMarkdownTable(s) ||
    /\[[^\]\n]+\]\([^) \n]+(?:\s+"[^"\n]*")?\)/.test(s) ||
    /(^|[^*])\*\*[^*\n][\s\S]*?\*\*/.test(s) ||
    /(^|[^_])__[^_\n][\s\S]*?__/.test(s) ||
    /~~[^~\n][\s\S]*?~~/.test(s) ||
    /`[^`\n]+`/.test(s) ||
    /(^|[\s(])https?:\/\/[^\s<]+/i.test(s)
  );
}

function hasMarkdownTable(text: string): boolean {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    const nextLine = lines[i + 1];
    if (line !== undefined && nextLine !== undefined && splitMarkdownTableLine(line).length >= 2 && isMarkdownTableSeparator(nextLine)) return true;
  }
  return false;
}

export function renderMarkdown(text: string): string {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = line.match(/^ {0,3}```\s*([\w.+-]*)\s*$/);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^ {0,3}```\s*$/.test(lines[i] ?? "")) {
        code.push(lines[i] ?? "");
        i++;
      }
      if (i < lines.length) i++;
      const lang = fence[1] ? ` data-lang="${escapeHtml(fence[1])}"` : "";
      out.push(`<pre${lang}><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const nextLine = lines[i + 1];
    if (nextLine !== undefined && splitMarkdownTableLine(line).length >= 2 && isMarkdownTableSeparator(nextLine)) {
      const table: string[] = [line, nextLine];
      i += 2;
      while (i < lines.length && (lines[i] ?? "").trim() && (lines[i] ?? "").includes("|")) {
        table.push(lines[i] ?? "");
        i++;
      }
      out.push(renderMarkdownTable(table));
      continue;
    }

    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const marks = heading[1] ?? "#";
      const textValue = heading[2] ?? "";
      const level = marks.length;
      out.push(`<h${level}>${renderInlineMarkdown(textValue)}</h${level}>`);
      i++;
      continue;
    }

    if (/^ {0,3}[-*_](?:\s*[-*_]){2,}\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    if (/^ {0,3}>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^ {0,3}>\s?/.test(lines[i] ?? "")) {
        quote.push((lines[i] ?? "").replace(/^ {0,3}>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(quote.join("\n"))}</blockquote>`);
      continue;
    }

    const list = line.match(/^ {0,3}((?:[-*+])|(?:\d+[.)]))\s+(.+)$/);
    if (list) {
      const ordered = /\d/.test((list[1] ?? "")[0] ?? "");
      const items: string[] = [];
      while (i < lines.length) {
        const item = (lines[i] ?? "").match(/^ {0,3}((?:[-*+])|(?:\d+[.)]))\s+(.+)$/);
        if (!item || /\d/.test((item[1] ?? "")[0] ?? "") !== ordered) break;
        let body = item[2] ?? "";
        i++;
        while (
          i < lines.length &&
          (lines[i] ?? "").trim() &&
          !/^ {0,3}(?:[-*+]|\d+[.)])\s+/.test(lines[i] ?? "") &&
          !isMarkdownBlockStart(lines[i] ?? "", lines[i + 1])
        ) {
          body += `\n${(lines[i] ?? "").replace(/^ {2,4}/, "")}`;
          i++;
        }
        items.push(renderMarkdownListItem(body));
      }
      out.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }

    const paragraph = [line];
    i++;
    while (i < lines.length && (lines[i] ?? "").trim() && !isMarkdownBlockStart(lines[i] ?? "", lines[i + 1])) {
      paragraph.push(lines[i] ?? "");
      i++;
    }
    out.push(`<p>${renderInlineMarkdown(paragraph.join("\n")).replace(/\n/g, "<br>")}</p>`);
  }
  return out.join("");
}

function isMarkdownBlockStart(line: string, nextLine: string | undefined): boolean {
  return (
    /^ {0,3}```/.test(line) ||
    /^ {0,3}#{1,6}\s+\S/.test(line) ||
    /^ {0,3}>\s?/.test(line) ||
    /^ {0,3}(?:[-*+]|\d+[.)])\s+\S/.test(line) ||
    /^ {0,3}[-*_](?:\s*[-*_]){2,}\s*$/.test(line) ||
    (nextLine !== undefined && splitMarkdownTableLine(line).length >= 2 && isMarkdownTableSeparator(nextLine))
  );
}

function renderMarkdownListItem(text: string): string {
  const task = text.match(/^\[( |x|X)\]\s+([\s\S]*)$/);
  if (task) {
    const checked = (task[1] ?? "").toLowerCase() === "x" ? " checked" : "";
    return `<li class="task-list-item"><input type="checkbox" disabled${checked}>${renderInlineMarkdown(task[2] ?? "").replace(/\n/g, "<br>")}</li>`;
  }
  return `<li>${renderInlineMarkdown(text).replace(/\n/g, "<br>")}</li>`;
}

function renderMarkdownTable(lines: string[]): string {
  const header = splitMarkdownTableLine(lines[0] ?? "");
  const aligns = splitMarkdownTableLine(lines[1] ?? "").map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    return left && right ? "center" : right ? "right" : left ? "left" : "";
  });
  const rows = lines.slice(2).map(splitMarkdownTableLine).filter((row) => row.length > 0);
  const head = header
    .map((cell, index) => `<th${aligns[index] ? ` style="text-align:${aligns[index]}"` : ""}>${renderInlineMarkdown(cell)}</th>`)
    .join("");
  const body = rows
    .map((row) => `<tr>${header.map((_, index) => `<td${aligns[index] ? ` style="text-align:${aligns[index]}"` : ""}>${renderInlineMarkdown(row[index] ?? "")}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function splitMarkdownTableLine(line: string): string[] {
  const trimmed = String(line ?? "").trim();
  if (!trimmed.includes("|")) return [];
  return trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = splitMarkdownTableLine(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function renderInlineMarkdown(text: string): string {
  const tokens: string[] = [];
  const token = (html: string): string => {
    tokens.push(html);
    return `\uE000${tokens.length - 1}\uE001`;
  };
  let raw = String(text ?? "");
  raw = raw.replace(/`([^`\n]+)`/g, (_match, code: string) => token(`<code>${escapeHtml(code)}</code>`));
  raw = raw.replace(/\[([^\]\n]+)\]\(([^) \n]+)(?:\s+"[^"\n]*")?\)/g, (match: string, label: string, href: string) => {
    const safe = safeMarkdownHref(href);
    return safe ? token(`<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${renderInlineMarkdown(label)}</a>`) : match;
  });
  raw = raw.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/gi, (_match: string, prefix: string, href: string) =>
    `${prefix}${token(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(href)}</a>`)}`,
  );

  let html = escapeHtml(raw);
  html = html.replace(/~~(.+?)~~/g, "<del>$1</del>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");
  html = html.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  html = html.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => tokens[Number(index)] ?? "");
  return html;
}

function safeMarkdownHref(href: string): string {
  const value = String(href ?? "").trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return "";
  if (value.startsWith("//")) return "";
  const lower = value.toLowerCase();
  if (/^(https?:|mailto:)/.test(lower) || value.startsWith("#") || (/^\//.test(value) && !value.startsWith("//")) || /^\.\.?\//.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return "";
  return value;
}

function isCompact(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (typeof value !== "string" || value.includes("\n")) return false;
  if (/^https?:\/\//i.test(value.trim())) return false;
  let width = 0;
  for (const ch of value) width += ch.charCodeAt(0) > 0x2e7f ? 2 : 1;
  return width <= 24;
}

function formatScalar(value: unknown): string {
  return value === null || value === undefined ? "-" : String(value);
}

function canRenderObjectTable(items: unknown[]): items is Array<Record<string, unknown>> {
  if (items.length === 0 || items.length > 200) return false;
  const keys = new Set<string>();
  for (const item of items) {
    if (!isPlainObject(item)) return false;
    for (const [key, value] of Object.entries(item)) {
      keys.add(key);
      if (keys.size > 8 || !isCompact(value)) return false;
    }
  }
  return keys.size > 0;
}

function renderObjectTable(items: Array<Record<string, unknown>>): string {
  const keys = [...new Set(items.flatMap((item) => Object.keys(item)))];
  const head = keys.map((key) => `<th>${escapeHtml(humanizeKey(key))}</th>`).join("");
  const rows = items.map((item) => `<tr>${keys.map((key) => `<td>${escapeHtml(formatScalar(item[key]))}</td>`).join("")}</tr>`).join("");
  return `<div class="result-table-wrap"><table class="result-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function humanizeKey(key: string): string {
  return String(key)
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}
