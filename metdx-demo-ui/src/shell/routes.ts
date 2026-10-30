/** Route table + path builders. Record ids contain ':' and '/' so they are encoded. */
export const ROUTES = {
  catalogue: '/',
  record: '/record/:id',
  edr: '/record/:id/edr',
  maps: '/record/:id/maps',
} as const;

/** Query-string key carrying the collection URL for the EDR/Maps pages. */
export const COLLECTION_PARAM = 'col';

function withCol(path: string, col?: string): string {
  return col ? `${path}?${COLLECTION_PARAM}=${encodeURIComponent(col)}` : path;
}

export const paths = {
  catalogue: (): string => '/',
  record: (id: string): string => `/record/${encodeURIComponent(id)}`,
  edr: (id: string, col?: string): string => withCol(`/record/${encodeURIComponent(id)}/edr`, col),
  maps: (id: string, col?: string): string => withCol(`/record/${encodeURIComponent(id)}/maps`, col),
};

/**
 * Router state used for "Back" navigation (it survives reloads, being kept in the history entry).
 * - `from`: the catalogue search (`/?q=..&offset=..`) the record was opened from; set on record pages only.
 * - `viaRecord`: this page (EDR / Maps) was opened from the record page, which is then one history step back.
 */
export interface NavState {
  from?: string;
  viaRecord?: boolean;
}
