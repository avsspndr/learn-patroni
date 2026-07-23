const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticDir = path.resolve(__dirname, '../static');
const html = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(staticDir, 'app.js'), 'utf8');
const stand = fs.readFileSync(path.join(staticDir, 'stand.html'), 'utf8');

test('dashboard explains values while retaining original identifiers', () => {
  assert.match(html, /maximum_lag_on_failover/);
  assert.match(html, /receive lag/);
  assert.match(html, /replay lag/);
  assert.match(app, /patroni_postgres_streaming/);
  assert.match(app, /Линия времени WAL/);
});

test('dashboard does not overstate replica eligibility or cause of receive lag', () => {
  assert.doesNotMatch(html, /сетевое отставание/i);
  assert.doesNotMatch(app, /пригодна для переключения/i);
  assert.match(app, /отставание допускает участие в выборе/i);
  assert.match(html, /причина не обязательно в сети/i);
});

test('dashboard leads with architecture, routing purpose and replication direction', () => {
  assert.match(html, /Как устроен этот кластер прямо сейчас/);
  assert.match(html, /Зачем нужен HAProxy/i);
  assert.match(html, /Кто, от кого и зачем/i);
  assert.match(html, /Первичный сервер передаёт изменения реплике/i);
  assert.match(app, /renderArchitecture/);
  assert.match(app, /renderReplicationDirection/);
});

test('header gives a newcomer a safe learning route through course and live dashboard', () => {
  assert.match(html, /Patroni: курс и рабочий кластер/);
  assert.match(html, /Учебный курс/);
  assert.match(html, /Служба заявок/);
  assert.match(html, /Панель состояния/);
  assert.doesNotMatch(html, /Первый эксперимент/);
  assert.match(html, /просмотр состояния ничего не изменяет/);
  assert.match(html, /Состав и ограничения этого стенда/);
  assert.match(stand, /Docker создаёт воспроизводимое окружение/);
  assert.match(stand, /Он не является частью Patroni/);
  assert.match(app, /patroni-course-progress-v3/);
  assert.match(app, /модуль \$\{number\} из \$\{COURSE_MODULES\.length\}/);
  assert.match(app, /state\.examPassed/);
  assert.match(html + app, /индикатор подтверждает только получение свежих данных|нет свежих данных|Последний опрос/);
});

test('dashboard and stand connect cluster state with the business application', () => {
  assert.match(html, /Служба заявок/);
  assert.match(stand, /Служба заявок/);
  assert.match(stand, /изменения записывает на первичном сервере/);
  assert.match(stand, /Создайте прикладную нагрузку/);
});

test('replication view distinguishes current zero lag from a stale measurement', () => {
  assert.match(html, /data-lag-progress/);
  assert.match(app, /replication_lag/);
  assert.match(app, /За последний опрос/);
  assert.match(app, /За показанный период/);
  assert.match(app, /Нулевое отставание в этот момент является актуальным значением/);
  assert.match(app, /GET \/patroni/);
  assert.match(app, /GET \/cluster/);
});

test('health view uses explicit status classes and hides raw Prometheus dump', () => {
  assert.match(app, /friendly-metric \$\{state\}/);
  assert.match(app, /healthy/);
  assert.match(app, /unhealthy/);
  assert.doesNotMatch(html, /Исходные метрики Prometheus/);
  assert.doesNotMatch(html, /metrics-table/);
});

test('history explains retention and renders state, lag and event views', () => {
  assert.match(html, /с момента запуска панели/i);
  assert.match(html, /Доступность записи и смена лидера/);
  assert.match(html, /Полное отставание реплики во времени/);
  assert.match(html, /События сеанса/i);
  assert.match(app, /state_history/);
  assert.match(html, /Как использовать эту историю при расследовании/);
  assert.match(app, /реплика повышена без заданной точки восстановления/);
});

test('degraded nodes render a guided empty state without raw transport errors', () => {
  assert.match(html, /Узел не отвечает/);
  assert.match(app, /showUnavailable/);
  assert.match(app, /unavailableMessage/);
  assert.match(app, /Сетевое имя узла не разрешается/);
  assert.doesNotMatch(app, /error\.textContent = node\.error/);
});

