import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// The app uses browser ES modules without a package-wide Node module setting.
const source = await readFile(new URL("./markdown.js", import.meta.url), "utf8");
const { parseMarkdown, buildMarkdown } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const flatten = (tokens) => tokens.flatMap((token) => [token, ...flatten(token.children || [])]);
const text = (tokens) => flatten(tokens).filter((token) => token.text !== undefined).map((token) => token.text).join("");

const script = '<script>alert("x")</script>';
assert.equal(text(parseMarkdown(script)), script);
assert.deepEqual(flatten(parseMarkdown(script)).map((token) => token.type), ["p", "text"]);
for (const href of ["javascript:alert(1)", "data:text/html,bad", "file:///etc/passwd", "//example.com", "mailto:a@example.com"]) {
  assert.equal(flatten(parseMarkdown(`[click](${href})`)).some((token) => token.type === "a"), false, href);
}
const link = flatten(parseMarkdown("[Docs](https://example.com/a_(b))")).find((token) => token.type === "a");
assert.equal(link.href, "https://example.com/a_(b)");
assert.equal(text(link.children), "Docs");
const fenced = parseMarkdown('```javascript\nconst x = "<script>";\n```');
assert.deepEqual(fenced, [{ type: "pre", language: "javascript", text: 'const x = "<script>";' }]);
assert.equal(parseMarkdown("~~~~css\na {}\n~~~\n~~~~")[0].text, "a {}\n~~~");
assert.equal(parseMarkdown("```unknown\n<svg onload=alert(1)>")[0].text, "<svg onload=alert(1)>");
const table = parseMarkdown("| Name | Value |\n| --- | ---: |\n| **Relay** | `1` |\n| Other | 2 |");
assert.equal(table[0].type, "table");
assert.equal(flatten(table).filter((token) => token.type === "th").length, 2);
assert.equal(flatten(table).filter((token) => token.type === "td").length, 4);
assert.ok(flatten(table).some((token) => token.type === "strong"));
assert.equal(parseMarkdown("a | b\nnot a separator")[0].type, "p");
const formatted = flatten(parseMarkdown("# Title\n\nA **bold** and *italic* reply with `code`.\n\n- One\n- Two\n\n3. Three\n4. Four\n\n> Quote"));
for (const type of ["h1", "p", "strong", "em", "code", "ul", "ol", "blockquote"]) assert.ok(formatted.some((token) => token.type === type), type);
assert.equal(formatted.find((token) => token.type === "ol").start, 3);
assert.equal(text(parseMarkdown("snake_case_name")), "snake_case_name");
assert.equal(text(parseMarkdown("\\*literal\\*")), "*literal*");
assert.deepEqual(parseMarkdown("\n\n"), []);

// A DOM double rejects HTML writes, except the single highlighted code sink.
class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.value = ""; }
  append(...children) { this.children.push(...children); }
  set textContent(value) { this.value = value; this.children = []; }
  get textContent() { return this.value + this.children.map((child) => child.textContent).join(""); }
  set innerHTML(value) {
    assert.equal(this.tag, "code");
    assert.equal(this.className, "hljs");
    this.html = value;
  }
  setAttribute(name, value) { this.attributes[name] = value; }
}
const doc = { createElement: (tag) => new Node(tag), createDocumentFragment: () => new Node("fragment") };
const descendants = (node) => [node, ...node.children.flatMap(descendants)];
const rendered = buildMarkdown(parseMarkdown(`${script}\n\n[bad](javascript:alert(1)) [safe](https://example.com)`), doc, null);
assert.ok(rendered.textContent.includes(script));
assert.equal(descendants(rendered).some((node) => node.tag === "script"), false);
const anchors = descendants(rendered).filter((node) => node.tag === "a");
assert.equal(anchors.length, 1);
assert.equal(anchors[0].rel, "noopener noreferrer");
assert.equal(anchors[0].href, "https://example.com/");
const renderedTable = buildMarkdown(table, doc, null);
assert.equal(descendants(renderedTable).filter((node) => node.tag === "td").length, 4);
const plainCode = buildMarkdown(parseMarkdown("```unknown\n<script>bad()</script>\n```"), doc, null);
assert.equal(descendants(plainCode).find((node) => node.tag === "code").textContent, "<script>bad()</script>");
assert.equal(descendants(plainCode).some((node) => node.html), false);

const context = vm.createContext({});
vm.runInContext(await readFile(new URL("./vendor/highlight.min.js", import.meta.url), "utf8"), context);
assert.equal(context.hljs.versionString, "11.9.0");
const highlighted = buildMarkdown(fenced, doc, context.hljs);
const code = descendants(highlighted).find((node) => node.tag === "code");
assert.ok(code.html.includes("hljs-"));
assert.ok(code.html.includes("&lt;script&gt;"));
assert.ok(!code.html.includes("<script>"));
const failedHighlight = buildMarkdown(fenced, doc, { getLanguage: () => true, highlight: () => { throw new Error("Unavailable"); } });
assert.equal(descendants(failedHighlight).find((node) => node.tag === "code").textContent, fenced[0].text);

let copied;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (value) => { copied = value; } } } });
const button = descendants(highlighted).find((node) => node.tag === "button");
assert.equal(button.attributes["aria-label"], "Copy javascript code");
await button.onclick();
assert.equal(copied, fenced[0].text);
assert.equal(button.textContent, "Copied");
globalThis.navigator.clipboard.writeText = async () => { throw new Error("Denied"); };
await button.onclick();
assert.equal(button.textContent, "Copy failed");
console.log("Markdown parse, safe DOM, highlighting, and clipboard tests passed.");
