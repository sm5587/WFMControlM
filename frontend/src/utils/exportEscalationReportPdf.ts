import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { formatDurationMins } from './formatDuration';

export type DateFmt = (iso: string | null | undefined, style?: 'full' | 'short' | 'time' | 'date') => string;

const INDIGO: [number, number, number] = [76, 110, 245];
const SLATE: [number, number, number] = [51, 65, 85];
const MUTED: [number, number, number] = [100, 116, 139];
const LINE: [number, number, number] = [226, 232, 240];
const RED: [number, number, number] = [220, 38, 38];
const AMBER: [number, number, number] = [217, 119, 6];
const GREEN: [number, number, number] = [22, 163, 74];

function reportFileStem(report: any): string {
  const label = String(report?.period?.label || report?.period?.startDate || 'report')
    .replace(/\s+/g, '-');
  return `escalation-report-${label}`;
}

function dash(v: unknown): string {
  if (v == null || v === '') return '-';
  return String(v);
}

function drawKpiRow(
  doc: jsPDF,
  y: number,
  items: { label: string; value: string; color?: [number, number, number] }[],
): number {
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  const gap = 3.5;
  const n = items.length;
  const boxW = (pageW - margin * 2 - gap * (n - 1)) / n;
  const boxH = 16;

  items.forEach((item, i) => {
    const x = margin + i * (boxW + gap);
    doc.setFillColor(248, 250, 252);
    doc.setDrawColor(...LINE);
    doc.setLineWidth(0.3);
    doc.roundedRect(x, y, boxW, boxH, 1.5, 1.5, 'FD');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...(item.color || SLATE));
    doc.text(item.value, x + boxW / 2, y + 7, { align: 'center' });

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(...MUTED);
    doc.text(item.label, x + boxW / 2, y + 12.5, { align: 'center', maxWidth: boxW - 3 });
  });

  return y + boxH + 5;
}

