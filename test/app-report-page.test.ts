// A report is the template of its time with its two values filled in, saved in the run for good. When the app
// serves one it fills the current template with the values of the old file, so a run made before the template
// learned something (the boxes for choosing rows, a new look) still gets it. The file itself is not changed,
// and what is downloaded is that file. app/lib/report-page.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { OUT, ROOT } from './support/engine.js';
import { withServer } from './support/server.js';

const DATA = path.join(OUT, 'app-report-page-data');
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
process.env['DATABASE_DIFF_DATA'] = DATA;
process.env['DATABASE_DIFF_MCP_PROFILES'] = path.join(DATA, 'no-mcp-profiles');
const require = createRequire(import.meta.url);
const config = require('../app/lib/config.js') as { RUNS: string };

const TEMPLATE = readFileSync(path.join(ROOT, 'templates', 'report.html'), 'utf8');
const fill = (meta: string, data: string): string => TEMPLATE.replace(/__META_JSON__|__DATA_JSON__/g, (token) => (token === '__META_JSON__' ? meta : data));

// What an engine of an earlier day wrote: a page of its own, with the values where the template has its
// two placeholders. Values with what a replacement would mistake for something else, and with the names of
// the placeholders themselves, which must come out as they went in.
const META = '{"source":"srv / a","target":"srv / b","perspective":"sync","categories":["Table"],"note":"__DATA_JSON__ and $& and $1"}';
const ROWS = '[["Table","dbo.A","OnlyInSource","",null,null,["table","dbo.A"]],\n["Table","__META_JSON__ $`","OnlyInSource","$&",null,null,null]]';
const OLD_PAGE = `<!doctype html>\r\n<html lang="th">\r\n<body>OLD LOOK</body>\r\n<script>\r\nconst META = ${META};\r\nconst DATA = ${ROWS};\r\n\r\n// Everything that does not touch the page: the words of an earlier day\r\nfunction oldCore() {}\r\n</script>\r\n</html>\r\n`;

const RUN = '20261114-130001-c001';
const dir = path.join(config.RUNS, RUN);
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, 'run.json'), JSON.stringify({
  id: RUN, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(), status: 'done', ownerPid: 0,
  spec: { kind: 'compare', source: { serverLabel: 'a', database: 'a' }, target: { serverLabel: 'b', database: 'b' } },
}), 'utf8');
writeFileSync(path.join(dir, 'report.html'), OLD_PAGE, 'utf8');
// Not reports of this tool: a stub, and the index of a batch (it keeps its own values in INDEX).
writeFileSync(path.join(dir, 'stub.html'), '<!doctype html><title>report</title>', 'utf8');
const INDEX_PAGE = '<!doctype html><body>INDEX</body><script>\nconst INDEX = {"a":1};\n// Everything that does not touch the page\n</script>';
writeFileSync(path.join(dir, 'index.html'), INDEX_PAGE, 'utf8');

async function get(base: string, file: string, query = ''): Promise<{ status: number; type: string; text: string }> {
  const res = await fetch(`${base}/runs/${RUN}/${file}${query}`);
  return { status: res.status, type: res.headers.get('content-type') ?? '', text: await res.text() };
}

test('report page: an old report is served as the current template with its own values', async () => {
  await withServer(async (base) => {
    const page = await get(base, 'report.html');
    assert.equal(page.status, 200);
    assert.match(page.type, /^text\/html/);
    assert.equal(page.text, fill(META, ROWS));
    assert.doesNotMatch(page.text, /OLD LOOK/);
    // The new page has what the old one never had.
    assert.match(page.text, /id="pickdock"/);
    // The values came out as they went in: placeholders and replacement patterns inside them are data.
    assert.ok(page.text.includes('"note":"__DATA_JSON__ and $& and $1"'));
    assert.ok(page.text.includes('["Table","__META_JSON__ $`","OnlyInSource","$&",null,null,null]'));
  });
});

test('report page: the file in the run is not changed, and a download is that file', async () => {
  await withServer(async (base) => {
    const download = await get(base, 'report.html', '?download=1');
    assert.equal(download.status, 200);
    assert.equal(download.text, OLD_PAGE);
  });
  assert.equal(readFileSync(path.join(dir, 'report.html'), 'utf8'), OLD_PAGE);
});

test('report page: a page that is not a report, and the index of a batch, are sent as they are', async () => {
  await withServer(async (base) => {
    assert.equal((await get(base, 'stub.html')).text, '<!doctype html><title>report</title>');
    assert.equal((await get(base, 'index.html')).text, INDEX_PAGE);
    assert.equal((await get(base, 'nothing.html')).status, 404);
  });
});

test('report page: a report that is already current is the same after being served again', async () => {
  const current = fill(META, ROWS);
  writeFileSync(path.join(dir, 'again.html'), current, 'utf8');
  await withServer(async (base) => {
    assert.equal((await get(base, 'again.html')).text, current);
  });
});
