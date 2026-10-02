// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { ChatPanel } from '../src/components/ChatPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ChatPanel', () => {
  // Chrome 154+ returns a Promise from scrollIntoView(). An effect that returns it hands
  // React a non-function "cleanup", which crashes the whole page when the panel unmounts.
  it('mounts and unmounts cleanly when scrollIntoView returns a Promise', async () => {
    Element.prototype.scrollIntoView = vi.fn(() => Promise.resolve()) as unknown as Element['scrollIntoView'];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const root = createRoot(document.createElement('div'));
    try {
      await act(async () => root.render(createElement(ChatPanel)));
      await act(async () => root.unmount());
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});
