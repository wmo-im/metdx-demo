import '@testing-library/jest-dom/vitest';

// jsdom lacks these; OpenLayers needs ResizeObserver.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

if (!URL.createObjectURL) URL.createObjectURL = () => 'blob:mock';
if (!URL.revokeObjectURL) URL.revokeObjectURL = () => {};
