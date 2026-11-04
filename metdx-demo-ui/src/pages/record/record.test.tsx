import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { MapController } from '../../shell/mapController';
import { MapProvider } from '../../shell/MapContext';
import { setFetchImpl } from '../../lib/http';
import { createMockFetch } from '../../lib/mockFetch';
import RecordPage from './index';

const REC = 'urn:wmo:md:int-ecmwf:weather.prediction.forecast.global';

let ctrl: MapController;

beforeEach(() => {
  setFetchImpl(createMockFetch());
  ctrl = new MapController();
});
afterEach(() => {
  setFetchImpl(null);
  vi.restoreAllMocks();
});

describe('RecordPage map', () => {
  it("zooms the map to the record's footprint and one level out (showExtent with fit)", async () => {
    const showExtent = vi.spyOn(ctrl, 'showExtent');
    render(
      <MemoryRouter initialEntries={[`/record/${encodeURIComponent(REC)}`]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <MapProvider controller={ctrl}>
          <Routes>
            <Route path="/record/:id" element={<RecordPage />} />
          </Routes>
        </MapProvider>
      </MemoryRouter>,
    );
    await screen.findByRole('link', { name: 'EDR' });
    await waitFor(() => expect(showExtent).toHaveBeenCalledWith(expect.any(Array), { fit: true, padLevels: 1 }));
    const bbox = showExtent.mock.calls.find((c) => c[0])![0]!;
    expect(bbox).toHaveLength(4);
  });
});
