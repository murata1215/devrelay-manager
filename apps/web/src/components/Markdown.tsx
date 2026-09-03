/**
 * Markdown 描画ラッパー（サイクル1.25 要求A）。
 *
 * react-markdown + remark-gfm。生 HTML は描画しない（追加プラグイン無し・既定動作のまま）。
 * リンクは target=_blank + rel=noopener noreferrer で新規タブに開く。
 * className / linkTarget props は react-markdown v10 で廃止されたため、
 * ラッパー div（.md、styles.css 側でタイポグラフィを定義）と components.a で代替する。
 */
import type { ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownProps {
  children: string;
}

function MarkdownLink(props: ComponentProps<'a'>) {
  return <a {...props} target="_blank" rel="noopener noreferrer" />;
}

export function Markdown({ children }: MarkdownProps) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: MarkdownLink }}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
