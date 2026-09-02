export type WikiLink = {
  target: string;
  alias: string;
  from: number;
  to: number;
};

const WIKI_RE = /!?\[\[([^\]\n]+?)\]\]/g;

export function parseWikiInner(inner: string): { target: string; alias: string } {
  const pipe = inner.indexOf("|");
  const rawTarget = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
  const alias = (pipe >= 0 ? inner.slice(pipe + 1) : rawTarget).trim();
  const hash = rawTarget.indexOf("#");
  const target = (hash >= 0 ? rawTarget.slice(0, hash) : rawTarget).trim();
  return { target, alias: alias || target };
}

export function findWikiLinks(text: string): WikiLink[] {
  const links: WikiLink[] = [];
  const re = new RegExp(WIKI_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const { target, alias } = parseWikiInner(match[1]);
    if (!target) {
      continue;
    }
    links.push({
      target,
      alias,
      from: match.index,
      to: match.index + match[0].length,
    });
  }
  return links;
}

export function wikiLinkAt(text: string, pos: number): WikiLink | null {
  return findWikiLinks(text).find((link) => pos >= link.from && pos < link.to) ?? null;
}

type WikiInlineState = {
  src: string;
  pos: number;
  posMax: number;
  push: (type: string, tag: string, nesting: -1 | 0 | 1) => {
    attrSet: (name: string, value: string) => void;
    content: string;
  };
};

type WikiMarkdownIt = {
  inline: {
    ruler: {
      before: (
        beforeName: string,
        ruleName: string,
        fn: (state: WikiInlineState, silent: boolean) => boolean,
      ) => void;
    };
  };
};

export function markdownItWikiLinks(md: WikiMarkdownIt) {
  md.inline.ruler.before("link", "obsidian_wiki", (state, silent) => {
    const src = state.src;
    let start = state.pos;
    if (src.charCodeAt(start) === 0x21) {
      start += 1;
    }
    if (src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5b) {
      return false;
    }
    const close = src.indexOf("]]", start + 2);
    if (close < 0 || close > state.posMax) {
      return false;
    }
    const inner = src.slice(start + 2, close);
    if (inner.includes("\n")) {
      return false;
    }
    const { target, alias } = parseWikiInner(inner);
    if (!target) {
      return false;
    }
    if (silent) {
      return true;
    }
    const open = state.push("link_open", "a", 1);
    open.attrSet("href", "#");
    open.attrSet("class", "wiki-link");
    open.attrSet("data-wiki-target", target);
    const text = state.push("text", "", 0);
    text.content = alias;
    state.push("link_close", "a", -1);
    state.pos = close + 2;
    return true;
  });
}

export function isLocalMarkdownHref(href: string) {
  if (!href || /^(https?:|mailto:|data:|blob:|#)/i.test(href)) {
    return false;
  }
  return /\.(md|markdown|mdown|mkd|txt)$/i.test(href.split("#")[0]);
}
