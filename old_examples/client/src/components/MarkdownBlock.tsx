import React, { useState, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Copy, Check } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import type { Components } from 'react-markdown';

// KaTeX CSS
import 'katex/dist/katex.min.css';

interface MarkdownBlockProps {
  content: string;
}

// Custom code block with copy button
const CodeBlock: React.FC<{
  isBlock?: boolean;
  className?: string;
  children?: React.ReactNode;
}> = memo(({ isBlock, className, children }) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  
  // Extract language from className (format: "language-xxx")
  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : '';
  
  const handleCopy = async () => {
    const text = String(children).replace(/\n$/, '');
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Inline code
  if (!isBlock) {
    return <code className={className}>{children}</code>;
  }

  // Block code with copy button
  return (
    <div className="relative group">
      {/* Language badge + Copy button */}
      <div className="absolute top-0 right-0 flex items-center gap-1 p-2 opacity-0 group-hover:opacity-100 transition-opacity z-10">
        {language && (
          <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium bg-zinc-800/80 px-2 py-1 rounded-md">
            {language}
          </span>
        )}
        <button
          onClick={handleCopy}
          className={clsx(
            "p-1.5 rounded-md transition-all",
            copied 
              ? "bg-emerald-500/20 text-emerald-400" 
              : "bg-zinc-800/80 text-zinc-400 hover:text-white hover:bg-zinc-700/80"
          )}
          title={copied ? t('chat.copied') : t('chat.copyCode')}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <pre className={className}>
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
});

export const MarkdownBlock: React.FC<MarkdownBlockProps> = memo(({ content }) => {
  // Hide content inside <action> tags (even unclosed)
  // Regex explains:
  // <action>       - start tag
  // [\s\S]*?       - any content (non-greedy)
  // (?:<\/action>|$) - end tag OR end of string (for unclosed tags during streaming)
  const cleanContent = content.replace(/<action>[\s\S]*?(?:<\/action>|$)/g, '').trim();

  if (!cleanContent) return null;

  const components: Components = {
    // Pre tag - wraps code blocks, we use it to detect block vs inline
    pre: ({ children }) => {
      // Clone children and mark as block code
      const child = React.Children.only(children) as React.ReactElement<{
        className?: string;
        children?: React.ReactNode;
      }>;
      if (child && child.type === 'code') {
        return (
          <CodeBlock 
            isBlock={true} 
            className={child.props.className}
          >
            {child.props.children}
          </CodeBlock>
        );
      }
      return <pre>{children}</pre>;
    },
    // Inline code only (not wrapped in pre)
    code: ({ className, children }) => (
      <CodeBlock isBlock={false} className={className}>
        {children}
      </CodeBlock>
    ),
    // Ensure links open in new tab
    a: ({ href, children }) => (
      <a 
        href={href} 
        target="_blank" 
        rel="noopener noreferrer"
      >
        {children}
      </a>
    ),
  };

  return (
    <div className="markdown-prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={components}
      >
        {cleanContent}
      </ReactMarkdown>
    </div>
  );
}, (prevProps, nextProps) => {
    // Custom comparison function if needed, but default shallow compare of props is usually fine for string content
    // However, for streaming large texts, we might want to optimize. 
    // For now, simple memo is good enough to prevent parent re-renders from affecting this if props match.
    return prevProps.content === nextProps.content;
});
