import * as XLSX from 'xlsx';
import { Package } from '@/types';
import { getPackageStatusLabel, getPackageTotalAmount } from '@/lib/package-status';

function formatDate(value?: Date): string {
  if (!value || Number.isNaN(value.getTime())) return '';
  return value.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function getEtaDate(pkg: Package): Date | undefined {
  return (
    pkg.timeline?.eta?.arrivalDate ||
    pkg.timeline?.eta?.approxArrivalDate ||
    pkg.timeline?.etdEta?.expectedArrival
  );
}

export function exportPackagesToExcel(packages: Package[], filenamePrefix = 'packages') {
  const rows = packages.map((pkg, index) => ({
    '#': index + 1,
    'Package Name': pkg.name || '',
    Description: pkg.description || '',
    Vendor: pkg.vendorName || pkg.vendorCode || '',
    'Vendor Mobile': pkg.vendorMobile || '',
    'BL No': pkg.blNo || '',
    'Container No': pkg.containerNo || '',
    'Package Type': pkg.packageType || '',
    Qty: pkg.packageCount ?? '',
    Weight: pkg.weight ?? '',
    'Weight Type': pkg.weightType || '',
    CBM: pkg.cbm ?? '',
    'Amount Per CBM': pkg.amountPerCbm ?? '',
    'Other Expenses': pkg.otherExpenses ?? '',
    'Transport Expenses': pkg.transportExpenses ?? '',
    'Total Amount': getPackageTotalAmount(pkg) ?? '',
    'ETA Date': formatDate(getEtaDate(pkg)),
    Status: getPackageStatusLabel(pkg),
    'Delivery Address': pkg.vendorDeliveryAddress || '',
    'Billing Address': pkg.vendorBillingAddress || '',
    'Created At': formatDate(pkg.createdAt),
    'Created By': pkg.createdBy || '',
    'Updated At': formatDate(pkg.updatedAt),
    'Updated By': pkg.updatedBy || '',
  }));

  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Packages');

  const colWidths = Object.keys(rows[0] || { A: '' }).map((key) => ({
    wch: Math.min(
      40,
      Math.max(
        key.length + 2,
        ...rows.map((row) => String((row as Record<string, unknown>)[key] ?? '').length + 2)
      )
    ),
  }));
  worksheet['!cols'] = colWidths;

  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(workbook, `${filenamePrefix}-${stamp}.xlsx`);
}
