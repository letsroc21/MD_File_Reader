import { convertFileSrc } from "@tauri-apps/api/core";
import DOMPurify, { type Config } from "dompurify";
import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import taskLists from "markdown-it-task-lists";
import type { MouseEvent } from "react";
import { isLocalMarkdownHref, markdownItWikiLinks } from "../wiki";

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
})
  .use(footnote)
  .use(taskLists, { enabled: true, label: true })
  .use(markdownItWikiLinks);

const PURIFY_CONFIG: Config = {
  ADD_TAGS: ["input"],
  ADD_ATTR: ["checked", "disabled", "type", "class", "id", "data-wiki-target"],
  ALLOWED_URI_REGEXP:
    /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|asset):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
};

function resolveImages(html: string, filePath: string | null) {
  if (!filePath) {
    return html;
  }
  const dir = filePath.replace(/[/\\][^/\\]+$/, "");
  return html.replace(/<img\s+([^>]*?)src="([^"]+)"/g, (full, attrs, src) => {
    if (/^(https?:|data:|asset:|blob:)/i.test(src)) {
      return full;
    }
    const absolute = `${dir}/${src}`;
    try {
      return `<img ${attrs}src="${convertFileSrc(absolute)}"`;
    } catch {
      return full;
    }
  });
}

type ReadingViewProps = {
  text: string;
  filePath: string | null;
  onOpenNote?: (target: string) => void;
};

export default function ReadingView({ text, filePath, onOpenNote }: ReadingViewProps) {
  const rendered = resolveImages(md.render(text || "<p><em>Nothing to preview.</em></p>"), filePath);
  const html = DOMPurify.sanitize(rendered, PURIFY_CONFIG);

  function handleClick(event: MouseEvent<HTMLElement>) {
    const anchor = (event.target as HTMLElement | null)?.closest("a");
    if (!anchor || !onOpenNote) {
      return;
    }
    const wiki = anchor.getAttribute("data-wiki-target");
    const href = anchor.getAttribute("href") || "";
    if (wiki) {
      event.preventDefault();
      onOpenNote(wiki);
      return;
    }
    if (isLocalMarkdownHref(href)) {
      event.preventDefault();
      onOpenNote(href.split("#")[0]);
    }
  }

  return (
    <article
      className="reading-page"
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
