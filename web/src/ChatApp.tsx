import { post } from './bridge';
import { ChatPanel } from './components/ChatPanel';
import { ModelPicker } from './components/ModelPicker';
import { useStore } from './store';

export function ChatApp() {
  const target = useStore((s) => s.chatTarget);
  if (!target) {
    return (
      <div className="chat-app empty">
        <p className="muted">Open a graph to chat with the planner.</p>
      </div>
    );
  }
  return (
    <div className="chat-app">
      <header className="chat-head">
        <span className="chat-graph" title={target.graphName}>
          {target.graphName}
        </span>
        <button className="link chat-session" data-action="switchSession" title="Switch session" onClick={() => post({ type: 'chatCommand', command: 'switchSession' })}>
          {target.sessionName} ▾
        </button>
        <ModelPicker graphId={target.graphId} sessionId={target.sessionId} />
        <button data-action="newChat" title="Start a new conversation" onClick={() => post({ type: 'chatCommand', command: 'newChat' })}>
          New chat
        </button>
      </header>
      <ChatPanel />
    </div>
  );
}
