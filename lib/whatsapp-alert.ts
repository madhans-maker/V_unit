import { Package } from '@/types';
import { toDate } from '@/lib/firestore-dates';

function formatFieldDate(value: unknown): string | null {
  const date = toDate(value);
  if (!date) return null;
  return date.toLocaleDateString('en-IN', { dateStyle: 'medium' });
}

function getEtaDate(pkg: Package, stageData?: Record<string, unknown>): string {
  const candidates = [
    stageData?.arrivalDate,
    stageData?.approxArrivalDate,
    stageData?.expectedArrival,
    pkg.timeline?.eta?.arrivalDate,
    pkg.timeline?.eta?.approxArrivalDate,
    pkg.timeline?.etdEta?.expectedArrival,
  ];

  for (const value of candidates) {
    const formatted = formatFieldDate(value);
    if (formatted) return formatted;
  }

  return '-';
}

export function buildWhatsAppAlertMessage(
  pkg: Package,
  _stageKey: string,
  stageData: Record<string, unknown>
): string {
  const lines = [
    `Vendor: ${pkg.vendorName || '-'}`,
    `Package Type: ${pkg.packageType || '-'}`,
    `CTN: ${pkg.packageCount ?? '-'}`,
    `Weight: ${
      pkg.weight != null ? `${pkg.weight} ${pkg.weightType || 'KG'}` : '-'
    }`,
    `CBM: ${pkg.cbm ?? '-'}`,
    `ETA Date: ${getEtaDate(pkg, stageData)}`,
  ];

  return lines.join('\n');
}
