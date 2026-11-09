import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Layout } from './Layout';
import { MapProvider } from './MapContext';
import { RequestBarProvider } from './RequestBar';

function renderLayout() {
  return render(
    <MemoryRouter>
      <RequestBarProvider>
        <MapProvider>
          <Layout />
        </MapProvider>
      </RequestBarProvider>
    </MemoryRouter>,
  );
}

describe('Layout app bar', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('has a "Code on GitHub" link that opens in a new tab', () => {
    renderLayout();
    const link = screen.getByRole('link', { name: 'Code on GitHub' });
    expect(link).toHaveAttribute('href', 'https://github.com/wmo-im/metdx-demo');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('rel')).toContain('noreferrer');
  });

  it('has no map engine toggle unless Leaflet is enabled', () => {
    vi.stubEnv('VITE_ENABLE_LEAFLET', '');
    const { unmount } = renderLayout();
    expect(screen.queryByRole('group', { name: 'Map engine' })).toBeNull();
    unmount();

    vi.stubEnv('VITE_ENABLE_LEAFLET', '1');
    renderLayout();
    expect(screen.getByRole('group', { name: 'Map engine' })).toBeInTheDocument();
  });
});
