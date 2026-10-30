import { createTheme } from '@mui/material/styles';

/** Light, compact, blue theme in the spirit of ogcbrowser.rauhala.app. */
export const theme = createTheme({
  palette: {
    primary: { main: '#1565c0' },
    secondary: { main: '#f57c00' },
    background: { default: '#f5f7fa' },
  },
  shape: { borderRadius: 6 },
  typography: { fontSize: 13, fontFamily: 'Roboto, "Helvetica Neue", Arial, sans-serif' },
  components: {
    MuiTextField: { defaultProps: { size: 'small' } },
    MuiButton: { defaultProps: { size: 'small' }, styleOverrides: { root: { textTransform: 'none' } } },
  },
});
