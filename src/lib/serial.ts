// Serial-number lookup rules. Lookup is deliberately exact-match: a provider
// typing serials must never be able to browse other people's inventory, so
// there is no prefix or fuzzy search, and short strings aren't searchable at
// all (a 1-3 character "serial" is a scan, not a lookup).

export const normalizeSerial = (s: string) => s.trim().toLowerCase();

export const MIN_SERIAL_LOOKUP = 4;

export const serialSearchable = (s: string) => normalizeSerial(s).length >= MIN_SERIAL_LOOKUP;
