// TODO(phase 4): replace static placeholders with real session history loaded
//                from SQLite via window.api, grouped under these three folders.

const SECTIONS = [
  { label: 'Claude', placeholder: 'No sessions yet' },
  { label: 'ChatGPT', placeholder: 'No sessions yet' },
  { label: 'Local', placeholder: 'No sessions yet' }
] as const

export default function Sidebar(): JSX.Element {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">Agent Workspace</div>
      {SECTIONS.map((section) => (
        <section className="sidebar-section" key={section.label}>
          <div className="sidebar-section-header">{section.label}</div>
          <div className="sidebar-item">
            <span className="sidebar-item-dot" />
            <span>{section.placeholder}</span>
          </div>
        </section>
      ))}
    </aside>
  )
}
