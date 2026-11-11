import { Autocomplete, TextField } from '@mui/material';

/** A typeable dropdown of the offered values (an `Autocomplete`: typing filters the list). */
export function PickField({
  label,
  value,
  options,
  onChange,
  flex,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  flex: number;
}) {
  return (
    <Autocomplete
      size="small"
      options={options}
      value={options.includes(value) ? value : null}
      onChange={(_, v) => v && onChange(v)}
      autoHighlight
      noOptionsText="No such time available"
      renderInput={(p) => <TextField {...p} label={label} />}
      sx={{ flex }}
    />
  );
}
