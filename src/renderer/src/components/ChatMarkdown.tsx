import { memo, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CopyIcon } from './icons'

function CodeBlock({ className, children }: { className?: string; children?: ReactNode }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const content = String(children ?? '').replace(/\n$/, '')
  const language = className?.replace(/^language-/, '') || 'code'
  const copy = (): void => {
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    })
  }
  return (
    <div className="chat-code">
      <div className="chat-code-header">
        <span className="chat-code-language"><i />{language}</span>
        <button
          type="button"
          className={`chat-copy ${copied ? 'is-copied' : ''}`}
          aria-label={copied ? 'Copied' : 'Copy code'}
          title={copied ? 'Copied' : 'Copy code'}
          onClick={copy}
        >
          <CopyIcon size={15} />
        </button>
      </div>
      <pre><code className={className}>{content}</code></pre>
    </div>
  )
}

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const content = String(children ?? '')
    return className?.startsWith('language-') || content.includes('\n')
      ? <CodeBlock className={className}>{children}</CodeBlock>
      : <code className={className}>{children}</code>
  },
  a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
  table: ({ children }) => <div className="chat-table-wrap"><table>{children}</table></div>
}

function ChatMarkdown({ text }: { text: string }): JSX.Element {
  return <div className="chat-prose"><ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown></div>
}

export default memo(ChatMarkdown)