function drawChrome(doc: jsPDF, periodLabel: string) {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const page = doc.getCurrentPageInfo().pageNumber;
  const total = doc.getNumberOfPages();

  doc.setFillColor(...INDIGO);
  doc.rect(0, 0, pageW, 9, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text('WFM Escalation Report', 14, 6);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text(periodLabel, pageW - 14, 6, { align: 'right' });

  doc.setFillColor(...LINE);
  doc.rect(0, pageH - 10, pageW, 10, 'F');
  doc.setTextColor(...MUTED);
  doc.setFontSize(7);
  doc.text('WFM Control-M  ·  Internal', 14, pageH - 4);
  doc.text(`Page ${page} of ${total}`, pageW - 14, pageH - 4, { align: 'right' });
}

function lastTableY(doc: jsPDF, fallback: number): number {
  return (doc as any).lastAutoTable?.finalY ?? fallback;
}

export function exportReportPdf(
  report: any,
  fmt: DateFmt,
  extras: { filterLabel?: string; generatedAt: string },
) {
  const qs = report.queueBuildup?.summary || {};
  const ps = report.punchAlerts?.summary || {};
  const period = report.period || {};
  const periodLabel = period.label || 'Report';
  const dateRange = period.startDate && period.endDate
    ? `${period.startDate}  —  ${period.endDate}`
    : '';

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

  let y = 16;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(...SLATE);
  doc.text(periodLabel, 14, y);
  y += 5.5;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  const meta = [dateRange, extras.filterLabel, `Generated ${extras.generatedAt}`]
    .filter(Boolean)
    .join('   ·   ');
  doc.text(meta, 14, y);
  y += 8;

  // ---- Queue buildup ----
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...SLATE);
  doc.text('Critical Queue Buildup', 14, y);
  y += 4;

  y = drawKpiRow(doc, y, [
    { label: 'Total Escalations', value: String(qs.total ?? 0) },
    { label: 'Critical (>=10 stale)', value: String(qs.critical ?? 0), color: RED },
    { label: 'Clients Affected', value: String(qs.clientsAffected ?? 0) },
    { label: 'Resolved', value: String(qs.resolved ?? 0), color: GREEN },
    { label: 'Avg Duration', value: formatDurationMins(qs.avgDurationMins) || '-' },
    { label: 'Still Open', value: String(qs.open ?? 0), color: AMBER },
  ]);

  const byCluster = qs.byCluster && typeof qs.byCluster === 'object'
    ? Object.entries(qs.byCluster as Record<string, number>)
        .sort((a, b) => b[1] - a[1])
        .map(([cluster, count]) => `${cluster}: ${count}`)
        .join('   ')
    : '';
  if (byCluster) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...MUTED);
    doc.text(byCluster, 14, y);
    y += 5;
  }

  const queueRows = (report.queueBuildup?.rows || []) as any[];
  if (queueRows.length === 0) {
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    doc.text('No queue-buildup escalations in this period.', 14, y + 4);
    y += 12;
  } else {
    autoTable(doc, {
      startY: y,
      head: [['Client', 'Cluster', 'Stale', 'Severity', 'Status', 'First Seen', 'Resolved', 'Duration']],
      body: queueRows.map(r => [
        `${r.clientName || '-'}\n${r.serverCode || ''}`,
        dash(r.cluster),
        String(r.stalePendingCount ?? ''),
        dash(r.severity),
        dash(r.status),
        r.firstSeenAt ? fmt(r.firstSeenAt, 'full') : '-',
        r.resolvedAt ? fmt(r.resolvedAt, 'full') : '-',
        formatDurationMins(r.durationMins) || '-',
      ]),
      theme: 'striped',
      styles: { fontSize: 7, cellPadding: 1.6, valign: 'middle', textColor: SLATE, overflow: 'linebreak' },
      headStyles: {
        fillColor: INDIGO,
        textColor: 255,
        fontStyle: 'bold',
        fontSize: 7,
        cellPadding: 2,
      },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      columnStyles: {
        0: { cellWidth: 42 },
        1: { cellWidth: 28 },
        2: { halign: 'right', cellWidth: 16 },
        3: { cellWidth: 22 },
        4: { cellWidth: 26 },
        7: { halign: 'right', cellWidth: 20 },
      },
      margin: { left: 14, right: 14, top: 14, bottom: 14 },
      didParseCell: (data) => {
        if (data.section !== 'body') return;
        if (data.column.index === 3 && String(data.cell.raw) === 'CRITICAL') {
          data.cell.styles.textColor = RED;
          data.cell.styles.fontStyle = 'bold';
        }
        if (data.column.index === 4 && String(data.cell.raw) === 'OPEN') {
          data.cell.styles.textColor = RED;
          data.cell.styles.fontStyle = 'bold';
        }
        if (data.column.index === 2) {
          data.cell.styles.textColor = RED;
          data.cell.styles.fontStyle = 'bold';
        }
      },
    });
    y = lastTableY(doc, y) + 10;
  }

  const pageH = doc.internal.pageSize.getHeight();
  if (y > pageH - 48) {
    doc.addPage();
    y = 16;
  }

  // ---- Punch alerts ----
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...SLATE);
  doc.text('Unprocessed Punch Alerts', 14, y);
  y += 4;

  y = drawKpiRow(doc, y, [
    { label: 'Total Rows', value: String(ps.total ?? 0) },
    { label: 'Active Stale', value: String(ps.activeStale ?? 0), color: AMBER },
    { label: 'Acknowledged', value: String(ps.acknowledged ?? 0) },
    { label: 'Suppressed', value: String(ps.suppressed ?? 0) },
    { label: 'Notified', value: String(ps.notified ?? 0), color: INDIGO },
  ]);

  const punchRows = (report.punchAlerts?.rows || []) as any[];
  if (punchRows.length === 0) {
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    doc.text('No punch alert rows for this period.', 14, y + 4);
  } else {
    autoTable(doc, {
      startY: y,
      head: [['Client', 'Cluster', 'Punch Count', 'Stale Age', 'Activity', 'Status', 'Acknowledged', 'Suppressed Until', 'Email Sent']],
      body: punchRows.map(r => [
        `${r.clientName || '-'}\n${r.clientId || ''}`,
        dash(r.cluster),
        r.punchCount != null ? Number(r.punchCount).toLocaleString() : '-',
        formatDurationMins(r.staleAgeMins) || '-',
        (r.activities || []).join(', ') || '-',
        dash(r.status),
        r.acknowledgedAt ? `${r.acknowledgedBy || ''}\n${fmt(r.acknowledgedAt, 'full')}` : '-',
        r.suppressUntil ? fmt(r.suppressUntil, 'full') : '-',
        r.emailSentAt ? fmt(r.emailSentAt, 'full') : '-',
      ]),
      theme: 'striped',
      styles: { fontSize: 7, cellPadding: 1.6, valign: 'middle', textColor: SLATE, overflow: 'linebreak' },
      headStyles: {
        fillColor: [217, 119, 6],
        textColor: 255,
        fontStyle: 'bold',
        fontSize: 7,
        cellPadding: 2,
      },
      alternateRowStyles: { fillColor: [255, 251, 235] },
      columnStyles: {
        0: { cellWidth: 40 },
        1: { cellWidth: 26 },
        2: { halign: 'right', cellWidth: 24 },
        3: { halign: 'right', cellWidth: 20 },
      },
      margin: { left: 14, right: 14, top: 14, bottom: 14 },
      didParseCell: (data) => {
        if (data.section !== 'body') return;
        if (data.column.index === 5 && String(data.cell.raw) === 'OPEN') {
          data.cell.styles.textColor = RED;
          data.cell.styles.fontStyle = 'bold';
        }
      },
    });
  }

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    drawChrome(doc, periodLabel);
  }

  doc.save(`${reportFileStem(report)}.pdf`);
}

export function reportDownloadStem(report: any): string {
  return reportFileStem(report);
}
