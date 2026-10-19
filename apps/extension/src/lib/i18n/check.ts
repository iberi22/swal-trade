/** Comprobación pura de catálogos. Su gemelo en Node es scripts/i18n-check.mjs. */

export interface CheckOptions {
  /** Las claves que faltan solo avisan (traducción en curso). */
  allowMissing?: boolean;
}

export interface LocaleReport {
  code: string;
  missing: string[];
  extra: string[];
  placeholderMismatch: string[];
  empty: string[];
  html: string[];
  invalid: string | null;
}

export interface CheckResult {
  ok: boolean;
  reports: LocaleReport[];
  errors: string[];
  warnings: string[];
}

export function placeholders(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\{([A-Za-z0-9_]+)\}/g)) found.add(m[1]!);
  return [...found].sort();
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** `files` mapea código a JSON ya parseado (o undefined si el archivo no existe). */
export function checkCatalogs(
  codes: readonly string[],
  files: Readonly<Record<string, unknown>>,
  source = 'es',
  options: CheckOptions = {},
): CheckResult {
  const reports: LocaleReport[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const src = files[source];
  const srcValid = isFlat(src);
  if (!srcValid) errors.push(`${source}: fuente ausente o no es JSON plano de strings`);
  const srcKeys = srcValid ? Object.keys(src as Record<string, string>) : [];

  for (const code of codes) {
    const report: LocaleReport = {
      code, missing: [], extra: [], placeholderMismatch: [], empty: [], html: [], invalid: null,
    };
    reports.push(report);
    const data = files[code];
    if (data === undefined) {
      report.invalid = 'archivo ausente';
    } else if (!isFlat(data)) {
      report.invalid = 'no es JSON plano de strings';
    }
    if (report.invalid) {
      errors.push(`${code}: ${report.invalid}`);
      continue;
    }
    if (!srcValid) continue;
    const cat = data as Record<string, string>;
    const s = src as Record<string, string>;
    report.missing = srcKeys.filter((k) => !(k in cat));
    report.extra = Object.keys(cat).filter((k) => !(k in s));
    for (const [key, value] of Object.entries(cat)) {
      if (value.trim() === '') report.empty.push(key);
      if (/[<>]/.test(value)) report.html.push(key);
      if (key in s && !sameSet(placeholders(value), placeholders(s[key]!))) {
        report.placeholderMismatch.push(key);
      }
    }
    for (const k of report.missing) {
      (options.allowMissing ? warnings : errors).push(`${code}: falta ${k}`);
    }
    for (const k of report.extra) errors.push(`${code}: sobra ${k}`);
    for (const k of report.placeholderMismatch) errors.push(`${code}: placeholders distintos en ${k}`);
    for (const k of report.empty) errors.push(`${code}: valor vacío en ${k}`);
    for (const k of report.html) errors.push(`${code}: HTML en ${k}`);
  }
  return { ok: errors.length === 0, reports, errors, warnings };
}

function isFlat(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string')
  );
}
