import Sidebar from './components/Sidebar'
import TerminalColumn from './components/TerminalColumn'
import ChatPanel from './components/ChatPanel'

export default function App(): JSX.Element {
  return (
    <div className="app">
      <Sidebar />
      <TerminalColumn />
      <ChatPanel />
    </div>
  )
}
