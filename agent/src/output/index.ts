import ExcelJS from 'exceljs';
import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { CapturedAPICall } from '@qalens/shared/types';

export async function writeJSON(calls: CapturedAPICall[], outputPath: string): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(calls, null, 2), 'utf-8');
}

export async function writeExcel(calls: CapturedAPICall[], outputPath: string): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'QALens Agent v2';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('API Map');

  sheet.columns = [
    { header: 'UI Page',           key: 'page',       width: 45 },
    { header: 'Method',            key: 'method',     width: 10 },
    { header: 'Endpoint',          key: 'endpoint',   width: 55 },
    { header: 'Status',            key: 'status',     width: 10 },
    { header: 'Request Payload',   key: 'request',    width: 40 },
    { header: 'Response Fields',   key: 'fields',     width: 50 },
    { header: 'Inferred DB Table', key: 'tables',     width: 35 },
    { header: 'Confidence',        key: 'confidence', width: 15 },
  ];

  // Header row style
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
  headerRow.alignment = { vertical: 'middle' };

  for (const call of calls) {
    let endpoint = call.url;
    try {
      const u = new URL(call.url);
      endpoint = u.pathname + (u.search || '');
    } catch {
      // keep full URL
    }

    const responseFields = call.responseSchema?.properties
      ? Object.keys(call.responseSchema.properties).join(', ')
      : '';

    const tables = call.inferredDBTables
      ?.map((t) => t.inferredTable)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(', ') ?? '';

    const confidence = call.inferredDBTables?.[0]?.confidence ?? '';

    const row = sheet.addRow({
      page:       call.uiContext?.pageUrl ?? '',
      method:     call.method,
      endpoint,
      status:     call.responseStatus,
      request:    call.requestPayload ? JSON.stringify(call.requestPayload).slice(0, 200) : '',
      fields:     responseFields,
      tables,
      confidence,
    });

    // Colour-code status
    const statusCell = row.getCell('status');
    if (call.responseStatus >= 500) {
      statusCell.font = { color: { argb: 'FFCC0000' }, bold: true };
    } else if (call.responseStatus >= 400) {
      statusCell.font = { color: { argb: 'FFCC6600' }, bold: true };
    } else if (call.responseStatus >= 200 && call.responseStatus < 300) {
      statusCell.font = { color: { argb: 'FF006600' } };
    }
  }

  // Freeze header row
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  await workbook.xlsx.writeFile(outputPath);
}
