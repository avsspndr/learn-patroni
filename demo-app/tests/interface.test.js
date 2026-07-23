const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'static/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'static/app.js'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'schema.sql'), 'utf8');

test('application separates the working board from the replica report', () => {
  assert.match(html, /HAPROXY:5000/);
  assert.match(html, /HAPROXY:5001/);
  assert.match(html, /Сводный отчёт/);
  assert.match(app, /\/api\/board/);
  assert.match(app, /\/api\/report/);
});

test('application teaches transaction and retry consequences through its workflow', () => {
  assert.match(html, /одной транзакцией/);
  assert.match(app, /pendingRequestKey/);
  assert.match(app, /Повторить тот же запрос/);
  assert.match(schema, /request_key uuid NOT NULL UNIQUE/);
  assert.match(schema, /transaction_id bigint NOT NULL DEFAULT txid_current\(\)/);
});

test('application keeps Patroni management outside the business client', () => {
  assert.doesNotMatch(app, /\/patroni|\/cluster|\/config|\/history/);
  assert.match(html, /Состояние Patroni и DCS смотрите в панели кластера/);
});
