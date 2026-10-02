import { useEffect } from 'react';
import { dispatch, useStore } from '../store';

export function Toast() {
  const toast = useStore((s) => s.toast);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => dispatch({ kind: 'dismissToast' }), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  if (!toast) return null;
  return (
    <div className="toast" onClick={() => dispatch({ kind: 'dismissToast' })}>
      {toast}
    </div>
  );
}
