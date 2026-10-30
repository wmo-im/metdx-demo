import { useEffect, useRef, type ReactNode } from 'react';
import { Link as RouterLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Alert, Box, Button, Chip, CircularProgress, Divider, IconButton, Link, Stack, Tooltip, Typography } from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import BusinessIcon from '@mui/icons-material/Business';
import PolicyIcon from '@mui/icons-material/Policy';
import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import ShieldIcon from '@mui/icons-material/Shield';
import EmailIcon from '@mui/icons-material/Email';
import PhoneIcon from '@mui/icons-material/Phone';
import DatasetIcon from '@mui/icons-material/Dataset';
import MapIcon from '@mui/icons-material/Map';
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive';
import { recordMeta, useServices } from '../../lib/records';
import { paths, useMap, useRecord, type NavState } from '../../shell';

function MetaRow({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
      <Box sx={{ color: 'text.disabled', display: 'flex' }}>{icon}</Box>
      <Typography variant="caption" sx={{ fontWeight: 'bold', width: 90, flexShrink: 0 }} color="text.secondary">
        {label}:
      </Typography>
      <Typography variant="body2" sx={{ userSelect: 'text', wordBreak: 'break-word' }}>
        {value}
      </Typography>
    </Stack>
  );
}

/** Record metadata page with Data Access buttons (EDR / OGC Maps). */
export default function RecordPage() {
  const { id } = useParams<{ id: string }>();
  const { record, loading, error } = useRecord(id);
  const services = useServices(record);
  const navigate = useNavigate();
  const location = useLocation();
  const nav = (location.state as NavState | null) ?? {};
  const map = useMap();
  const mapRef = useRef(map);
  mapRef.current = map;

  useEffect(() => {
    mapRef.current.clear();
    return () => mapRef.current.clear();
  }, [id]);

  useEffect(() => {
    if (services?.extent) mapRef.current.showExtent(services.extent);
  }, [services]);

  if (loading) {
    return (
      <Box sx={{ p: 2 }} data-testid="page-record">
        <CircularProgress size={20} aria-label="Loading" />
      </Box>
    );
  }
  if (error || !record || !id) {
    return (
      <Box sx={{ p: 2 }} data-testid="page-record">
        <Alert severity="error" sx={{ mb: 1 }}>
          Could not load record: {error ?? 'not found'}
        </Alert>
        <Button component={RouterLink} to={paths.catalogue()} startIcon={<ArrowBackIcon />}>
          Catalogue
        </Button>
      </Box>
    );
  }

  const m = recordMeta(record);
  // Everything but `self` (the record's own URL).
  const links = (record.links ?? []).filter((l) => !!l.href && l.rel !== 'self');
  const recId = record.id;
  const checking = !services;
  const edrCol = services?.edrCollection;
  const mapsCol = services?.mapsCollection;

  return (
    <Box sx={{ p: 1.5 }} data-testid="page-record">
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', mb: 1 }}>
        <Tooltip title="Back to results">
          <IconButton
            size="small"
            aria-label="Back to results"
            // Opened from a search result: one step back is that search (query/page live in its URL).
            // Opened directly (or from anywhere else): go to the catalogue.
            onClick={() => (nav.from ? navigate(-1) : navigate(paths.catalogue()))}
          >
            <ArrowBackIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Typography variant="h6" component="h2" sx={{ fontSize: 16, lineHeight: 1.3 }}>
          {m.title}
        </Typography>
      </Stack>

      {m.keywords.length > 0 && (
        <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', rowGap: 0.5, mb: 1 }}>
          {m.keywords.map((k) => (
            <Chip key={k} size="small" label={k} sx={{ height: 20, fontSize: 10 }} />
          ))}
        </Stack>
      )}
      <Divider sx={{ my: 1 }} />
      <Typography variant="body2" data-testid="record-description">
        {m.description}
      </Typography>
      <Divider sx={{ my: 1 }} />

      <Stack spacing={0.75} data-testid="record-metadata">
        <MetaRow icon={<BusinessIcon fontSize="inherit" />} label="Organization" value={m.organization} />
        <MetaRow icon={<PolicyIcon fontSize="inherit" />} label="License" value={m.license} />
        <MetaRow icon={<CalendarTodayIcon fontSize="inherit" />} label="Created" value={m.created} />
        <MetaRow icon={<ShieldIcon fontSize="inherit" />} label="Data Policy" value={m.dataPolicy} />
        <MetaRow icon={<EmailIcon fontSize="inherit" />} label="Email" value={m.email} />
        {m.phone && <MetaRow icon={<PhoneIcon fontSize="inherit" />} label="Phone" value={m.phone} />}
      </Stack>
      <Divider sx={{ my: 1 }} />

      {links.length > 0 && (
        <>
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
            Links
          </Typography>
          <Stack component="ul" spacing={0.5} sx={{ m: 0, pl: 2.5 }} data-testid="record-links">
            {links.map((l, i) => (
              <Typography component="li" variant="body2" key={`${l.rel}-${l.href}-${i}`} sx={{ wordBreak: 'break-word' }}>
                <Link href={l.href} target="_blank" rel="noopener noreferrer">
                  {l.title || l.href}
                </Link>
                {l.rel && (
                  <Chip size="small" label={l.rel} sx={{ ml: 0.75, height: 18, fontSize: 10 }} data-testid="record-link-rel" />
                )}
              </Typography>
            ))}
          </Stack>
          <Divider sx={{ my: 1 }} />
        </>
      )}

      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        Data Access
      </Typography>
      <Stack direction="row" spacing={1}>
        {edrCol ? (
          <Tooltip title="Query this EDR collection on a map">
            <Button
              variant="contained"
              color="primary"
              startIcon={<DatasetIcon />}
              aria-label="EDR"
              component={RouterLink}
              to={paths.edr(recId, edrCol)}
              state={{ ...nav, viaRecord: true } satisfies NavState}
            >
              EDR
            </Button>
          </Tooltip>
        ) : (
          <Tooltip title={checking ? 'Checking for EDR support...' : 'EDR not available for this collection'}>
            <span>
              <Button variant="contained" disabled aria-label="EDR" startIcon={<DatasetIcon />}>
                EDR
              </Button>
            </span>
          </Tooltip>
        )}
        {mapsCol ? (
          <Tooltip title="View OGC Maps for this collection">
            <Button
              variant="contained"
              color="success"
              startIcon={<MapIcon />}
              aria-label="OGC Maps"
              component={RouterLink}
              to={paths.maps(recId, mapsCol)}
              state={{ ...nav, viaRecord: true } satisfies NavState}
            >
              OGC Maps
            </Button>
          </Tooltip>
        ) : (
          <Tooltip title={checking ? 'Checking for OGC Maps support...' : 'OGC Maps not available for this collection'}>
            <span>
              <Button variant="contained" disabled aria-label="OGC Maps" startIcon={<MapIcon />}>
                OGC Maps
              </Button>
            </span>
          </Tooltip>
        )}
      </Stack>
      {services && services.queryTypes.length > 0 && (
        <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', rowGap: 0.5, mt: 1, alignItems: 'center' }} data-testid="query-types">
          <Typography variant="caption" color="text.secondary">
            Query types:
          </Typography>
          {services.queryTypes.map((qt) => (
            <Chip key={qt} size="small" color="primary" label={qt} sx={{ height: 20, fontSize: 10 }} />
          ))}
        </Stack>
      )}

      {m.channel !== undefined && (
        <>
          <Divider sx={{ my: 1 }} />
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }} data-testid="subscribe">
            <NotificationsActiveIcon fontSize="small" sx={{ color: 'warning.dark' }} />
            <Box>
              <Typography variant="body2">Subscribe (AMQP/MQTT)</Typography>
              <Typography variant="caption" color="text.secondary">
                Channel: {m.channel}
              </Typography>
            </Box>
          </Stack>
        </>
      )}
    </Box>
  );
}
