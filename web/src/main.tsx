import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { App } from './App';
import { connect } from './bridge';
import { dispatch } from './store';

dispatch({ kind: 'setMinimap', value: document.body.dataset.minimap !== 'false' });
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
connect();