test('primary replication card explains why it contains replica data', () => {
  assert.match(app, /показаны реплики, которые получают его WAL/);
  assert.match(app, /db2 означает/);
  assert.match(app, /входящее соединение репликации/);
});

test('DCS and automatic failover are explained in operational terms', () => {
  assert.match(html, /Что связывает Patroni и etcd/);
  assert.match(html, /Лидерская блокировка — временная запись/);
  assert.match(html, /Patroni должен регулярно продлевать её/);
  assert.match(html, /новое право сможет получить только один участник/);
  assert.match(html, /регулярно продлевать её/i);
  assert.match(html, /Блокировка не продлена/);
  assert.match(html, /Только затем повышается реплика/);
  assert.match(html, /Автоматическое переключение/);
  assert.doesNotMatch(html, /Режим управления Patroni/);
});

test('dashboard names the REST API sources used for cluster state', () => {
  assert.match(html, /GET \/api\/cluster/);
  assert.match(html, /\/patroni · \/read-write · \/read-only · \/metrics/);
  assert.match(html, /\/cluster · \/config · \/history/);
  assert.match(app, /node-api-sources/);
});

test('every quick diagnostic exposes its endpoint and field path', () => {
  assert.match(app, /GET \/patroni → \$\.role/);
  assert.match(app, /GET \/cluster → \$\.members\[\*\]\.role \+ \$\.members\[\*\]\.state/);
  assert.match(app, /GET \/config → \$\.maximum_lag_on_failover/);
  assert.match(app, /GET \/patroni → \$\.dcs_last_seen/);
  assert.match(app, /TCP localhost:5000/);
  assert.match(app, /diagnostic-source/);
});

test('etcd health is shown as operational signals and topology risk', () => {
  assert.match(html, /Способен ли DCS согласовывать решения Patroni/);
  assert.match(html, /v3\/cluster\/member\/list/);
  assert.match(app, /etcd_server_has_leader/);
  assert.match(app, /etcd_server_proposals_pending/);
  assert.match(app, /etcd_disk_wal_fsync_duration_seconds/);
  assert.match(app, /etcd_mvcc_db_total_size_in_bytes/);
  assert.match(app, /Состав DCS требует проверки/);
  assert.match(html, /Внутренний лидер Raft в etcd и первичный сервер PostgreSQL/);
});

test('single-node etcd is described once in the stand passport, not repeated as an incident', () => {
  assert.match(stand, /Один etcd позволяет изучать взаимодействие Patroni с DCS/);
  assert.match(app, /ограничения описаны в паспорте стенда/);
  assert.doesNotMatch(app, /намеренно упрощён|Почему здесь один узел|ожидаемая конфигурация, а не авария/);
  assert.doesNotMatch(html, /Почему здесь один узел|намеренно упрощён/);
  assert.match(app, /ETCD_SINGLE_NODE_INTENTIONAL|single_node_intentional/);
});

test('overall verdict separates write availability from lost redundancy', () => {
  assert.match(html, /diagnostic-summary/);
  assert.match(app, /writeAvailable/);
  assert.match(app, /запись доступна · отказоустойчивость снижена/);
  assert.match(app, /Запись продолжает работать через первичный сервер/);
  assert.match(app, /Доступной реплики сейчас нет/);
  assert.match(app, /запись недоступна/);
  assert.doesNotMatch(app, /кластер неработоспособен/);
});

test('DCS outage explains why local Patroni and read-only traffic may survive', () => {
  assert.match(html, /Почему Patroni и чтение при этом могут оставаться доступными/);
  assert.match(html, /Patroni и PostgreSQL продолжают работать на каждом узле самостоятельно/);
  assert.match(html, /запретить на нём запись/);
  assert.match(html, /без DCS она не может получить право стать новым первичным сервером/);
  assert.match(html, /не означает, что панель выполнила пробный SQL-запрос/);
  assert.match(app, /outage\.classList\.toggle\('hidden',etcdState\.coreHealthy\)/);
});

