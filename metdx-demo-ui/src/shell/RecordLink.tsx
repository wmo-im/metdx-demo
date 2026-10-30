import { Button } from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { useLocation, useNavigate } from 'react-router-dom';
import { paths, type NavState } from './routes';

/**
 * "Record" button of the EDR / Maps pages. When the page was opened from the record, going back one step lands
 * on it with its own history (so the record's Back still returns to the search); otherwise it opens the record.
 */
export function RecordLink({ recordId }: { recordId: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const nav = (location.state as NavState | null) ?? {};
  return (
    <Button
      size="small"
      startIcon={<ArrowBackIcon />}
      href={paths.record(recordId)}
      onClick={(e) => {
        e.preventDefault();
        if (nav.viaRecord) navigate(-1);
        else navigate(paths.record(recordId), { state: nav.from ? ({ from: nav.from } satisfies NavState) : undefined });
      }}
    >
      Record
    </Button>
  );
}
