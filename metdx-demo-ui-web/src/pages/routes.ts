/**
 * Registry of page components. Each feature owns `src/pages/<feature>/index.tsx`
 * (default export = the page component); this file only maps routes to them.
 */
import type { ComponentType } from 'react';
import { ROUTES } from '../shell/routes';
import CataloguePage from './catalogue';
import RecordPage from './record';
import EdrPage from './edr';
import MapsPage from './maps';

export interface PageRoute {
  path: string;
  Component: ComponentType;
}

export const pageRoutes: PageRoute[] = [
  { path: ROUTES.catalogue, Component: CataloguePage },
  { path: ROUTES.record, Component: RecordPage },
  { path: ROUTES.edr, Component: EdrPage },
  { path: ROUTES.maps, Component: MapsPage },
];
