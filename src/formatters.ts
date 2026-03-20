export function formatCompactEur(value: number | null | undefined): string {
  if (!value) {
    return '-';
  }

  if (Math.abs(value) >= 1_000_000) {
    return `EUR ${(value / 1_000_000).toFixed(1)}M`;
  }

  return formatEur(value);
}

export function formatEur(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return '-';
  }

  return `EUR ${value.toLocaleString(undefined, {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })}`;
}

export function getDateOnly(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : '';
}

export function isPastDate(value: string | null | undefined): boolean {
  const dateOnly = getDateOnly(value);
  if (!dateOnly) {
    return false;
  }

  return dateOnly < getDateOnly(new Date().toISOString());
}

export function parseStringArray(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
