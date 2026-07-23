const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../static');
const readJson = relativePath => JSON.parse(fs.readFileSync(path.join(staticRoot, relativePath), 'utf8'));
const manifest = readJson('course/course-manifest.json');
const course = {
  ...manifest,
  glossary: readJson('course/glossary.json'),
  modules: manifest.modules.map(module => readJson(module.source.replace(/^\//, ''))),
};
const courseApp = fs.readFileSync(path.resolve(__dirname, '../static/course.js'), 'utf8');
const courseCss = fs.readFileSync(path.resolve(__dirname, '../static/course.css'), 'utf8');
test('manifest points to independent, versioned module documents', () => {
  assert.equal(manifest.glossary, '/course/glossary.json');
  assert.equal(manifest.modules.length, 7);
  for (const descriptor of manifest.modules) {
    assert.match(descriptor.source, /^\/course\/modules\/\d{2}-[a-z0-9-]+\.json$/);
    assert.ok(Number.isInteger(descriptor.revision) && descriptor.revision > 0);
    const module = course.modules.find(item => item.id === descriptor.id);
    assert.equal(module.revision, descriptor.revision, `${descriptor.id}: revision`);
    assert.equal(module.title, descriptor.title, `${descriptor.id}: title`);
    assert.equal(module.duration, descriptor.duration, `${descriptor.id}: duration`);
  }
  assert.doesNotMatch(courseApp, /window\.PATRONI_COURSE/);
  assert.match(courseApp, /fetch\('\/course\/course-manifest\.json'/);
});

test('course has six theory modules and one final practical exam', () => {
  assert.equal(course.version, 3);
  assert.equal(course.modules.length, 7);
  assert.deepEqual(course.modules.map(module => module.number), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(new Set(course.modules.map(module => module.id)).size, 7);

  for (const module of course.modules) {
    assert.ok(module.sections.length >= 3, `${module.id}: theory sections`);
    assert.ok(module.outcomes.length >= 3, `${module.id}: outcomes`);
    assert.ok(module.docs.length >= 2, `${module.id}: documentation links`);
  }
  assert.ok(course.modules.slice(0, 6).every(module => Array.isArray(module.quiz) && !module.lab));
  assert.ok(course.modules.slice(0, 6).every(module => !module.exam));
  assert.equal(course.modules[6].kind, 'practical-exam');
  assert.ok(course.modules[6].exam.stages.length >= 5);
});

test('modules three through six follow the patronictl operator workflow', () => {
  const [observation, operations, configuration, recovery] = course.modules.slice(2);
  assert.match(observation.title, /состояние кластера.*patronictl/i);
  assert.match(JSON.stringify(observation), /patronictl list --extended/);
  assert.match(JSON.stringify(observation), /patronictl topology/);
  assert.match(JSON.stringify(observation), /patronictl history/);
  assert.match(operations.title, /Управление кластером через patronictl/);
  assert.match(JSON.stringify(operations), /patronictl.*switchover/);
  assert.match(JSON.stringify(operations), /patronictl.*failover/);
  assert.match(JSON.stringify(operations), /patronictl.*reinit/);
  assert.match(JSON.stringify(configuration), /patronictl show-config/);
  assert.match(JSON.stringify(configuration), /patronictl edit-config/);
  assert.match(JSON.stringify(recovery), /patronictl.*failover/);
  assert.match(JSON.stringify(recovery), /pg_rewind/);
  assert.match(JSON.stringify(observation), /REST API используют сам Patroni, patronictl, балансировщики, системы мониторинга и внешняя автоматизация/);
  assert.match(courseApp, /function renderPracticalExam/);
});

test('management module covers the administrator operation lifecycle', () => {
  const module = course.modules[3];
  const text = JSON.stringify(module);
  for (const concept of [
    /Плановое переключение \(switchover\)/,
    /Аварийное переключение \(failover\)/,
    /Перечитывание настроек и перезапуск PostgreSQL/,
    /Режим обслуживания временно ограничивает действия Patroni/,
    /Повторное создание реплики \(reinit\)/,
    /Новая реплика добавляется запуском нового Patroni/,
    /У patronictl нет команды add replica/,
    /Не используйте patronictl remove для удаления одного участника/,
  ]) assert.match(text, concept);
});

test('configuration module explains sources, precedence and application', () => {
  const module = course.modules[4];
  const titles = module.sections.map(section => section.title);
  assert.deepEqual(titles.slice(0, 4), [
    'Начнём с конфигурации небольшого кластера',
    'Что происходит при первоначальном запуске',
    'После запуска конфигурация хранится в нескольких местах',
    'Локальная конфигурация описывает один узел',
  ]);
  const text = JSON.stringify(module);
  for (const concept of [
    /Динамическая конфигурация хранится в DCS/,
    /Локальная конфигурация сообщает каждому участнику/,
    /переменные с префиксом PATRONI_/,
    /bootstrap\.dcs служит исходным набором общих настроек/i,
    /patroni\.dynamic\.json/,
    /называется effective configuration/,
    /Pending restart/,
    /patroni --generate-sample-config/,
    /Сокращённый patroni\.yml для первого узла/,
    /db2 создаёт реплику/,
  ]) assert.match(text, concept);
  assert.match(courseApp, /data-source/);
  assert.match(courseApp, /data-action/);
});

test('module three explains the state model before diagnostic commands', () => {
  const module = course.modules[2];
  const titles = module.sections.map(section => section.title);
  assert.deepEqual(titles.slice(0, 7), [
    'Состояние кластера нельзя выразить одним словом',
    'Исправное, ухудшенное и переходное состояния',
    'Участник имеет роль, состояние и несколько каналов доступности',
    'Состояние DCS оценивается отдельно',
    'REST API связывает Patroni с другими компонентами',
    'Какие пути REST API нужны для диагностики',
    'patronictl — клиент DCS и REST API',
  ]);
  assert.ok(titles.indexOf('patronictl list читают как последовательность проверок') > titles.indexOf('REST API связывает Patroni с другими компонентами'));
  const text = JSON.stringify(module);
  for (const concept of [
    /доступность записи, чтения, резервирования и автоматического управления/,
    /Role и State/,
    /кворум/,
    /GET \/primary/,
    /GET \/patroni/,
    /patronictl list --extended --timestamp/,
    /patronictl version/,
    /patronictl dsn/,
  ]) assert.match(text, concept);
  assert.doesNotMatch(text, /docker compose exec db1 patronictl/);
  assert.match(courseApp, /диагностическую карточку/i);
  assert.match(courseApp, /clusterData\.etcd\?\.reachable/);
  assert.match(courseApp, /redundancyAvailable/);
});

test('learning path introduces the mental model before Patroni internals', () => {
  const first = course.modules[0];
  const second = course.modules[1];
  const firstText = JSON.stringify(first);
  const secondText = JSON.stringify(second);

  assert.match(firstText, /резервн.*коп/i);
  assert.match(firstText, /Write-Ahead Log/);
  assert.match(firstText, /основн.*сервер/i);
  assert.match(firstText, /реплик/i);
  assert.match(secondText, /Patroni/);
  assert.match(secondText, /leader race/);
  assert.match(secondText, /HAProxy/);
});

test('module one builds from COMMIT guarantees to replication trade-offs', () => {
  const module = course.modules[0];
  const titles = module.sections.map(section => section.title);
  assert.deepEqual(titles, [
    'Транзакция: изменения, фиксация и долговечность',
    'Как WAL помогает пережить сбой одного сервера',
    'Зачем нужна реплика и почему её недостаточно',
    'Как создаётся физическая потоковая реплика',
    'Когда первичный сервер может подтвердить COMMIT',
    'Что произойдёт с последней транзакцией при отказе первичного сервера',
    'Как читать LSN и отставание',
    'Зачем нужен слот репликации',
    'Итог: путь транзакции от клиента до реплики',
  ]);
  const text = JSON.stringify(module);
  for (const concept of [
    /атомарностью — Atomicity/,
    /долговечностью — Durability/,
    /физической — physical replication/,
    /логическую репликацию/,
    /Асинхронный · asynchronous/,
    /Синхронный · synchronous/,
  ]) assert.match(text, concept);
  assert.doesNotMatch(text, /archive shipping|synchronous_standby_names|synchronous_mode/);
  assert.match(text, /A ≤ B ≤ C/);
  assert.match(text, /C−B ещё не доставлено/);
  assert.match(text, /B−A уже доставлено/);
  assert.match(text, /Реплика при этом не является резервной копией/);
  assert.match(courseApp, /querySelectorAll\('\.open-glossary'\)/);
  assert.match(courseApp, /status\.xlog\?\.received_location/);
  assert.match(courseApp, /status\.xlog\?\.replayed_location/);
  assert.match(module.sections.at(-1).body.join(' '), /Patroni, DCS/);
  assert.ok(module.quiz.length >= 6);
});

test('module two follows one failure from loss of db1 through recovery', () => {
  const module = course.modules[1];
  const titles = module.sections.map(section => section.title);
  assert.deepEqual(titles, [
    'Исходная ситуация: db1 не отвечает, но db2 ещё не стала первичным сервером',
    'Компоненты кластера решают разные части одной задачи',
    'До отказа: лидер подтверждает своё право в каждом цикле Patroni',
    'После отказа: от истечения блокировки до повышения db2',
    'Изоляция должна остановить прежний первичный сервер',
    'После повышения начинается новая ветвь WAL',
    'Слой маршрутизации помогает приложению найти новый первичный сервер',
    'Что происходит, когда db1 снова запускают',
    'Что Patroni не решает самостоятельно',
    'Промежуточный итог: от репликации к отказоустойчивому кластеру',
  ]);
  const text = JSON.stringify(module);
  assert.match(text, /db1 перестаёт отвечать/);
  assert.match(text, /Право на лидерство получают раньше повышения/);
  assert.match(text, /HAProxy.*новые подключения/);
  assert.match(text, /pg_rewind.*общей точке истории/);
  assert.match(text, /одно неделимое действие/);
  assert.match(text, /watchdog.*принудительно/);
  assert.match(text, /идентификатор ветви истории WAL/);
  assert.match(text, /db2 не получила T4/);
  assert.match(text, /не возвращают в маршрут записи/);
  assert.match(text, /Оператор устраняет причину отказа, проверяет состояние db1/);
  assert.match(text, /Последняя подтверждённая на db1 транзакция могла не попасть на db2/);
  assert.match(text, /Keepalived\/VRRP/);
  assert.match(text, /HAProxy.*не является обязательной частью Patroni/);
  assert.doesNotMatch(JSON.stringify(module.quiz), /loop_wait \+ 2/);
  assert.ok((text.match(/maximum_lag_on_failover/g) || []).length <= 2, 'implementation parameter must not dominate the conceptual story');
});

test('progress is based on theory tests and the final practical exam', () => {
  assert.match(courseApp, /saved\.moduleRevisions/);
  assert.match(courseApp, /delete result\.quizPassed\[module\.id\]/);
  assert.match(courseApp, /delete result\.examPassed\[module\.id\]/);
  assert.match(courseApp, /module\.kind === 'practical-exam'/);
  assert.match(courseApp, /state\.examPassed\[module\.id\] = true/);
});

test('course diagrams support more than four stages without creating an implicit second row', () => {
  assert.match(courseCss, /\.concept-flow \{ display: flex/);
  assert.match(courseCss, /\.concept-stage \{[^}]*flex: 1 1 0/);
  assert.doesNotMatch(courseCss, /grid-template-columns: 1fr auto 1fr auto 1fr auto 1fr/);
});

test('important Russian explanations retain searchable original terminology', () => {
  const allText = JSON.stringify(course);
  for (const term of ['primary', 'replica', 'streaming', 'promotion', 'timeline', 'leader lock', 'HA loop', 'switchover', 'failover']) {
    assert.match(allText, new RegExp(term, 'i'), `missing original term: ${term}`);
  }
});

test('every quiz answer points to an existing option', () => {
  for (const module of course.modules.slice(0, 6)) {
    assert.ok(module.quiz.length >= 3, `${module.id}: enough retrieval practice`);
    for (const question of module.quiz) {
      assert.ok(Number.isInteger(question.answer));
      assert.ok(question.answer >= 0 && question.answer < question.options.length, `${module.id}/${question.id}`);
      assert.ok(question.explanation.length > 20, `${module.id}/${question.id}: corrective feedback`);
    }
  }
});

test('documentation bridge links only to official project docs', () => {
  const allowedHosts = new Set(['www.postgresql.org', 'patroni.readthedocs.io', 'etcd.io', 'www.haproxy.com', 'github.com']);
  for (const module of course.modules) {
    for (const doc of module.docs) {
      const url = new URL(doc.url);
      assert.equal(url.protocol, 'https:');
      assert.ok(allowedHosts.has(url.hostname), doc.url);
    }
  }
});

test('glossary terms are unique and course avoids the obsolete master role', () => {
  const terms = course.glossary.map(([term]) => term.toLowerCase());
  assert.equal(new Set(terms).size, terms.length);
  assert.doesNotMatch(JSON.stringify(course.modules), /\bmaster\b/i);
});

test('explanatory prose does not fall back to avoidable English jargon', () => {
  const prose = [];
  for (const module of course.modules) {
    prose.push(module.title, module.shortTitle, module.lead, ...module.outcomes);
    for (const section of module.sections) {
      prose.push(section.title, ...(section.body || []), ...(section.points || []));
      if (section.callout) prose.push(section.callout.title, section.callout.text);
      if (section.table) prose.push(...section.table.headers, ...section.table.rows.flat());
      if (section.diagram) prose.push(...section.diagram.flat());
    }
    for (const doc of module.docs) prose.push(doc.label, doc.purpose);
    for (const question of module.quiz || []) prose.push(question.question, ...question.options, question.explanation);
    if (module.exam) {
      prose.push(module.exam.title, module.exam.objective, module.exam.conditions, ...module.exam.acceptance);
      for (const stage of module.exam.stages) prose.push(stage.title, stage.task, ...stage.criteria, ...(stage.evidence || []));
    }
  }
  const text = prose.join('\n');
  assert.doesNotMatch(text, /\b(dashboard|endpoint|baseline|pre-flight|healthy|candidate|production|role-aware|write-capable)\b/i);
  assert.doesNotMatch(text, /\b(деградирован|автоматика|здоровая реплика|выполнить failover|режим pause)\b/i);
});
