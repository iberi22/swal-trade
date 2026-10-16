export const SITE_BASE = 'https://trade.swal.network';

export function buildAnalysisUrl(symbol: string): string {
  return `${SITE_BASE}/analisis/?symbol=${encodeURIComponent(symbol)}`;
}

export interface FooterLink {
  readonly label: string;
  readonly href: string;
}

export function buildFooterLinks(symbol: string): readonly FooterLink[] {
  return [
    { label: 'Análisis completo', href: buildAnalysisUrl(symbol) },
    { label: 'Guardián', href: `${SITE_BASE}/guardian/` },
    { label: 'Apoya SWAL', href: `${SITE_BASE}/apoyar/` },
    { label: 'Privacidad', href: `${SITE_BASE}/extension-privacy/` },
  ];
}
