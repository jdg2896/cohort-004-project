import { marked, Renderer } from "marked";
import sanitizeHtml from "sanitize-html";
import { type Highlighter, createHighlighter } from "shiki";

let highlighter: Highlighter | null = null;

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighter) {
    highlighter = await createHighlighter({
      themes: ["github-dark"],
      langs: ["typescript", "javascript", "json", "bash", "html", "css", "tsx", "jsx", "sql", "yaml", "markdown", "text", "plaintext"],
    });
  }
  return highlighter;
}

export async function renderMarkdown(markdown: string): Promise<string> {
  const hl = await getHighlighter();

  const renderer = new Renderer();
  renderer.code = ({ text, lang }) => {
    const language = lang || "text";
    try {
      return hl.codeToHtml(text, {
        lang: language,
        theme: "github-dark",
      });
    } catch {
      // Fall back to plain <pre><code> if the language isn't loaded
      const escaped = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return `<pre><code>${escaped}</code></pre>`;
    }
  };

  return marked.parse(markdown, { renderer }) as string;
}

// Renders user-authored Markdown (lesson comments) to HTML, then runs it through
// an allowlist sanitizer. Unlike renderMarkdown — which is trusted instructor
// content — comment bodies are untrusted, so we must strip anything that could
// carry script. The allowlist deliberately keeps Shiki's syntax-highlighting
// output working: <pre>/<code>/<span> with their class/style/tabindex attributes.
export async function renderCommentMarkdown(markdown: string): Promise<string> {
  const html = await renderMarkdown(markdown);

  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["span", "img"]),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      a: ["href", "name", "target", "rel"],
      span: ["class", "style"],
      code: ["class", "style"],
      pre: ["class", "style", "tabindex"],
      img: ["src", "alt", "title"],
    },
    // Shiki emits inline color / background-color on <pre> and <span>; permit
    // only those two declarations so highlighting survives sanitization.
    allowedStyles: {
      "*": {
        color: [/.*/],
        "background-color": [/.*/],
      },
    },
    // Force user links to be safe: no referrer leakage, no SEO juice, new tab.
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", {
        rel: "noopener noreferrer nofollow",
        target: "_blank",
      }),
    },
  });
}
