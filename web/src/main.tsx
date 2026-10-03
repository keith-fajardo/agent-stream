import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { App } from './App';
import { ChatApp } from './ChatApp';
import { connect } from './bridge';
import { connectChat } from './chatBridge';
import { loadLayout } from './panelLayout';
import { dispatch } from './store';
import { viewMode } from './viewMode';

const view = viewMode(document.body.dataset);
if (view === 'graph') {
  dispatch({ kind: 'setMinimap', value: document.body.dataset.minimap !== 'false' });
  dispatch({ kind: 'setLayout', layout: loadLayout() });
}
createRoot(document.getElementById('root')!).render(<StrictMode>{view === 'chat' ? <ChatApp /> : <App />}</StrictMode>);
if (view === 'chat') connectChat();
else connect();
