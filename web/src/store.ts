import { useSyncExternalStore } from 'react';
import { initialState, reduce, type Action, type State } from './state';

let state: State = initialState;
const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}

/** Test-only: puts the store back to its initial state. */
export function resetStoreForTests(): void {
  state = initialState;
  for (const listener of listeners) listener();
}

export function dispatch(action: Action): void {
  state = reduce(state, action);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Selectors must return a slice of state (not a new object) so React can compare by reference. */
export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}
