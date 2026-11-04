import { MapController } from './mapController';
import { runMapConformance } from './mapApi.conformance';

runMapConformance('OpenLayers', () => new MapController());
