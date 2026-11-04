import { vi } from 'vitest';

// jsdom has no SVGSVGElement.createSVGRect, so Leaflet would pick its canvas renderer; define it before Leaflet loads.
vi.hoisted(() => {
  const proto = SVGSVGElement.prototype as unknown as { createSVGRect?: () => object };
  proto.createSVGRect ??= () => ({});
});

// The lazy leaflet-coverage chunk, held back until `gate.open()`.
const gate = vi.hoisted(() => {
  const g = { open: () => {}, promise: Promise.resolve() };
  g.promise = new Promise<void>((resolve) => (g.open = resolve));
  return g;
});
vi.mock('./coverage/render', async (importOriginal) => {
  await gate.promise;
  return importOriginal();
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LeafletController } from './controller';
import { parseCoverageJson } from '../../lib/covjson';
import livePosition from '../../../test/fixtures/edr/live-position.json';

describe('leaflet-coverage render cancellation (delayed lazy chunk)', () => {
  let c: LeafletController;
  let el: HTMLDivElement;
  const layer = parseCoverageJson(livePosition);
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);

  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    c = new LeafletController();
    el = document.createElement('div');
    el.style.width = '400px';
    el.style.height = '300px';
    document.body.appendChild(el);
    c.attach(el);
    process.on('unhandledRejection', onUnhandled);
    process.on('uncaughtException', onUnhandled);
  });
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    process.off('uncaughtException', onUnhandled);
    c.detach();
    el.remove();
    vi.restoreAllMocks();
  });

  it('detaching (an engine switch) while the chunk loads: the render ends quietly and adds nothing', async () => {
    const shown = c.showCoverage!(layer, layer.parameters[0].key, 0);
    c.detach(); // what EngineHost does on a switch, before the chunk arrives
    gate.open();
    await expect(shown).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 50));
    expect(unhandled).toEqual([]);
    expect(document.querySelectorAll('.leaflet-overlay-pane path, .leaflet-overlay-pane canvas')).toHaveLength(0);
  });

  it('clearCoverage / a newer showData cancel a render in flight; the map is still usable', async () => {
    gate.open();
    const first = c.showCoverage!(layer, layer.parameters[0].key, 0);
    c.clearCoverage(); // cancelled before it finished
    await expect(first).resolves.toBeUndefined();
    expect(el.querySelectorAll('.leaflet-overlay-pane path')).toHaveLength(0);

    await c.showCoverage!(layer, layer.parameters[0].key, 0);
    expect(el.querySelectorAll('.leaflet-overlay-pane path').length).toBeGreaterThan(0);
    c.clearCoverage();
    expect(el.querySelectorAll('.leaflet-overlay-pane path')).toHaveLength(0);
  });
});
