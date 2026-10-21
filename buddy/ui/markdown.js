function safeLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function inline(text, depth = 0) {
  if (depth > 24) return [{ type: "text", text }];
  const tokens = [];
  const plain = (value) => {
    if (tokens.at(-1)?.type === "text") tokens.at(-1).text += value;
    else tokens.push({ type: "text", text: value });
  };
  let at = 0;
  while (at < text.length) {
    const rest = text.slice(at);
    let match;
    if ((match = /^\\([\\`*_{}\[\]()#+.!>|-])/.exec(rest))) {
      plain(match[1]);
    } else if ((match = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(rest))) {
      tokens.push({ type: "code", text: match[2] });
    } else if ((match = /^\[([^\]\n]+)\]\(([^\s()]*(?:\([^\s()]*\)[^\s()]*)*)\)/.exec(rest))) {
      const href = safeLink(match[2]);
      if (href) tokens.push({ type: "a", href, children: inline(match[1], depth + 1) });
      else plain(match[0]);
    } else if ((match = /^(\*\*|__)(?=\S)([\s\S]+?)\1/.exec(rest))) {
      tokens.push({ type: "strong", children: inline(match[2], depth + 1) });
    } else if ((match = /^(\*|_)(?=\S)([^\n]+?)\1/.exec(rest)) &&
      !(match[1] === "_" && /\w/.test(text[at - 1] || ""))) {
      tokens.push({ type: "em", children: inline(match[2], depth + 1) });
    } else {
      plain(text[at++]);
      continue;
    }
    at += match[0].length;
  }
  return tokens;
}

const listItem = (line) => /^\s{0,3}([-+*]|\d+[.)])\s+(.*)$/.exec(line);
const fence = (line) => /^\s{0,3}(`{3,}|~{3,})\s*([^\s]*)[^\n]*$/.exec(line);
const cells = (line) => line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.trim());
function tableAt(lines, at) {
  if (!lines[at]?.includes("|") || !lines[at + 1]) return false;
  const separator = cells(lines[at + 1]);
  return separator.length === cells(lines[at]).length && separator.every((cell) => /^:?-{3,}:?$/.test(cell));
}
function blockAt(lines, at) {
  return fence(lines[at]) || /^\s{0,3}(#{1,6}\s|>)/.test(lines[at]) || listItem(lines[at]) || tableAt(lines, at);
}

export function parseMarkdown(source, depth = 0) {
  const lines = String(source).replace(/\r\n?/g, "\n").split("\n");
  const tokens = [];
  if (depth > 24) return [{ type: "p", children: [{ type: "text", text: source }] }];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at];
    let match;
    if (!line.trim()) { at += 1; continue; }
    if ((match = fence(line))) {
      const marker = match[1];
      const body = [];
      at += 1;
      while (at < lines.length && !new RegExp(`^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[at])) body.push(lines[at++]);
      if (at < lines.length) at += 1;
      tokens.push({ type: "pre", language: match[2], text: body.join("\n") });
    } else if ((match = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line))) {
      tokens.push({ type: `h${match[1].length}`, children: inline(match[2].replace(/\s+#+\s*$/, "")) });
      at += 1;
    } else if (/^\s{0,3}>/.test(line)) {
      const body = [];
      while (at < lines.length && /^\s{0,3}>/.test(lines[at])) body.push(lines[at++].replace(/^\s{0,3}> ?/, ""));
      tokens.push({ type: "blockquote", children: parseMarkdown(body.join("\n"), depth + 1) });
    } else if (tableAt(lines, at)) {
      const header = cells(line);
      at += 2;
      const rows = [];
      while (at < lines.length && lines[at].trim() && lines[at].includes("|")) {
        const row = cells(lines[at++]);
        rows.push({ type: "tr", children: header.map((_, index) => ({ type: "td", children: inline(row[index] || "") })) });
      }
      tokens.push({ type: "table", children: [
        { type: "thead", children: [{ type: "tr", children: header.map((cell) => ({ type: "th", children: inline(cell) })) }] },
        { type: "tbody", children: rows },
      ] });
    } else if ((match = listItem(line))) {
      const ordered = /^\d/.test(match[1]);
      const children = [];
      const start = ordered ? parseInt(match[1], 10) : undefined;
      while (at < lines.length) {
        const item = listItem(lines[at]);
        if (!item || /^\d/.test(item[1]) !== ordered) break;
        children.push({ type: "li", children: inline(item[2]) });
        at += 1;
      }
      tokens.push({ type: ordered ? "ol" : "ul", start, children });
    } else {
      const body = [line];
      at += 1;
      while (at < lines.length && lines[at].trim() && !blockAt(lines, at)) body.push(lines[at++]);
      tokens.push({ type: "p", children: inline(body.join("\n")) });
    }
  }
  return tokens;
}

export function buildMarkdown(tokens, doc = document, highlighter = globalThis.hljs) {
  const make = (tag, text, className) => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  function codeBlock(token) {
    const box = make("div", undefined, "code-block");
    const header = make("div", undefined, "code-head");
    const copy = make("button", "Copy", "button button--quiet");
    copy.type = "button";
    copy.setAttribute("aria-label", `Copy ${token.language || "plain text"} code`);
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(token.text);
        copy.textContent = "Copied";
      } catch {
        copy.textContent = "Copy failed";
      }
      setTimeout(() => { copy.textContent = "Copy"; }, 2000);
    };
    header.append(make("span", `${(token.language || "Plain text").toUpperCase()} ·`), copy);
    const pre = make("pre");
    const code = make("code", token.text, "hljs");
    if (highlighter?.getLanguage(token.language)) {
      try {
        // highlight.js escapes source text before adding its own span markup.
        code.innerHTML = highlighter.highlight(token.text, { language: token.language, ignoreIllegals: true }).value;
      } catch {
        code.textContent = token.text;
      }
    }
    pre.append(code);
    box.append(header, pre);
    return box;
  }
  function build(token) {
    if (token.type === "pre") return codeBlock(token);
    const node = make(token.type === "text" ? "span" : token.type, token.text);
    if (token.type === "a") {
      const href = safeLink(token.href);
      if (href) { node.href = href; node.rel = "noopener noreferrer"; }
    }
    if (token.type === "ol" && token.start !== undefined) node.start = token.start;
    if (token.children) node.append(...token.children.map(build));
    if (token.type === "table") {
      const scroll = make("div", undefined, "table-scroll");
      scroll.append(node);
      return scroll;
    }
    return node;
  }
  const fragment = doc.createDocumentFragment();
  fragment.append(...tokens.map(build));
  return fragment;
}

export function renderMarkdown(text) {
  return buildMarkdown(parseMarkdown(text));
}