test('read-only and read-write eligibility is checked only through Patroni REST API', () => {
  assert.match(html, /Доступ по Patroni REST API/);
  assert.match(app, /GET \/read-write/);
  assert.match(app, /GET \/read-only/);
  assert.match(app, /Маршруты Patroni соответствуют ролям/);
  assert.match(app, /не результат SHOW transaction_read_only/);
  assert.doesNotMatch(app, /pg_is_in_recovery/);
  assert.doesNotMatch(app, /current_setting\('transaction_read_only'\)/);
});

test('operation verification remains visible and follows the acknowledgement', () => {
  assert.ok(html.indexOf('action-result') < html.indexOf('operation-tracker'));
  assert.match(app, /Этот результат останется видимым/);
  assert.doesNotMatch(app, /setTimeout\(\(\)=>\{activeOperation=null;tracker\.classList\.add\('hidden'\)/);
});

test('control workspace is organised by research intent with preflight and safe experiments', () => {
  assert.match(html, /ИССЛЕДОВАНИЕ И УПРАВЛЕНИЕ/);
  assert.match(html, /Готовность стенда/);
  assert.match(html, /Сменить первичный сервер/);
  assert.match(html, /Обслужить узел/);
  assert.match(html, /Провести эксперимент/);
  assert.match(html, /Панель не управляет Docker напрямую/);
  assert.match(html, /Журнал операций/);
  assert.match(app, /Нет реплики с работающим потоком WAL и допустимым отставанием/);
  assert.match(app, /operationLog/);
});

test('control operations teach their patronictl and REST equivalents', () => {
  assert.match(html, /Как учебные действия соотносятся с работой администратора/);
  assert.match(html, /Как выполнить плановое переключение/);
  assert.match(html, /Как выполнить перезапуск или перечитать конфигурацию/);
  assert.match(html, /Как включить и выключить режим обслуживания/);
  assert.match(stand, /TLS, разграничение доступа, хранение секретов/);
  assert.match(app, /patronictl -c \/etc\/patroni\/config\.yml switchover/);
  assert.match(app, /\/switchover -H 'Content-Type: application\/json'/);
  assert.match(app, /patronictl -c \/etc\/patroni\/config\.yml restart/);
  assert.match(app, /\/config -H 'Content-Type: application\/json'/);
});

test('pause is explained through purpose, behavior and risk', () => {
  assert.match(html, /Зачем нужен режим обслуживания \(pause\)/);
  assert.match(html, /обновлен.*(?:основной|major).*верс/i);
  assert.match(html, /не повышает реплику автоматически/);
  assert.match(html, /двух первичных серверах/);
  assert.match(html, /Не применяйте.*обычного перезапуска/s);
  assert.match(html, /Перейти в ручное обслуживание/);
  assert.match(html, /Возобновить автоматическое управление/);
});

test('architecture identifies the live replication mode and its consequence', () => {
  assert.match(html, /режим репликации/);
  assert.match(html, /Асинхронная репликация/);
  assert.match(app, /асинхронный кластер/);
  assert.match(app, /может подтвердить COMMIT, не дожидаясь/);
  assert.match(app, /Нулевое отставание сейчас не превращает режим в синхронный/);
  assert.match(app, /synchronous_mode_strict/);
});

test('failover policy explains fencing layers and the lab limitation', () => {
  assert.match(html, /Изоляция \(fencing\): не допустить запись на двух серверах/);
  assert.match(html, /возникнет раздвоение кластера/);
  assert.match(html, /Самоизоляция/);
  assert.match(html, /self-fencing/);
  assert.match(html, /Сторожевой таймер.*не настроен/i);
  assert.match(html, /HAProxy.*не остановит PostgreSQL/s);
  assert.match(html, /сначала гарантированно запретить запись на прежнем первичном сервере/);
});

test('visible prose avoids unexplained English operator jargon', () => {
  const prose = html.replace(/<code[\s\S]*?<\/code>/g, '');
  assert.doesNotMatch(prose, /production требует|change-процесс|endpoint’ы|Dashboard не получает Docker Socket|наблюдайте автоматическую проверку|1 etcd-нода намеренно/i);
  assert.doesNotMatch(app, /backend-нода|etcd сообщил unhealthy|кластер деградирован|резерв есть|деградирован|возобновление автоматики/i);
});
