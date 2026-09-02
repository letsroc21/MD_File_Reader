import { convertFileSrc } from "@tauri-apps/api/core";
import DOMPurify, { type Config } from "dompurify";
import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import taskLists from "markdown-it-task-lists";

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
})
  .use(footnote)
  .use(taskLists, { enabled: true, label: true });

const PURIFY_CONFIG: Config = {
  ADD_TAGS: ["input"],
  ADD_ATTR: ["checked", "disabled", "type", "class", "id"],
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
};

export default function ReadingView({ text, filePath }: ReadingViewProps) {
  const rendered = resolveImages(md.render(text || "<p><em>Nothing to preview.</em></p>"), filePath);
  const html = DOMPurify.sanitize(rendered, PURIFY_CONFIG);
  return (
    <article className="reading-page" dangerouslySetInnerHTML={{ __html: html }} />
  );
}
