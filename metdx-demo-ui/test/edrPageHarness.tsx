// Shared harness of the EDR page tests (src/pages/edr/index*.test.tsx, split into files so vitest runs them in parallel).
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import EdrPage from '../src/pages/edr/index';
import { MapProvider, RequestBar, RequestBarProvider, ResultDialog } from '../src/shell';
import { MapController } from '../src/shell/mapController';
import { setFetchImpl, type FetchImpl } from '../src/lib/http';
import { createMockFetch, type MockFetch } from '../src/lib/mockFetch';
import type { DrawKind, Geometry } from '../src/lib/types';
import type { DataLayer, DataSelectHandler, ShowDataOptions } from '../src/lib/covjsonTypes';
export const COL = 'https://polytope-edr.lumi.apps.dte.destination-earth.eu/collections/operational-data';
/** Default datetime of every mode but position: a single time, the first step of the collection extent. */
export const DT = '2026-10-19T00:00:00Z';
/** Default datetime of position (a time series): the first step + 1 day. */
export const DT_POS = `${DT}/2026-10-20T00:00:00Z`;
export const DT_RANGE = '2026-10-19T00:00:00Z/2026-10-29T00:00:00Z';

export class StubMap extends MapController {
  next: Geometry = { type: 'Point', coordinates: [10, 50] };
  kinds: DrawKind[] = [];
  shown: (Geometry | null)[] = [];
  drawGeometry(kind: DrawKind): Promise<Geometry> {
    this.kinds.push(kind);
    return Promise.resolve(this.next);
  }
  showGeometry(g: Geometry | null): void {
    this.shown.push(g);
    super.showGeometry(g);
  }
  // Data drawing is recorded, not rendered (jsdom has no canvas / WebGL).
  drawn: DataLayer[] = [];
  drawnOpts: ShowDataOptions[] = [];
  dataClears = 0;
  showData(layer: DataLayer, opts: ShowDataOptions): void {
    this.drawn.push(layer);
    this.drawnOpts.push(opts);
  }
  clearData(): void {
    this.dataClears++;
  }
  selectCb: DataSelectHandler | null = null;
  onDataSelect(cb: DataSelectHandler): () => void {
    this.selectCb = cb;
    return () => {
      if (this.selectCb === cb) this.selectCb = null;
    };
  }
}

export let mock: MockFetch;
export let map: StubMap;

function LeaveButton() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/elsewhere')}>leave page</button>;
}

export function renderPage(col: string | null = COL, fetchImpl?: FetchImpl) {
  mock = createMockFetch();
  setFetchImpl(fetchImpl ?? mock);
  map = new StubMap();
  const search = col ? `?col=${encodeURIComponent(col)}` : '';
  return render(
    <MemoryRouter
      initialEntries={[`/record/abc/edr${search}`]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <MapProvider controller={map}>
        <RequestBarProvider>
          <Routes>
            <Route path="/record/:id/edr" element={<EdrPage />} />
            <Route path="*" element={<div>elsewhere</div>} />
          </Routes>
          <LeaveButton />
          <RequestBar />
          <ResultDialog />
        </RequestBarProvider>
      </MapProvider>
    </MemoryRouter>,
  );
}

export const urlBox = () => screen.getByLabelText('Request URL') as HTMLInputElement;
export const fetchBtn = () => screen.getByRole('button', { name: /fetch/i });
export const ready = () => screen.findByRole('button', { name: 'position' });
export const queryCalls = () => mock.calls.filter((c) => /\/(position|area|trajectory|radius|cube|corridor)\?/.test(c));
