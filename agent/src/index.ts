import 'dotenv/config';
import { crawl } from './crawler';
import { deduplicateCalls } from './parser';
import { inferDBMappings } from './inference';
import { writeJSON, writeExcel } from './output';
import { join } from 'path';

const TARGET_URL = process.argv[2];

if (!TARGET_URL) {
  console.error('Usage: ts-node src/index.ts <url>');
  console.error('Example: ts-node src/index.ts https://example.com');
  process.exit(1);
}

async function main(): Promise<void> {
  console.log('');
  console.log('QALens Agent v2.0');
  console.log('─────────────────────────────────');
  console.log(`Target : ${TARGET_URL}`);
  console.log(`Pages  : up to ${process.env['MAX_PAGES'] ?? 10}`);
  console.log(`AI     : ${process.env['ANTHROPIC_API_KEY'] ? 'Claude (cloud)' : process.env['OLLAMA_URL'] ? 'Ollama (local)' : 'disabled'}`);
  console.log('─────────────────────────────────');
  console.log('');

  const { calls, pagesVisited } = await crawl({
    url: TARGET_URL,
    maxPages:  Number(process.env['MAX_PAGES'])  || 10,
    timeoutMs: Number(process.env['TIMEOUT_MS']) || 30_000,
    headless:  process.env['HEADLESS'] !== 'false',
  });

  console.log(`\nCrawled ${pagesVisited.length} page(s), captured ${calls.length} API call(s)`);

  const unique = deduplicateCalls(calls);
  console.log(`${unique.length} unique endpoint(s) after deduplication`);

  if (process.env['ANTHROPIC_API_KEY'] || process.env['OLLAMA_URL']) {
    console.log('\nRunning AI schema inference...');
    for (const call of unique) {
      call.inferredDBTables = await inferDBMappings(call);
    }
    console.log('Inference complete');
  }

  const outputDir = process.env['OUTPUT_DIR'] ?? './output';
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  const jsonPath  = join(outputDir, `report-${ts}.json`);
  const xlsxPath  = join(outputDir, `report-${ts}.xlsx`);

  await writeJSON(unique, jsonPath);
  await writeExcel(unique, xlsxPath);

  console.log(`\nReports saved:`);
  console.log(`  JSON  → ${jsonPath}`);
  console.log(`  Excel → ${xlsxPath}`);
  console.log('');
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
