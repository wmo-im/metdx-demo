import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// findBy* / waitFor return as soon as the condition holds, so this only bounds a *failing* wait. The 1 s
// default is tight for the MUI / OpenLayers pages when all test files run in parallel. Kept below
// `testTimeout` so a missing element reports the testing-library message, not a bare test timeout.
configure({ asyncUtilTimeout: 4_000 });

// jsdom lacks these; OpenLayers needs ResizeObserver.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

if (!URL.createObjectURL) URL.createObjectURL = () => 'blob:mock';
if (!URL.revokeObjectURL) URL.revokeObjectURL = () => {};
