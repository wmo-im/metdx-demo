import { AppBar, Box, Chip, IconButton, Toolbar, Tooltip, Typography } from '@mui/material';
import PublicIcon from '@mui/icons-material/Public';
import HomeIcon from '@mui/icons-material/Home';
import { Link as RouterLink, Outlet } from 'react-router-dom';
import { MapView } from './MapContext';
import { RequestBar, ResultDialog } from './RequestBar';
import { isMockMode } from '../lib/mockFetch';
import { paths } from './routes';

export const SIDEBAR_WIDTH = 400;

/** App bar + left sidebar (routed page) + OpenLayers map + bottom request bar. */
export function Layout() {
  return (
    <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column', bgcolor: 'background.default' }}>
      <AppBar position="static" elevation={1}>
        <Toolbar variant="dense" sx={{ gap: 1 }}>
          <PublicIcon />
          <Typography variant="h6" component="h1" sx={{ flexGrow: 1, fontSize: 18 }}>
            MetDX Demo
          </Typography>
          {isMockMode() && <Chip size="small" color="secondary" label="mock data" />}
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
