import { useState } from 'react'

const MODELS = ['Claude', 'ChatGPT', 'Local'] as const

export default function ChatPanel(): JSX.Element {
  // Visual-only in Phase 1; the selection drives nothing yet.
  // TODO(phase 3): feed the selected model into the planner-chat router.
  const [model, setModel] = useState<(typeof MODELS)[number]>('Claude')
  const [draft, setDraft] = useState('')

  return (
    <aside className="chat-panel">
      <header className="chat-header">
        <span className="chat-header-title">Planner</span>
        <select
          className="model-select"
          value={model}
          onChange={(event) => setModel(event.target.value as (typeof MODELS)[number])}
          aria-label="Model"
        >
          {MODELS.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </header>

      {/* TODO(phase 3): render the real conversation; stream replies from the
          selected backend; add the "send prompt to terminal" bridge button on
          assistant messages. */}
      <div className="chat-messages">
        <div className="chat-empty">
          <div className="chat-empty-glyph">{'>_'}</div>
          <div>No messages yet</div>
          <div className="chat-empty-hint">
            Plan with {model}, then send prompts straight into a terminal.
          </div>
        </div>
      </div>

      <div className="chat-composer">
        <textarea
          className="chat-input"
          placeholder="Describe what you want to build…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={3}
          spellCheck={false}
        />
        <div className="chat-composer-row">
          {/* TODO(phase 3): enable and wire to the chat backend. */}
          <button type="button" className="send-button" disabled>
            Send
          </button>
        </div>
      </div>
    </aside>
  )
}
