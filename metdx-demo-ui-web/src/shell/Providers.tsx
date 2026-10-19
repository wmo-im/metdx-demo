import type { ReactNode } from 'react';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { theme } from '../theme';
import { MapProvider } from './MapContext';
import { RequestBarProvider } from './RequestBar';

/** Theme + map + request-bar contexts. Router is provided by the caller. */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <MapProvider>
        <RequestBarProvider>{children}</RequestBarProvider>
      </MapProvider>
    </ThemeProvider>
  );
}
