import { AppBar, Box, Chip, IconButton, ToggleButton, ToggleButtonGroup, Toolbar, Tooltip, Typography } from '@mui/material';
import PublicIcon from '@mui/icons-material/Public';
import HomeIcon from '@mui/icons-material/Home';
import GitHubIcon from '@mui/icons-material/GitHub';
import { Link as RouterLink, Outlet } from 'react-router-dom';
import { MapView, useMapEngine } from './MapContext';
import { ENGINE_LABELS, leafletEnabled } from './engine';
import type { MapEngineName } from './mapApi';
import { RequestBar, ResultDialog } from './RequestBar';
import { isMockMode } from '../lib/mockFetch';
import { paths } from './routes';

export const SIDEBAR_WIDTH = 400;

export const GITHUB_URL = 'https://github.com/wmo-im/metdx-demo';

const ENGINES: MapEngineName[] = ['ol', 'leaflet'];

/** Map engine toggle of the app bar (hidden when the engine is fixed, e.g. injected in tests). */
function EngineToggle() {
  const engine = useMapEngine();
  if (!leafletEnabled() || !engine) return null;
  return (
    <ToggleButtonGroup
      size="small"
      exclusive
      value={engine.name}
      onChange={(_, v: MapEngineName | null) => v && engine.switchEngine(v)}
      aria-label="Map engine"
      sx={{
        '& .MuiToggleButton-root': { color: 'inherit', borderColor: 'rgba(255,255,255,0.5)', py: 0, px: 1, fontSize: 12, textTransform: 'none' },
        '& .Mui-selected': { bgcolor: 'rgba(255,255,255,0.25) !important' },
      }}
    >
      {ENGINES.map((n) => (
        <ToggleButton key={n} value={n} aria-label={`${ENGINE_LABELS[n]} map`}>
          {ENGINE_LABELS[n]}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

/** App bar + left sidebar (routed page) + map (OpenLayers or Leaflet) + bottom request bar. */
export function Layout() {
  return (
    <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column', bgcolor: 'background.default' }}>
      <AppBar position="static" elevation={1}>
        <Toolbar variant="dense" sx={{ gap: 1 }}>
          <PublicIcon />
          <Typography variant="h6" component="h1" sx={{ flexGrow: 1, fontSize: 18 }}>
            MetDX Demo
          </Typography>
          <EngineToggle />
          {isMockMode() && <Chip size="small" color="secondary" label="mock data" />}
          <Tooltip title="Code on GitHub">
            <IconButton
              color="inherit"
              component="a"
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Code on GitHub"
            >
              <GitHubIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title="Catalogue">
            <IconButton color="inherit" component={RouterLink} to={paths.catalogue()} aria-label="Catalogue">
              <HomeIcon />
            </IconButton>
          </Tooltip>
        </Toolbar>
      </AppBar>
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: { xs: 'column', md: 'row' } }}>
        <Box
          component="aside"
          sx={{
            width: { xs: '100%', md: SIDEBAR_WIDTH },
            flexShrink: 0,
            maxHeight: { xs: '45%', md: 'none' },
            overflowY: 'auto',
            borderRight: { md: 1 },
            borderBottom: { xs: 1, md: 0 },
            borderColor: 'divider',
            bgcolor: 'background.paper',
          }}
        >
          <Outlet />
        </Box>
        <Box component="main" sx={{ flex: 1, position: 'relative', minHeight: 200 }}>
          <MapView />
        </Box>
      </Box>
      <RequestBar />
      <ResultDialog />
    </Box>
  );
}
