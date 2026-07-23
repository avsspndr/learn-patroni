const nodeTemplate = document.querySelector('#node-template');
const replicationTemplate = document.querySelector('#replication-template');
const metricsTemplate = document.querySelector('#metrics-template');
const nodesContainer = document.querySelector('#nodes');
const replicationContainer = document.querySelector('#replication-cards');
const metricsContainer = document.querySelector('#metrics-cards');
const errorBox = document.querySelector('#error');
let latestData = null;
let refreshInFlight = false;
let activeOperation = null;
let operationLog = JSON.parse(sessionStorage.getItem('operationLog') || '[]');

const COURSE_MODULES = ['postgres-replication','ha-architecture','patroni-concepts','cluster-operations','patroni-configuration','incident-recovery','practical-exam'];

function renderCourseEntryPoint() {
  const link=document.querySelector('#course-progress-link');
  if(!link)return;
  let state={};
  try{state=JSON.parse(localStorage.getItem('patroni-course-progress-v3')||'{}');}catch(_){state={};}
  const complete=id=>id==='practical-exam'?state.examPassed?.[id]:state.quizPassed?.[id];
  const completed=COURSE_MODULES.filter(complete).length;
  const firstIncomplete=COURSE_MODULES.find(id=>!complete(id));
  const active=COURSE_MODULES.includes(state.activeModule)?state.activeModule:firstIncomplete||COURSE_MODULES[0];
  const number=COURSE_MODULES.indexOf(active)+1;
  link.href=`/course.html?module=${encodeURIComponent(active)}`;
  link.querySelector('[data-course-action]').textContent=completed?'Продолжить обучение':'Начать обучение';
  link.querySelector('[data-course-progress]').textContent=completed===COURSE_MODULES.length?`все ${COURSE_MODULES.length} модулей пройдены`:`модуль ${number} из ${COURSE_MODULES.length} · пройдено ${completed}`;
}

renderCourseEntryPoint();

const openPanels = new Set(JSON.parse(sessionStorage.getItem('openPanels') || '[]'));

function text(root, field, value) {
  const target = root.querySelector(`[data-field="${field}"]`);
  if (target) target.textContent = value ?? '—';
}

function formatBytes(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const bytes = Number(value);
  if (bytes === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const index = Math.max(0, Math.min(Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)), units.length - 1));
  return `${(bytes / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || seconds < 0) return '—';
  const value = Math.floor(seconds);
  if (value >= 86400) return `${Math.floor(value / 86400)} д ${Math.floor(value % 86400 / 3600)} ч`;
  if (value >= 3600) return `${Math.floor(value / 3600)} ч ${Math.floor(value % 3600 / 60)} мин`;
  if (value >= 60) return `${Math.floor(value / 60)} мин ${value % 60} с`;
  return `${value} с`;
}

function formatLsn(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string' && value.includes('/')) return value;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '—';
  const numeric = BigInt(Math.max(0, parsed));
  return `${(numeric >> 32n).toString(16).toUpperCase()}/${(numeric & 0xFFFFFFFFn).toString(16).toUpperCase()}`;
}

function postgresVersion(raw) {
  if (!raw) return '—';
  const value = String(raw).padStart(6, '0');
  const major = Number(value.slice(0, -4));
  return major >= 10 ? `${major}.${Number(value.slice(-4))}` : `${major}.${Number(value.slice(-4, -2))}.${Number(value.slice(-2))}`;
}

function metricValue(metrics, name) {
  const entry = Object.entries(metrics || {}).find(([key]) => key === name || key.startsWith(`${name}{`));
  return entry ? entry[1] : null;
}

function etcdSnapshot(etcd = {}) {
  const metric=name=>metricValue(etcd.metrics || {},name);
  const members=etcd.members?.length || 0; const quorum=members ? Math.floor(members/2)+1 : 0;
  const pending=metric('etcd_server_proposals_pending'); const failed=metric('etcd_server_proposals_failed_total'); const hasLeader=metric('etcd_server_has_leader');
  const fsyncCount=metric('etcd_disk_wal_fsync_duration_seconds_count'); const fsyncSum=metric('etcd_disk_wal_fsync_duration_seconds_sum');
  const commitCount=metric('etcd_disk_backend_commit_duration_seconds_count'); const commitSum=metric('etcd_disk_backend_commit_duration_seconds_sum');
  const fsyncAverage=fsyncCount ? fsyncSum/fsyncCount : null; const commitAverage=commitCount ? commitSum/commitCount : null;
  const dbSize=metric('etcd_mvcc_db_total_size_in_bytes'); const quota=metric('etcd_server_quota_backend_bytes'); const storageRatio=quota ? dbSize/quota : null;
  const intentionalSingle=Boolean(etcd.single_node_intentional&&etcd.expected_members===1&&members===1);
  const coreHealthy=Boolean(etcd.reachable&&etcd.health&&hasLeader===1&&pending===0);
  const warning=(!intentionalSingle&&members<3)||(failed??0)>0||[fsyncAverage,commitAverage].some(value=>value!==null&&value>=.05)||(storageRatio!==null&&storageRatio>=.7);
  return {members,quorum,pending,failed,hasLeader,fsyncAverage,commitAverage,dbSize,quota,storageRatio,intentionalSingle,coreHealthy,warning};
}

const NODE_STATES_RU = {
  running: 'работает', streaming: 'потоковая репликация', starting: 'запускается', stopped: 'остановлен',
  creating_replica: 'создаётся реплика', restarting: 'перезапускается', crashed: 'аварийно завершён', unknown: 'неизвестно',
};
const POSTGRES_STATES_RU = {0:'инициализация', 1:'ошибка initdb', 2:'пользовательская начальная инициализация', 3:'ошибка начальной инициализации', 4:'создание реплики', 5:'работает', 6:'запускается', 8:'ошибка запуска', 9:'перезапускается', 11:'останавливается', 12:'остановлен', 14:'аварийно завершён'};
const ACTION_LABELS_RU = {
  reload: 'перечитывание конфигурации',
  postgres_restart: 'перезапуск PostgreSQL',
  pause: 'приостановка автоматического управления',
  resume: 'возобновление автоматического управления',
  switchover: 'плановое переключение',
};
const nodeStateRu = state => state ? `${NODE_STATES_RU[state] || state} (${state})` : '—';
const nodeRoleRu = role => ['leader', 'primary', 'master'].includes(role) ? 'первичный сервер' : role === 'replica' ? 'реплика' : role || 'роль не определена';
const isPrimary = role => ['leader', 'primary', 'master'].includes(role);
const memberFor = (cluster, name) => (cluster?.topology?.members || []).find(member => member.name === name) || {};

function decorateNode(card, node) {
  const role = node.status?.role;
  card.dataset.node = node.name;
  card.querySelector('.node-name').textContent = node.name;
  const badge = card.querySelector('.role');
  if (!node.reachable) {
    card.classList.add('offline');
    badge.classList.add('unavailable');
    badge.textContent = '× НЕДОСТУПЕН';
    return;
  }
  card.classList.add(isPrimary(role) ? 'primary-node' : 'replica-node');
  badge.textContent = isPrimary(role) ? 'ОСНОВНОЙ · PRIMARY · ЗАПИСЬ' : 'РЕПЛИКА · REPLICA';
  badge.classList.toggle('replica', !isPrimary(role));
}

function unavailableMessage(error) {
  const value=String(error||'').toLowerCase();
  if(value.includes('name does not resolve')||value.includes('temporary failure in name resolution'))return 'Сетевое имя узла не разрешается. Контейнер может быть остановлен или отсутствовать в сети.';
  if(value.includes('connection refused'))return 'Соединение отклонено. Узел доступен по сети, но Patroni REST API не принимает подключения.';
  if(value.includes('timed out')||value.includes('timeout'))return 'Узел не ответил до истечения времени ожидания.';
  return 'Patroni REST API узла недоступен. Причину уточняйте по состоянию контейнера, сети и журналам Patroni.';
}

function showUnavailable(card,node) {
  const panel=card.querySelector('[data-panel="unavailable"]');
  if(panel){panel.classList.remove('hidden');panel.querySelector('p').textContent=unavailableMessage(node.error);}
  card.querySelector('.key-metrics')?.classList.add('hidden');
  card.querySelector('.replication-block')?.classList.add('hidden');
  card.querySelector('.replica-lag')?.classList.add('hidden');
  card.querySelector('.friendly-metrics-grid')?.classList.add('hidden');
  card.querySelector('.node-error')?.classList.add('hidden');
}

function addAlert(container, label, kind = 'warning') {
  const badge = document.createElement('span');
  badge.className = `alert-badge ${kind}`;
  badge.textContent = label;
  container.append(badge);
}

function renderAlerts(root, status, metrics) {
  const container = root.querySelector('.alerts');
  container.replaceChildren();
  if (status.pending_restart || metricValue(metrics, 'patroni_pending_restart') === 1) addAlert(container, 'требуется перезапуск');
  if (status.pause || metricValue(metrics, 'patroni_is_paused') === 1) addAlert(container, 'автоматическое управление приостановлено');
  if (status.cluster_unlocked || metricValue(metrics, 'patroni_cluster_unlocked') === 1) addAlert(container, 'нет лидерской блокировки DCS', 'danger');
  if ((status.xlog || {}).paused || metricValue(metrics, 'patroni_xlog_paused') === 1) addAlert(container, 'воспроизведение WAL приостановлено', 'danger');
  if (status.watchdog_failed) addAlert(container, 'ошибка сторожевого таймера', 'danger');
  container.classList.toggle('hidden', !container.children.length);
}

function renderNode(node) {
  const card = nodeTemplate.content.firstElementChild.cloneNode(true);
  decorateNode(card, node);
  if (!node.reachable) {
    showUnavailable(card,node);
    return card;
  }
  const status = node.status;
  const routes=node.patroni_routes || {}; const readWrite=routes.read_write?.available; const readOnly=routes.read_only?.available;
  const modeTarget=card.querySelector('[data-field="sql-mode"]');
  const modeKnown=routes.read_write?.status!==undefined&&routes.read_only?.status!==undefined;
  const modeMatches=!modeKnown?null:isPrimary(status.role)?readWrite:status.role==='replica'?!readWrite&&readOnly:null;
  modeTarget.textContent=!modeKnown?'не удалось проверить':readWrite?'чтение и запись · /read-write 200':readOnly?'только чтение · /read-only 200':'маршруты недоступны';
  modeTarget.className=`sql-mode ${modeMatches===null?'unknown':modeMatches?'healthy':'unhealthy'}`;
  text(card, 'state', nodeStateRu(status.state));
  text(card, 'timeline', status.timeline);
  text(card, 'version', postgresVersion(status.server_version));
  text(card, 'patroni-version', status.patroni?.version);
  text(card, 'dcs-age', status.dcs_last_seen ? `${formatDuration(Date.now()/1000 - status.dcs_last_seen)} назад` : '—');
  text(card, 'uptime', status.postmaster_start_time ? formatDuration(Date.now()/1000 - Date.parse(status.postmaster_start_time)/1000) : '—');
  text(card, 'wal', formatLsn(status.xlog?.location ?? status.xlog?.replayed_location ?? status.xlog?.received_location));
  renderAlerts(card, status, node.metrics || {});
  return card;
}

function renderReplication(root, status, member, data, nodeName) {
  const container = root.querySelector('.replication-list');
  const peers = status.replication || [];
  const primaryName=data.summary?.leaders?.[0]||'неизвестного первичного сервера';
  const heading=root.querySelector('[data-replication-heading]');
  const context=root.querySelector('[data-replication-context]');
  if(isPrimary(status.role)){
    heading.textContent=`Реплики, подключённые к ${nodeName}`;
    context.textContent=`На карточке первичного сервера показаны реплики, которые получают его WAL. Строка db2 означает, что db2 подключена к ${nodeName}, получает его изменения и поддерживает копию базы для возможного переключения.`;
  } else {
    heading.textContent=`Как ${nodeName} получает WAL от ${primaryName}`;
    context.textContent=`Здесь показано входящее соединение репликации: источник ${primaryName} создаёт WAL, а ${nodeName} получает и применяет его.`;
  }
  container.replaceChildren();
  if (!peers.length) {
    const row = document.createElement('div');
    row.className = 'empty';
    row.textContent = status.role === 'replica'
      ? `Реплика получает WAL · состояние ${status.replication_state || 'неизвестно'} · отставание ${formatBytes(member.replay_lag ?? member.lag)}`
      : 'Подключённых реплик в ответе /patroni нет';
    container.append(row);
    return;
  }
  peers.forEach(peer => {
    const row = document.createElement('div');
    row.className = 'replica-row';
    row.innerHTML = `<div><strong></strong><small></small></div><span></span>`;
    row.querySelector('strong').textContent = peer.application_name || peer.client_addr || 'реплика';
    row.querySelector('small').textContent = peer.client_addr || '';
    const syncState = {async: 'асинхронная', sync: 'синхронная', quorum: 'участник кворума', potential: 'возможная синхронная'}[peer.sync_state] || 'не определён';
    row.querySelector('span').textContent = `${nodeStateRu(peer.state)} · режим ${syncState} (sync_state=${peer.sync_state || '—'}) · приоритет ${peer.sync_priority ?? 0}`;
    container.append(row);
  });
}

function renderLagChart(root, samples) {
  const chart = root.querySelector('.lag-chart');
  const values = (samples || []).map(sample => Number(sample.replay_lag)).filter(Number.isFinite);
  if (!values.length) { chart.classList.add('hidden'); return; }
  chart.classList.remove('hidden');
  const actualMaximum = Math.max(...values);
  const scaleMaximum = Math.max(actualMaximum, 1);
  const points = values.map((value, index) => `${values.length === 1 ? 0 : index * 600 / (values.length - 1)},${112 - value / scaleMaximum * 100}`).join(' ');
  chart.querySelector('polyline').setAttribute('points', points);
  chart.querySelector('.chart-caption').textContent = `Последние ${values.length} опросов · максимум ${formatBytes(actualMaximum)} · сейчас ${formatBytes(values.at(-1))}`;
}

function renderLagProgress(panel, current, samples) {
  const progress = panel.querySelector('[data-lag-progress]');
  const sampled = panel.querySelector('[data-lag-sampled]');
  const history = samples || [];
  const previous = history.length > 1 ? history.at(-2) : null;
  const oldest = history.length > 1 ? history[0] : null;
  if (!previous || !current) {
    progress.textContent = 'Накопление истории началось; изменение позиций появится после следующего опроса.';
  } else {
    const primaryAdvance = Math.max(Number(current.primary_lsn ?? 0) - Number(previous.primary_lsn ?? current.primary_lsn ?? 0), 0);
    const receiveAdvance = Math.max(Number(current.received_lsn ?? 0) - Number(previous.received_lsn ?? current.received_lsn ?? 0), 0);
    const replayAdvance = Math.max(Number(current.replayed_lsn ?? 0) - Number(previous.replayed_lsn ?? current.replayed_lsn ?? 0), 0);
    const windowPrimaryAdvance = Math.max(Number(current.primary_lsn ?? 0) - Number(oldest.primary_lsn ?? current.primary_lsn ?? 0), 0);
    const windowReceiveAdvance = Math.max(Number(current.received_lsn ?? 0) - Number(oldest.received_lsn ?? current.received_lsn ?? 0), 0);
    const windowReplayAdvance = Math.max(Number(current.replayed_lsn ?? 0) - Number(oldest.replayed_lsn ?? current.replayed_lsn ?? 0), 0);
    if (primaryAdvance || receiveAdvance || replayAdvance) {
      progress.textContent = `За последний опрос: primary +${formatBytes(primaryAdvance)}, получено +${formatBytes(receiveAdvance)}, применено +${formatBytes(replayAdvance)}.`;
    } else if (windowPrimaryAdvance || windowReceiveAdvance || windowReplayAdvance) {
      progress.textContent = `С прошлого опроса WAL не изменился. За показанный период: primary +${formatBytes(windowPrimaryAdvance)}, получено +${formatBytes(windowReceiveAdvance)}, применено +${formatBytes(windowReplayAdvance)}.`;
    } else {
      progress.textContent = 'С прошлого опроса позиции WAL не изменились. Нулевое отставание в этот момент является актуальным значением.';
    }
  }
  sampled.textContent = current?.timestamp
    ? `Измерено ${new Date(current.timestamp*1000).toLocaleTimeString()} · GET /patroni и GET /cluster`
    : 'Время измерения неизвестно';
}

function renderReplicaLag(root, status, member, primaryStatus, config, lagSnapshot, lagSamples) {
  if (status.role !== 'replica') return;
  const panel = root.querySelector('.replica-lag');
  panel.classList.remove('hidden');
  const primary = Number(lagSnapshot?.primary_lsn ?? primaryStatus?.xlog?.location);
  const received = Number(lagSnapshot?.received_lsn ?? status.xlog?.received_location);
  const replayed = Number(lagSnapshot?.replayed_lsn ?? status.xlog?.replayed_location);
  const receiveLag = lagSnapshot?.receive_lag ?? member.receive_lag ?? (Number.isFinite(primary) && Number.isFinite(received) ? Math.max(primary-received, 0) : null);
  const replayLag = lagSnapshot?.replay_lag ?? member.replay_lag ?? member.lag ?? (Number.isFinite(primary) && Number.isFinite(replayed) ? Math.max(primary-replayed, 0) : null);
  const applyLag = lagSnapshot?.apply_lag ?? (Number.isFinite(received) && Number.isFinite(replayed) ? Math.max(received-replayed, 0) : null);
  const threshold = config?.maximum_lag_on_failover ?? 1048576;
  const replicationState = lagSnapshot?.replication_state || status.replication_state;
  const lagAllowsCandidacy = replicationState === 'streaming' && replayLag !== null && replayLag <= threshold;
  panel.querySelector('[data-lsn="primary"]').textContent = formatLsn(primary);
  panel.querySelector('[data-lsn="received"]').textContent = formatLsn(received);
  panel.querySelector('[data-lsn="replayed"]').textContent = formatLsn(replayed);
  [['receive',receiveLag], ['apply',applyLag], ['replay',replayLag], ['threshold',threshold]].forEach(([key,value]) => panel.querySelector(`[data-lag="${key}"]`).textContent = formatBytes(value));
  [['receive',receiveLag], ['apply',applyLag], ['replay',replayLag]].forEach(([key,value]) => panel.querySelector(`.${key} .meter i`).style.width = `${Math.min(100, Number(value || 0)/Math.max(threshold,1)*100)}%`);
  const state = panel.querySelector('.lag-state');
  state.textContent = lagAllowsCandidacy ? 'отставание допускает участие в выборе' : replicationState === 'streaming' ? 'отставание превышает допустимый предел' : 'поток WAL не активен';
  state.className = `lag-state ${lagAllowsCandidacy ? 'eligible' : 'ineligible'}`;
  panel.querySelector('.lag-verdict').textContent = replayLag === 0 ? 'Измеренные позиции WAL совпадают' : `Реплика отстаёт от первичного сервера на ${formatBytes(replayLag)}`;
  renderLagProgress(panel, lagSnapshot, lagSamples);
}

function renderReplicationCard(node, data, primaryStatus) {
  const card = replicationTemplate.content.firstElementChild.cloneNode(true);
  decorateNode(card, node);
  if (!node.reachable) { showUnavailable(card,node); return card; }
  const member = memberFor(data.cluster, node.name);
  const lagSamples = data.lag_history?.[node.name] || [];
  renderReplication(card, node.status, member, data, node.name);
  renderReplicaLag(card, node.status, member, primaryStatus, data.cluster?.config || {}, data.replication_lag?.[node.name], lagSamples);
  renderLagChart(card, lagSamples);
  return card;
}

function bindPersistentDetails(card, nodeName) {
  card.querySelectorAll('details[data-panel]').forEach(details => {
    const key = `${nodeName}:${details.dataset.panel}`;
    details.open = openPanels.has(key);
    details.addEventListener('toggle', () => {
      details.open ? openPanels.add(key) : openPanels.delete(key);
      sessionStorage.setItem('openPanels', JSON.stringify([...openPanels]));
    });
  });
}

function renderFriendlyMetrics(root, node, config) {
  const container = root.querySelector('.friendly-metrics-grid');
  const metrics = node.metrics || {};
  const role = node.status?.role;
  const ttl = config?.ttl ?? 30;
  const routes=node.patroni_routes || {}; const readWrite=routes.read_write?.available; const readOnly=routes.read_only?.available; const modeKnown=routes.read_write?.status!==undefined&&routes.read_only?.status!==undefined;
  const routeMatches=!modeKnown?null:isPrimary(role)?readWrite:role==='replica'?!readWrite&&readOnly:null;
  const sqlItem=document.createElement('div'); const sqlState=routeMatches===null?'info':routeMatches?'healthy':'unhealthy'; sqlItem.className=`friendly-metric ${sqlState}`;
  sqlItem.innerHTML='<div class="metric-label"><i></i><span></span></div><strong></strong><small></small><code></code>';
  sqlItem.querySelector('i').textContent=sqlState==='info'?'i':routeMatches?'✓':'×';sqlItem.querySelector('span').textContent='Маршруты роли Patroni';
  sqlItem.querySelector('strong').textContent=!modeKnown?'Не удалось проверить':readWrite?'READ-WRITE · подходит для записи':readOnly?'READ-ONLY · только маршрут чтения':'Ни один маршрут не готов';
  sqlItem.querySelector('small').textContent='Это решение Patroni для маршрутизации, а не результат SHOW transaction_read_only внутри SQL-сессии';
  sqlItem.querySelector('code').textContent=`GET /read-write → ${routes.read_write?.status??'ошибка'} · GET /read-only → ${routes.read_only?.status??'ошибка'}`;container.append(sqlItem);
  const definitions = [
    ['patroni_postgres_running','Доступен ли локальный PostgreSQL',v=>v===1?'Да, процесс запущен':'Нет, процесс не работает','Patroni может обратиться к управляемому экземпляру',v=>v===1],
    ['patroni_primary','Соответствует ли объявленная роль',v=>isPrimary(role)?(v===1?'Да, роль первичного сервера подтверждена':'Нет, роль первичного сервера не подтверждена'):(v===0?'Да, узел остаётся репликой':'Нет, роли противоречат друг другу'),'Метрика должна совпадать с ролью в REST API',v=>isPrimary(role)?v===1:v===0],
    ['patroni_postgres_streaming','Получает ли узел поток WAL',v=>isPrimary(role)?'Не требуется для первичного сервера':v===1?'Да, состояние streaming':'Нет, поток остановлен',isPrimary(role)?'Первичный сервер создаёт WAL, а не получает его от другого узла':'Работающий поток не гарантирует нулевое отставание',v=>isPrimary(role)?null:v===1],
    ['patroni_dcs_last_seen','Свежи ли сведения из DCS',v=>v?`${formatDuration(Date.now()/1000-v)} назад`:'Нет данных',`Ожидается контакт чаще ttl=${ttl} с`,v=>v ? Date.now()/1000-v<=ttl : false],
    ['patroni_pending_restart','Применена ли конфигурация полностью',v=>v===1?'Нет, требуется перезапуск':'Да, перезапуск не требуется','Признак pending_restart означает, что часть параметров ещё не действует',v=>v===0],
    ['patroni_cluster_unlocked','Есть ли действующий лидер',v=>v===1?'Нет лидерской блокировки':'Да, блокировка существует','Отсутствие лидера допустимо только кратковременно при переключении',v=>v===0],
    ['patroni_postgres_state','Рабочее ли состояние PostgreSQL',v=>POSTGRES_STATES_RU[v] || v,'Числовое состояние процесса в Patroni',v=>v===5],
    ['patroni_postgres_timeline','Линия времени WAL',v=>`Линия ${v} (timeline)`,'Справочное значение: меняется после повышения реплики',()=>null],
  ];
  definitions.forEach(([metric,label,formatter,help,evaluate]) => {
    const item = document.createElement('div');
    const value = metricValue(metrics, metric);
    const result = value === null ? false : evaluate(value);
    const state = result === null ? 'info' : result ? 'healthy' : 'unhealthy';
    item.className = `friendly-metric ${state}`;
    item.innerHTML = '<div class="metric-label"><i></i><span></span></div><strong></strong><small></small><code></code>';
    item.querySelector('i').textContent = state === 'healthy' ? '✓' : state === 'unhealthy' ? '×' : 'i';
    item.querySelector('span').textContent = label;
    item.querySelector('strong').textContent = value === null ? 'Нет данных' : formatter(value);
    item.querySelector('small').textContent = help;
    item.querySelector('code').textContent = metric;
    container.append(item);
  });
}

function renderMetricsCard(node, data) {
  const card = metricsTemplate.content.firstElementChild.cloneNode(true);
  decorateNode(card, node);
  if (node.reachable) renderFriendlyMetrics(card, node, data.cluster?.config || {});
  else showUnavailable(card,node);
  return card;
}

function renderEtcdHealth(data) {
  const etcd=data.etcd || {}; const state=etcdSnapshot(etcd); const container=document.querySelector('#etcd-health'); container.replaceChildren();
  const latency=etcd.latency_ms===null||etcd.latency_ms===undefined?'—':`${etcd.latency_ms} мс`;
  const diskValues=[state.fsyncAverage,state.commitAverage].filter(value=>value!==null); const diskAverage=diskValues.length?Math.max(...diskValues):null;
  const definitions=[
    ['Доступность DCS',etcd.reachable&&etcd.health?`Доступен · ответ /health за ${latency}`:etcd.reachable?'Недоступен · etcd сообщил о неисправном состоянии':'Недоступен · API не отвечает','GET :2379/health',Boolean(etcd.reachable&&etcd.health),'etcd отвечает на проверку состояния'],
    ['Может ли etcd фиксировать изменения',state.hasLeader===1&&state.pending===0?`Внутренний лидер Raft выбран · ожидающих изменений: ${state.pending}`:`Внутренний лидер Raft: ${state.hasLeader??'нет данных'} · ожидающих изменений: ${state.pending??'—'}`,'etcd_server_has_leader · etcd_server_proposals_pending',state.hasLeader===1&&state.pending===0,'внутренний лидер Raft необходим etcd для фиксации изменений'],
    ['Фиксация на диск',diskAverage===null?'Нет данных':`среднее с момента запуска: ${(diskAverage*1000).toFixed(2)} мс`,'etcd_disk_wal_fsync_duration_seconds · etcd_disk_backend_commit_duration_seconds',diskAverage!==null&&diskAverage<.05,'медленный диск может задержать продление лидерской блокировки'],
    ['Неудачные попытки записи в журнал Raft',state.failed===null?'Нет данных':`${state.failed} с момента запуска etcd`,'etcd_server_proposals_failed_total',state.failed===0,'рост счётчика означает, что etcd не смог зафиксировать часть изменений'],
    ['Размер хранилища',state.storageRatio===null?'Нет данных':`${formatBytes(state.dbSize)} из ${formatBytes(state.quota)} · ${(state.storageRatio*100).toFixed(2)}%`,'etcd_mvcc_db_total_size_in_bytes / etcd_server_quota_backend_bytes',state.storageRatio!==null&&state.storageRatio<.7,'при достижении квоты etcd перестанет принимать обычные записи'],
    ['Состав кластера etcd',state.members?`${state.members} участник${state.members===1?'':'а'} · кворум: ${state.quorum}`:'Состав кластера неизвестен','POST :2379/v3/cluster/member/list',state.intentionalSingle?null:state.members>=3,state.intentionalSingle?'состав демонстрационной среды; ограничения описаны в паспорте стенда':state.members<3?'для отказоустойчивого DCS обычно нужны как минимум три участника':'кластер DCS может пережить отказ части участников'],
  ];
  definitions.forEach(([label,value,source,healthy,help])=>{const status=healthy===null?'info':healthy?'healthy':'unhealthy';const item=document.createElement('div');item.className=`friendly-metric ${status}`;item.innerHTML='<div class="metric-label"><i></i><span></span></div><strong></strong><small></small><code></code>';item.querySelector('i').textContent=status==='info'?'i':healthy?'✓':'×';item.querySelector('span').textContent=label;item.querySelector('strong').textContent=value;item.querySelector('small').textContent=help;item.querySelector('code').textContent=source;container.append(item);});
  const verdict=document.querySelector('#etcd-verdict'); verdict.className=`health-pill ${state.coreHealthy?(state.warning?'warning':state.intentionalSingle?'info':''):'error'}`; verdict.textContent=state.coreHealthy?(state.warning?'работает, требует внимания':state.intentionalSingle?'доступен':'исправен'):'не способен согласовывать';
  const note=document.querySelector('#etcd-topology-note'); note.className=`etcd-health-note ${state.intentionalSingle?'intentional':state.members<3?'warning':''}`; note.innerHTML=state.intentionalSingle?'Сейчас etcd доступен и способен фиксировать решения Patroni. <a href="/stand.html">Состав и ограничения среды описаны в паспорте стенда.</a>':state.members<3?'<strong>Состав DCS требует проверки:</strong> кластер не имеет запаса при отказе одного участника.':'Кластер etcd состоит из нескольких участников; доступность каждого из них следует контролировать отдельно.';
}

function renderRoleMap(cluster) {
  const container = document.querySelector('#role-map');
  const members = cluster?.topology?.members || [];
  const primary = members.find(member => member.role === 'leader');
  container.replaceChildren();
  if (!primary) { container.innerHTML = '<div class="role-node no-primary">ПЕРВИЧНЫЙ СЕРВЕР НЕ ОПРЕДЕЛЁН</div>'; return; }
  const makeNode = (member, kind) => {
    const node = document.createElement('div'); node.className = `role-node ${kind}`;
    node.innerHTML = `<span class="role-icon">${kind === 'primary' ? 'P' : 'R'}</span><div><strong></strong><small></small></div>`;
    node.querySelector('strong').textContent = member.name;
    node.querySelector('small').textContent = kind === 'primary' ? 'ОСНОВНОЙ · PRIMARY · принимает запись' : `РЕПЛИКА · REPLICA · ${nodeStateRu(member.state)}`;
    return node;
  };
  container.append(makeNode(primary,'primary'));
  members.filter(member => member.role !== 'leader').forEach(replica => {
    const arrow = document.createElement('div'); arrow.className='role-arrow'; arrow.innerHTML='<span>WAL</span>→';
    container.append(arrow, makeNode(replica,'replica'));
  });
}

function renderArchitecture(data) {
  const members = data.cluster?.topology?.members || [];
  const config = data.cluster?.config || {};
  const primary = members.find(member => member.role === 'leader');
  const replicas = members.filter(member => member.role !== 'leader');
  document.querySelector('#architecture-primary').textContent = primary ? `primary: ${primary.name}` : 'primary не определён';
  document.querySelector('#architecture-replicas').textContent = replicas.length ? `replica: ${replicas.map(member => member.name).join(', ')}` : 'replica отсутствует';
  const etcdState=etcdSnapshot(data.etcd); const etcdBadge=document.querySelector('#architecture-etcd');
  etcdBadge.textContent=etcdState.members?`${etcdState.members} участник${etcdState.members===1?'':'а'} · кворум: ${etcdState.quorum}`:'состав etcd неизвестен';
  etcdBadge.className=`dcs-topology-badge ${etcdState.intentionalSingle?'info':etcdState.members<3?'warning':''}`;
  const mode=config.synchronous_mode;
  const synchronous=Boolean(mode)&&mode!=='off';
  const strict=Boolean(config.synchronous_mode_strict);
  const badge=document.querySelector('#replication-mode');
  const explainer=document.querySelector('#replication-mode-explainer');
  badge.className=`health-pill mode-pill ${synchronous?'':'warning'}`;
  badge.textContent=synchronous?`синхронный режим · ${mode===true?'on':mode}`:'асинхронный кластер';
  explainer.className=`replication-mode-explainer ${synchronous?'synchronous':'asynchronous'}`;
  explainer.querySelector('.mode-icon').textContent=synchronous?'S':'A';
  explainer.querySelector('strong').textContent=synchronous?'Синхронный режим Patroni · synchronous mode':'Асинхронная репликация · asynchronous';
  explainer.querySelector('p').textContent=synchronous
    ? strict
      ? 'Первичный сервер подтверждает запись только после синхронной реплики. Если подходящей реплики нет, запись блокируется: сохранность данных поставлена выше доступности.'
      : 'Patroni выбирает синхронную реплику и разрешает автоматическое повышение только узлам с подтверждёнными данными. При потере синхронной реплики доступность записи зависит от текущей политики Patroni.'
    : 'Первичный сервер может подтвердить COMMIT, не дожидаясь db2. WAL попадёт на реплику позже; если db1 будет безвозвратно потерян раньше передачи, последних подтверждённых транзакций может не оказаться на новом первичном сервере. Нулевое отставание сейчас не превращает режим в синхронный.';
}

function renderReplicationDirection(data) {
  const members = data.cluster?.topology?.members || [];
  const primary = members.find(member => member.role === 'leader');
  const replicas = members.filter(member => member.role !== 'leader');
  const source = primary?.name || 'неизвестный первичный сервер';
  const targets = replicas.map(member => member.name).join(', ') || 'реплика не найдена';
  document.querySelector('#replication-direction-title').textContent = `${source} передаёт WAL → ${targets}`;
  document.querySelector('#replication-direction-copy').textContent = primary && replicas.length
    ? `${source} сейчас принимает изменения клиентов. PostgreSQL на ${source} формирует WAL, а ${targets} получает и применяет этот поток, чтобы поддерживать физическую копию базы для возможного повышения.`
    : primary
      ? `${source} остаётся первичным сервером, но доступная реплика не найдена. WAL сейчас некому получать: запись работает без актуальной резервной копии.`
      : 'Первичный сервер определить не удалось, поэтому у потока изменений нет подтверждённого источника.';
  document.querySelector('#wal-source').textContent = `${source} · primary`;
  document.querySelector('#wal-target').textContent = `${targets} · replica`;
  document.querySelector('#why-replication-copy').textContent = replicas.length
    ? 'Если первичный сервер станет недоступен, Patroni сможет повысить достаточно актуальную реплику. Репликация уменьшает время восстановления, но не заменяет резервную копию.'
    : 'Сейчас повысить некого: автоматическое переключение не восстановит запись после потери первичного сервера. Восстановите реплику и дождитесь состояния streaming.';
}

function renderTopology(cluster, summary) {
  const container = document.querySelector('#topology'); const error = document.querySelector('#topology-error');
  const health = document.querySelector('#topology-health'); const members = cluster?.topology?.members || [];
  container.replaceChildren();
  if (!members.length) { error.textContent=cluster?.error || 'Топология недоступна'; error.classList.remove('hidden'); health.textContent='неизвестно'; health.className='health-pill error'; return; }
  error.classList.add('hidden');
  const healthy = summary.leaders.length === 1 && summary.reachable === summary.configured;
  health.textContent = healthy ? 'исправен' : 'есть отклонения'; health.className=`health-pill ${healthy?'':'warning'}`;
  const rows = [['Узел','Роль / состояние','Адрес PostgreSQL','Линия времени','Отставание'], ...members.map(member => [member.name,`${nodeRoleRu(member.role)} · ${nodeStateRu(member.state)}`,`${member.host}:${member.port}`,member.timeline ?? '—',member.role==='leader'?'—':formatBytes(member.replay_lag ?? member.lag)])];
  rows.forEach((values,index) => { const row=document.createElement('div'); row.className=`topology-row ${index?'':'topology-header'}`; values.forEach((value,column)=>{const cell=document.createElement('span');cell.textContent=value;if(column===0&&index)cell.className='topology-name';row.append(cell);});container.append(row); });
}

function renderConfig(cluster) {
  const container=document.querySelector('#cluster-config'); const config=cluster?.config || {}; const pg=config.postgresql || {};
  const effective=(value,fallback,suffix='')=>value===undefined?`${fallback}${suffix} (по умолчанию)`:`${value}${suffix}`;
  const values=[['Срок лидерской блокировки · ttl',effective(config.ttl,30,' с')],['Интервал цикла HA · loop_wait',effective(config.loop_wait,10,' с')],['Ожидание повторной попытки · retry_timeout',effective(config.retry_timeout,10,' с')],['Допустимое отставание при автоматическом выборе · maximum_lag_on_failover',config.maximum_lag_on_failover===undefined?`${formatBytes(1048576)} (по умолчанию)`:formatBytes(config.maximum_lag_on_failover)],['Удержание WAL слотами · use_slots',pg.use_slots===false?'выключено':'включено'],['Возврат бывшего первичного сервера · use_pg_rewind',pg.use_pg_rewind?'включён':'выключен'],['Синхронное управление · synchronous_mode',config.synchronous_mode?'включено':'выключено'],['Работа без доступного DCS · failsafe_mode',config.failsafe_mode?'включена':'выключена']];
  container.replaceChildren(); values.forEach(([label,value])=>{const wrapper=document.createElement('div');wrapper.innerHTML='<dt></dt><dd></dd>';wrapper.querySelector('dt').textContent=label;wrapper.querySelector('dd').textContent=value;container.append(wrapper);});
  const ttl=config.ttl??30; const loopWait=config.loop_wait??10; const retry=config.retry_timeout??10; const lag=config.maximum_lag_on_failover??1048576;
  const policy=document.querySelector('#failover-policy');
  const steps=[
    ['1','Когда DCS сочтёт право истёкшим',`Leader lock действует ${ttl} с (ttl). Лидер пытается обновлять его каждые ${loopWait} с; повторный запрос ограничен ${retry} с.`],
    ['2','Кого DCS допустит к соревнованию',`DCS не оценивает качество реплики. Это делает Patroni: отставание свыше ${formatBytes(lag)} исключает кандидата наряду с другими проверками.`],
    ['3','Как выбирается только один победитель',`Кандидаты пытаются создать лидерскую блокировку (leader lock) в DCS одной неделимой операцией. Это удаётся одному узлу; остальные видят занятую блокировку и остаются репликами.`],
    ['4','Что происходит после решения DCS',pg.use_pg_rewind?'Patroni повышает победившую реплику. Прежний первичный сервер затем можно вернуть через pg_rewind, если выполнены условия этой утилиты.':'Patroni повышает победившую реплику. Автоматический pg_rewind выключен, поэтому прежний первичный сервер может потребоваться создать заново как реплику.'],
  ];
  policy.replaceChildren(...steps.map(([number,title,copy])=>{const item=document.createElement('div');item.className='policy-step';item.innerHTML='<span></span><div><strong></strong><p></p></div>';item.querySelector('span').textContent=number;item.querySelector('strong').textContent=title;item.querySelector('p').textContent=copy;return item;}));
  const scheduled=document.querySelector('#scheduled-switchover'); const switchover=cluster?.topology?.scheduled_switchover;
  scheduled.classList.toggle('hidden',!switchover); if(switchover) scheduled.textContent=`Запланировано: ${switchover.from||'автовыбор'} → ${switchover.to||'автовыбор'}, ${switchover.at}`;
}

function svgElement(name, attributes = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  Object.entries(attributes).forEach(([key,value]) => node.setAttribute(key, value));
  return node;
}

function renderStateChart(samples) {
  const container=document.querySelector('#state-chart'); container.replaceChildren();
  if(!samples.length){container.textContent='История появится после первых опросов.';return;}
  const svg=svgElement('svg',{viewBox:'0 0 800 170','aria-hidden':'true',preserveAspectRatio:'none'});
  const width=720/samples.length;
  const leaders=[...new Set(samples.map(sample=>sample.leader).filter(Boolean))];
  const label=svgElement('text',{x:10,y:25,class:'chart-axis-label'});label.textContent='Запись';svg.append(label);
  samples.forEach((sample,index)=>{
    svg.append(svgElement('rect',{x:70+index*width,y:10,width:Math.max(width+.4,1),height:25,class:sample.write_available?'state-up':'state-down'}));
  });
  leaders.forEach((leader,rowIndex)=>{
    const y=58+rowIndex*35; const name=svgElement('text',{x:10,y:y+18,class:'chart-axis-label'});name.textContent=leader;svg.append(name);
    samples.forEach((sample,index)=>{
      svg.append(svgElement('rect',{x:70+index*width,y,width:Math.max(width+.4,1),height:24,class:sample.leader===leader?'leader-active':'leader-inactive'}));
      if(index>0&&sample.leader!==samples[index-1].leader){svg.append(svgElement('line',{x1:70+index*width,x2:70+index*width,y1:5,y2:145,class:'leader-change'}));}
    });
  });
  const first=svgElement('text',{x:70,y:164,class:'chart-time'});first.textContent=new Date(samples[0].timestamp*1000).toLocaleTimeString();
  const last=svgElement('text',{x:790,y:164,'text-anchor':'end',class:'chart-time'});last.textContent=new Date(samples.at(-1).timestamp*1000).toLocaleTimeString();
  svg.append(first,last);container.append(svg);
  const seconds=Math.max(0,samples.at(-1).timestamp-samples[0].timestamp);document.querySelector('#history-window').textContent=`окно ${formatDuration(seconds)}`;
}

function renderHistoryLag(samples) {
  const container=document.querySelector('#history-lag-chart');container.replaceChildren();
  const names=[...new Set(samples.flatMap(sample=>Object.keys(sample.lags||{})))];
  if(!samples.length||!names.length){container.textContent='Пока нет измерений отставания реплик.';return;}
  const values=samples.flatMap(sample=>Object.values(sample.lags||{})).map(Number).filter(Number.isFinite);
  const maximum=Math.max(...values,1); const svg=svgElement('svg',{viewBox:'0 0 800 180','aria-hidden':'true',preserveAspectRatio:'none'});
  [0,.5,1].forEach(fraction=>{const y=145-fraction*120;svg.append(svgElement('line',{x1:70,x2:790,y1:y,y2:y,class:'chart-grid'}));const text=svgElement('text',{x:5,y:y+4,class:'chart-axis-label'});text.textContent=formatBytes(maximum*fraction);svg.append(text);});
  const colors=['lag-series-a','lag-series-b','lag-series-c'];
  names.forEach((name,nameIndex)=>{
    const points=samples.map((sample,index)=>{const value=Number(sample.lags?.[name]);if(!Number.isFinite(value))return null;return `${70+(samples.length===1?0:index*720/(samples.length-1))},${145-value/maximum*120}`;}).filter(Boolean);
    if(points.length)svg.append(svgElement('polyline',{points:points.join(' '),class:`lag-series ${colors[nameIndex%colors.length]}`}));
  });
  container.append(svg);
  const legend=document.createElement('div');legend.className='inline-legend';names.forEach((name,index)=>{const item=document.createElement('span');item.innerHTML='<i></i><b></b>';item.querySelector('i').className=colors[index%colors.length];item.querySelector('b').textContent=name;legend.append(item);});container.append(legend);
}

function observedEvents(samples) {
  const events=[];
  samples.forEach((sample,index)=>{
    if(index===0){events.push({timestamp:sample.timestamp,kind:'info',text:`Начато наблюдение. Лидер: ${sample.leader||'не определён'}.`});return;}
    const previous=samples[index-1];
    if(sample.leader!==previous.leader)events.push({timestamp:sample.timestamp,kind:sample.leader?'warning':'error',text:`Лидер изменился: ${previous.leader||'нет'} → ${sample.leader||'нет'}.`});
    if(sample.write_available!==previous.write_available)events.push({timestamp:sample.timestamp,kind:sample.write_available?'ok':'error',text:`Маршрут записи ${sample.write_available?'снова доступен':'стал недоступен'}.`});
    if(sample.reachable!==previous.reachable)events.push({timestamp:sample.timestamp,kind:sample.reachable===sample.configured?'ok':'warning',text:`Доступно нод: ${sample.reachable} из ${sample.configured}.`});
  });
  return events;
}

function renderHistory(data) {
  const samples=data.state_history||[];
  renderStateChart(samples);renderHistoryLag(samples);
  const eventContainer=document.querySelector('#observed-events');const events=observedEvents(samples);eventContainer.replaceChildren();
  if(!events.length)eventContainer.innerHTML='<div class="empty">Изменений пока не замечено.</div>';
  [...events].reverse().slice(0,20).forEach(event=>{const row=document.createElement('div');row.className=`event-row ${event.kind}`;row.innerHTML='<i></i><div><strong></strong><time></time></div>';row.querySelector('i').textContent=event.kind==='ok'?'✓':event.kind==='error'?'×':event.kind==='info'?'i':'!';row.querySelector('strong').textContent=event.text;row.querySelector('time').textContent=new Date(event.timestamp*1000).toLocaleTimeString();eventContainer.append(row);});
  const container=document.querySelector('#history'); const history=data.cluster?.history||[];container.replaceChildren();
  if(!history.length){container.innerHTML='<div class="empty">Повышений реплики ещё не было, поэтому новая линия времени не создавалась.</div>';return;}
  const reasonRu=reason=>{
    if(!reason)return 'создана новая ветвь WAL после повышения реплики';
    if(reason==='no recovery target specified')return 'реплика повышена без заданной точки восстановления';
    return reason;
  };
  [...history].reverse().forEach(event=>{const row=document.createElement('div');row.className='history-row';row.innerHTML='<strong></strong><span></span><time></time>';row.querySelector('strong').textContent=`Линия времени ${event[0]}`;row.querySelector('span').textContent=`${reasonRu(event[2])} · начало ветви: LSN ${event[1]??'—'}`;row.querySelector('time').textContent=event[3]?new Date(event[3]).toLocaleString():'—';container.append(row);});
}

function renderSummary(data) {
  const members=data.cluster?.topology?.members || []; const lags=members.filter(m=>m.role!=='leader').map(m=>m.replay_lag??m.lag).filter(Number.isFinite);
  const paused=data.nodes.some(n=>n.status?.pause || metricValue(n.metrics,'patroni_is_paused')===1);
  document.querySelector('#leader').textContent=data.summary.leaders.join(', ') || 'нет лидера'; document.querySelector('#reachable').textContent=`${data.summary.reachable} / ${data.summary.configured}`; document.querySelector('#scope').textContent=data.summary.scope || '—'; document.querySelector('#max-lag').textContent=lags.length?formatBytes(Math.max(...lags)):'—'; document.querySelector('#cluster-mode').textContent=data.summary.leaders.length!==1?'невозможно: нет лидера':paused?'приостановлено (pause)':'включено'; document.querySelector('#updated').textContent=new Date(data.collected_at*1000).toLocaleTimeString();
  const nodeSources=data.nodes.map(node=>node.url.replace(/^https?:\/\//,'')).join(' · ');
  document.querySelector('#node-api-sources').textContent=`${nodeSources || 'узлы не настроены'} → /patroni · /read-write · /read-only · /metrics`;
  const etcdState=etcdSnapshot(data.etcd); const nodeCount=data.summary.configured;
  const dcsText=etcdState.coreHealthy?'DCS доступен':'DCS недоступен';
  document.querySelector('#lab-status-detail').textContent=`PostgreSQL: ${nodeCount} узла. ${dcsText}. Последний опрос: ${new Date(data.collected_at*1000).toLocaleTimeString()}`;
}

function diagnostic(label, detail, status, source) { return {label,detail,status,source}; }
function endpointDetail(endpoint) {
  if(endpoint?.available)return `${endpoint.latency_ms} мс · найден сервер с подходящей ролью`;
  if(endpoint?.listener_available)return 'HAProxy отвечает, но сервера с подходящей ролью нет';
  return 'порт HAProxy недоступен';
}
function renderDiagnostics(data) {
  const members=data.cluster?.topology?.members || []; const config=data.cluster?.config || {}; const threshold=config.maximum_lag_on_failover ?? 1048576; const ttl=config.ttl ?? 30;
  const replicas=members.filter(m=>m.role!=='leader'); const timelines=members.map(m=>m.timeline).filter(v=>v!==undefined); const dcsAges=data.nodes.filter(n=>n.reachable&&n.status?.dcs_last_seen).map(n=>Date.now()/1000-n.status.dcs_last_seen);
  const replicaLagsKnownAndAllowed=replicas.length>0 && replicas.every(replica=>{
    const lag=Number(replica.replay_lag??replica.lag);
    return Number.isFinite(lag) && lag<=threshold;
  });
  const etcdState=etcdSnapshot(data.etcd);
  const routeModes=data.nodes.map(node=>({name:node.name,role:node.status?.role,routes:node.patroni_routes||{}}));
  const routeModesKnown=routeModes.length>0&&routeModes.every(node=>node.routes.read_write?.status!==undefined&&node.routes.read_only?.status!==undefined);
  const routeModesMatch=routeModesKnown&&routeModes.every(node=>isPrimary(node.role)?node.routes.read_write.available:node.role==='replica'&&!node.routes.read_write.available&&node.routes.read_only.available);
  const checks=[
    diagnostic('Ровно один первичный сервер',`${data.summary.leaders.length}: ${data.summary.leaders.join(', ') || 'не найден'}`,data.summary.leaders.length===1?'ok':'error','GET /patroni → $.role на каждом узле'),
    diagnostic('Маршруты Patroni соответствуют ролям',routeModes.map(node=>`${node.name}: ${node.routes.read_write?.available?'read-write':node.routes.read_only?.available?'read-only':'не готов'}`).join(' · '),routeModesMatch?'ok':routeModesKnown?'error':'warning','GET /read-write + GET /read-only на каждом узле'),
    diagnostic('Patroni REST API доступны на всех узлах',`${data.summary.reachable} из ${data.summary.configured}`,data.summary.reachable===data.summary.configured?'ok':'error','HTTP-доступность GET /patroni на каждом узле'),
    diagnostic('Реплики получают WAL',replicas.length?replicas.map(r=>`${r.name}: ${nodeStateRu(r.state)}`).join(', '):'реплик нет',replicas.length&&replicas.every(r=>r.state==='streaming'||r.state==='running')?'ok':'error','GET /cluster → $.members[*].role + $.members[*].state'),
    diagnostic('Отставание реплик не превышает установленный предел',`Предел maximum_lag_on_failover: ${formatBytes(threshold)}. Это только одно из условий выбора нового первичного сервера`,replicaLagsKnownAndAllowed?'ok':'warning','GET /cluster → $.members[*].lag; GET /config → $.maximum_lag_on_failover'),
    diagnostic('Узлы находятся на одной ветви WAL',timelines.length?`линия времени (timeline): ${[...new Set(timelines)].join(', ')}`:'нет данных',new Set(timelines).size<=1?'ok':'warning','GET /cluster → $.members[*].timeline'),
    diagnostic('Patroni недавно связывался с DCS',`Последний контакт должен быть не более ${ttl} с назад (ttl)`,dcsAges.length&&dcsAges.every(age=>age<=ttl)?'ok':'error','GET /patroni → $.dcs_last_seen; GET /config → $.ttl'),
    diagnostic('DCS доступен для согласования лидера',etcdState.coreHealthy?`etcd отвечает · участников: ${etcdState.members??'—'} · кворум: ${etcdState.quorum??'—'}`:'etcd не может зафиксировать решение: нет внутреннего лидера Raft или есть ожидающие изменения',etcdState.coreHealthy?(etcdState.warning?'warning':'ok'):'error','GET etcd:2379/health + /metrics → etcd_server_has_leader, etcd_server_proposals_pending'),
    diagnostic('HAProxy: маршрут записи',endpointDetail(data.entrypoints?.write),data.entrypoints?.write?.available?'ok':'error','TCP localhost:5000 + GET /patroni → $.role = primary'),
    diagnostic('HAProxy: маршрут чтения',endpointDetail(data.entrypoints?.read),data.entrypoints?.read?.available?'ok':'warning','TCP localhost:5001 + GET /patroni → $.role = replica'),
  ];
  if(data.nodes.some(n=>n.status?.pending_restart)) checks.push(diagnostic('Нет ожидающего перезапуска','части параметров требуется перезапуск PostgreSQL','warning','GET /patroni → $.pending_restart'));
  if(data.nodes.some(n=>n.status?.pause)) checks.push(diagnostic('Автоматическое управление включено','автоматическое управление кластером приостановлено (pause)','warning','GET /patroni → $.pause'));
  const container=document.querySelector('#diagnostics'); container.replaceChildren();
  checks.forEach(check=>{const row=document.createElement('div');row.className=`diagnostic-row ${check.status}`;row.innerHTML='<span class="diagnostic-icon"></span><div><strong></strong><small class="diagnostic-value"></small><small class="diagnostic-source"><b>Источник</b><code></code></small></div>';row.querySelector('.diagnostic-icon').textContent=check.status==='ok'?'✓':check.status==='warning'?'!':'×';row.querySelector('strong').textContent=check.label;row.querySelector('.diagnostic-value').textContent=check.detail;row.querySelector('.diagnostic-source code').textContent=check.source;container.append(row);});
  const writeAvailable=Boolean(data.entrypoints?.write?.available&&data.summary.leaders.length===1);
  const reachableReplicas=data.nodes.filter(node=>node.reachable&&node.status?.role==='replica');
  const serviceDegraded=data.summary.reachable<data.summary.configured||reachableReplicas.length===0;
  const hasIssues=checks.some(check=>check.status!=='ok');
  const state=!writeAvailable?'error':serviceDegraded||hasIssues?'warning':'ok';
  const verdict=document.querySelector('#diagnostic-verdict'); verdict.className=`health-pill ${state}`;
  verdict.textContent=!writeAvailable?'запись недоступна':serviceDegraded?'запись доступна · отказоустойчивость снижена':hasIssues?'запись доступна · есть риски':'запись доступна · реплика работает';
  const summary=document.querySelector('#diagnostic-summary'); summary.className=`diagnostic-summary ${state}`;
  const summaryTitle=summary.querySelector('strong'); const summaryCopy=summary.querySelector('p'); const leader=data.summary.leaders[0]||'не определён';
  if(!writeAvailable){summaryTitle.textContent='Новые подключения для записи сейчас установить нельзя.';summaryCopy.textContent='Первичный сервер не подтверждён либо HAProxy не может направить к нему соединение. Сначала восстановите маршрут записи :5000.';}
  else if(serviceDegraded){summaryTitle.textContent=`Запись продолжает работать через первичный сервер ${leader}.`;summaryCopy.textContent=reachableReplicas.length?'Часть узлов недоступна, но одна реплика продолжает работать. Отказоустойчивость снижена — выясните причину отказа.':'Доступной реплики сейчас нет. Если первичный сервер откажет до её восстановления, Patroni не сможет автоматически вернуть доступность записи.';}
  else if(hasIssues){summaryTitle.textContent=`Маршрут записи :5000 ведёт на первичный сервер ${leader}.`;summaryCopy.textContent='Кластер принимает изменения, но ниже отмечены риски или отклонения. Они не означают полной остановки сервиса.';}
  else {summaryTitle.textContent=`Запись доступна через первичный сервер ${leader}, реплика работает.`;summaryCopy.textContent='Маршрут записи доступен, и в кластере есть резервная реплика. Вывод основан на последних полученных данных, а не на пробной SQL-транзакции.';}
  const outage=document.querySelector('#dcs-outage-explainer');
  outage.classList.toggle('hidden',etcdState.coreHealthy);
}

function renderEntrypoints(data) {
  const container=document.querySelector('#entrypoints'); container.replaceChildren();
  const leader=data.summary?.leaders?.[0]||'не определён';
  [['write','localhost:5000','Запись и обычные транзакции',`Новые соединения направляются только на первичный сервер ${leader}. Используйте этот адрес по умолчанию.`],['read','localhost:5001','Отдельная нагрузка только на чтение','Новые соединения направляются на доступные реплики. Данные могут немного отставать; запись через этот адрес запрещена.']].forEach(([key,address,title,help])=>{const endpoint=data.entrypoints?.[key] || {};const card=document.createElement('article');card.className=`entrypoint-card ${endpoint.available?'available':'unavailable'}`;card.innerHTML='<span class="entrypoint-kind"></span><strong></strong><code></code><small></small>';card.querySelector('.entrypoint-kind').textContent=endpoint.available?`✓ маршрут готов · ${endpoint.latency_ms} мс`:endpoint.listener_available?'× нет сервера с подходящей ролью':'× порт HAProxy недоступен';card.querySelector('strong').textContent=title;card.querySelector('code').textContent=address;card.querySelector('small').textContent=`${help} Панель проверяет порт HAProxy и наличие узла подходящей роли, но не выполняет пробный SQL-запрос.`;container.append(card);});
}

function updateControls(data) {
  const members=data.cluster?.topology?.members||[]; const config=data.cluster?.config||{}; const lagLimit=config.maximum_lag_on_failover??1048576;
  const leader=data.summary.leaders[0]; const replicas=data.nodes.filter(node=>node.reachable&&node.status?.role==='replica'); const paused=data.nodes.some(node=>node.status?.pause); const dcsHealthy=etcdSnapshot(data.etcd).coreHealthy;
  data.nodes.forEach(node=>{const target=document.querySelector(`#control-${node.name}-state`);if(target){const member=members.find(item=>item.name===node.name)||{};target.textContent=node.reachable?`${nodeRoleRu(node.status?.role)} · ${nodeStateRu(node.status?.state)}${node.status?.role==='replica'?` · отставание ${formatBytes(member.replay_lag??member.lag)}`:''}`:'Patroni недоступен';}});
  const operationActive=Boolean(activeOperation&&!activeOperation.logged);const preflight=[['Запись',data.entrypoints?.write?.available?`доступна · первичный сервер ${leader}`:'недоступна',Boolean(data.entrypoints?.write?.available)],['Реплика',replicas.length?replicas.map(node=>node.name).join(', '):'нет доступной',replicas.length>0],['DCS',dcsHealthy?'работает':'недоступен',dcsHealthy],['Автоматическое управление',paused?'приостановлено (pause)':'включено',!paused],['Операция',operationActive?'выполняется':'нет активной',!operationActive]];
  const preflightContainer=document.querySelector('#control-preflight');preflightContainer.replaceChildren(...preflight.map(([label,value,ok])=>{const item=document.createElement('div');item.className=ok?'ok':'problem';item.innerHTML='<i></i><span></span><strong></strong>';item.querySelector('i').textContent=ok?'✓':'!';item.querySelector('span').textContent=label;item.querySelector('strong').textContent=value;return item;}));
  const ready=Boolean(leader&&replicas.length&&dcsHealthy&&!paused);const preflightVerdict=document.querySelector('#control-preflight-verdict');preflightVerdict.className=`health-pill ${ready?'':'warning'}`;preflightVerdict.textContent=ready?'готов к штатным операциям':'есть ограничения';

  document.querySelector('#switchover-from').textContent=`Первичный сервер: ${leader || 'не определён'}`;
  const select=document.querySelector('#switchover-candidate'); const previous=select.value;
  const candidates=replicas.map(node=>{const member=members.find(item=>item.name===node.name)||{};const lag=Number(member.replay_lag??member.lag);return {node,lag,eligible:Number.isFinite(lag)&&lag<=lagLimit&&(node.status?.state==='running'||node.status?.state==='streaming')};});
  select.replaceChildren(...candidates.map(({node,lag,eligible})=>{const option=document.createElement('option');option.value=node.name;option.disabled=!eligible;option.textContent=`${node.name} · реплика · отставание ${formatBytes(lag)}${eligible?' · готова':' · не готова'}`;return option;}));if(candidates.some(item=>item.node.name===previous&&item.eligible))select.value=previous;
  const candidate=candidates.find(item=>item.node.name===select.value);let switchReason='';if(!leader)switchReason='Нет подтверждённого первичного сервера.';else if(!dcsHealthy)switchReason='DCS недоступен: роли нельзя безопасно согласовать.';else if(paused)switchReason='Сначала выключите режим обслуживания командой resume.';else if(!candidate?.eligible)switchReason='Нет реплики с работающим потоком WAL и допустимым отставанием.';
  const switchButton=document.querySelector('#switchover-button');switchButton.disabled=Boolean(switchReason);document.querySelector('#switchover-disabled-reason').textContent=switchReason||`Готово: ${leader} будет понижен, ${candidate.node.name} — повышена.`;
  const scope=data.summary.scope||'postgresql-cluster';const candidateName=candidate?.node.name||'<candidate>';const leaderName=leader||'<primary>';const leaderUrl=data.nodes.find(node=>node.name===leader)?.url||'https://patroni-primary:8008';
  document.querySelector('#prod-switchover-cli').textContent=`patronictl -c /etc/patroni/config.yml switchover ${scope} --leader ${leaderName} --candidate ${candidateName}`;
  document.querySelector('#prod-switchover-rest').textContent=`curl -sS -X POST ${leaderUrl}/switchover -H 'Content-Type: application/json' -d '${JSON.stringify({leader:leaderName,candidate:candidateName})}'`;

  const selected=selectedControlNodes();const selectedNodes=selected.map(name=>data.nodes.find(node=>node.name===name)).filter(Boolean);const allSelected=selected.length>=data.summary.configured;const unreachableSelected=selectedNodes.some(node=>!node.reachable);
  const restartButton=document.querySelector('button[data-action="postgres_restart"]');const reloadButton=document.querySelector('button[data-action="reload"]');restartButton.disabled=!selected.length||allSelected||unreachableSelected;reloadButton.disabled=!selected.length||unreachableSelected;
  document.querySelector('#restart-disabled-reason').textContent=!selected.length?'Выберите один узел.':allSelected?'Одновременный перезапуск PostgreSQL на всех узлах запрещён.':unreachableSelected?'Выбранный узел недоступен.':'Результат будет проверен по изменению postmaster_start_time.';
  document.querySelector('#reload-disabled-reason').textContent=!selected.length?'Выберите хотя бы один узел.':unreachableSelected?'Выбранный узел недоступен.':'Перечитывание конфигурации не перезапускает PostgreSQL.';
  const selectedPrimary=selectedNodes.find(node=>isPrimary(node.status?.role));document.querySelector('#restart-impact').textContent=!selected.length?'Выберите узел — здесь появится описание влияния на доступность.':selectedPrimary?`${selectedPrimary.name} сейчас является первичным сервером. Перезапуск может вызвать переключение и разрыв клиентских соединений.`:`Выбрана реплика ${selected.join(', ')}. Запись должна продолжить работу; дождитесь восстановления потока WAL (состояние streaming).`;
  const memberNames=selected.length?selected.join(','):'<member>';const selectedUrl=selectedNodes[0]?.url||'https://patroni-member:8008';document.querySelector('#prod-restart-cli').textContent=`patronictl -c /etc/patroni/config.yml restart ${scope} ${memberNames}`;document.querySelector('#prod-restart-rest').textContent=`curl -sS -X POST ${selectedUrl}/restart -H 'Content-Type: application/json' -d '{}'`;document.querySelector('#prod-reload-cli').textContent=`patronictl -c /etc/patroni/config.yml reload ${scope} ${memberNames}`;document.querySelector('#prod-reload-rest').textContent=`curl -sS -X POST ${selectedUrl}/reload`;

  const pauseButton=document.querySelector('button[data-action="pause"]');const resumeButton=document.querySelector('button[data-action="resume"]');pauseButton.disabled=paused||!dcsHealthy||data.summary.leaders.length!==1;resumeButton.disabled=!paused;document.querySelector('#pause-disabled-reason').textContent=paused?'Режим ручного обслуживания уже включён. После завершения работ выключите его командой resume.':!dcsHealthy?'Нельзя включить режим ручного обслуживания: DCS недоступен.':data.summary.leaders.length!==1?'Для операции нужен ровно один подтверждённый первичный сервер.':'Автоматическое управление включено. Команда pause переводит в режим обслуживания весь кластер.';
  const patroniUrl=data.nodes.find(node=>node.reachable)?.url||'https://patroni-member:8008';document.querySelector('#prod-pause-cli').textContent=`patronictl -c /etc/patroni/config.yml pause ${scope} --wait`;document.querySelector('#prod-resume-cli').textContent=`patronictl -c /etc/patroni/config.yml resume ${scope} --wait`;document.querySelector('#prod-pause-rest').textContent=`curl -sS -X PATCH ${patroniUrl}/config -H 'Content-Type: application/json' -d '{"pause":true}'`;document.querySelector('#prod-resume-rest').textContent=`curl -sS -X PATCH ${patroniUrl}/config -H 'Content-Type: application/json' -d '{"pause":false}'`;

  const replicaName=replicas[0]?.name||'<replica>';document.querySelector('#experiment-stop-replica').textContent=`docker compose stop ${replicaName}`;document.querySelector('#experiment-start-replica').textContent=`docker compose start ${replicaName}`;document.querySelector('#experiment-stop-primary').textContent=`docker compose stop ${leader||'<primary>'}`;document.querySelector('#experiment-start-primary').textContent=`docker compose start ${leader||'<primary>'}`;
  document.querySelector('#experiment-observation').textContent=!dcsHealthy?`DCS недоступен. Patroni отвечает на ${data.summary.reachable} из ${data.summary.configured} узлов; запись ${data.entrypoints?.write?.available?'доступна':'недоступна'}, чтение ${data.entrypoints?.read?.available?'доступно':'недоступно'}.`:data.summary.reachable<data.summary.configured?`Недоступных узлов: ${data.summary.configured-data.summary.reachable}. Запись ${data.entrypoints?.write?.available?'остаётся доступной':'недоступна'}.`:`Стенд работает штатно: ${leader||'не определён'} — первичный сервер, ${replicaName} — реплика.`;
}

function saveOperationLog(entry){operationLog=[entry,...operationLog].slice(0,20);sessionStorage.setItem('operationLog',JSON.stringify(operationLog));renderOperationLog();}
function renderOperationLog(){const container=document.querySelector('#operation-history');container.replaceChildren();if(!operationLog.length){container.innerHTML='<p class="empty">Операций пока не было.</p>';return;}operationLog.forEach(entry=>{const row=document.createElement('div');row.className=`operation-log-row ${entry.status}`;row.innerHTML='<i></i><div><strong></strong><small></small></div><time></time>';row.querySelector('i').textContent=entry.status==='complete'?'✓':entry.status==='failed'?'×':'…';row.querySelector('strong').textContent=entry.label;row.querySelector('small').textContent=entry.detail;row.querySelector('time').textContent=new Date(entry.timestamp).toLocaleTimeString();container.append(row);});}

function updateOperationTracker(data) {
  const tracker=document.querySelector('#operation-tracker'); if(!activeOperation){tracker.classList.add('hidden');return;}
  let complete=false; let detail='Ожидаем подтверждение новым состоянием кластера…';
  if(activeOperation.action==='reload'){complete=true;detail='Patroni принял команду перечитать локальную конфигурацию.';}
  if(activeOperation.action==='switchover'){complete=data.summary.leaders[0]===activeOperation.candidate;detail=complete?`${activeOperation.candidate} стал первичным сервером.`:`Текущий первичный сервер: ${data.summary.leaders[0] || 'не определён'}.`;}
  if(['pause','resume'].includes(activeOperation.action)){const expected=activeOperation.action==='pause';complete=data.nodes.filter(n=>n.reachable).some(n=>Boolean(n.status?.pause)===expected);detail=complete?(expected?'Приостановка автоматического управления подтверждена через REST API.':'Возобновление автоматического управления подтверждено через REST API.'):'Ожидаем изменения режима автоматического управления.';}
  if(activeOperation.action==='postgres_restart'){const changed=activeOperation.nodes.filter(name=>{const node=data.nodes.find(n=>n.name===name);return node?.reachable&&node.status?.postmaster_start_time!==activeOperation.before[name];});complete=changed.length===activeOperation.nodes.length;detail=`Перезапуск подтверждён для ${changed.length} из ${activeOperation.nodes.length} узлов по postmaster_start_time.`;}
  const timedOut=Date.now()-activeOperation.started>90000; tracker.className=`operation-tracker ${complete?'complete':timedOut?'failed':'running'}`;tracker.innerHTML='<strong></strong><div class="operation-progress"><span class="done">1. Запрос отправлен</span><span class="done">2. Patroni принял</span><span class="effect">3. Проверяем результат</span><span class="stable">4. Состояние устойчиво</span></div><p></p><small></small>';tracker.querySelector('strong').textContent=complete?'✓ Ожидаемый результат подтверждён':timedOut?'× Истекло время ожидания результата':'Проверяем фактическое состояние…';tracker.querySelector('p').textContent=detail;tracker.querySelector('.effect').classList.toggle('done',complete);tracker.querySelector('.stable').classList.toggle('done',complete);tracker.querySelector('small').textContent=`Операция: ${ACTION_LABELS_RU[activeOperation.action] || activeOperation.action} · начата ${new Date(activeOperation.started).toLocaleTimeString()}. Этот результат останется видимым в журнале текущего сеанса.`;
  if((complete||timedOut)&&!activeOperation.logged){activeOperation.logged=true;saveOperationLog({timestamp:Date.now(),status:complete?'complete':'failed',label:ACTION_LABELS_RU[activeOperation.action]||activeOperation.action,detail});}
}

const selectedControlNodes=()=>[...document.querySelectorAll('input[name="control-node"]:checked')].map(input=>input.value);
async function runAction(payload, confirmation) {
  const resultBox=document.querySelector('#action-result');
  if(payload.action==='postgres_restart' && payload.nodes.length>=Number(latestData?.summary?.configured)){resultBox.className='action-result failure';resultBox.textContent='Одновременный перезапуск PostgreSQL на всех узлах запрещён: кластер потеряет доступность.';return;}
  if(confirmation&&!window.confirm(confirmation))return;
  document.querySelectorAll('.control-panel button').forEach(button=>button.disabled=true); resultBox.className='action-result pending'; resultBox.textContent='Передаём команду Patroni…';
  try { const response=await fetch('/api/actions',{method:'POST',headers:{'Content-Type':'application/json','X-Patroni-Lab':'control'},body:JSON.stringify(payload)}); const result=await response.json(); if(!response.ok||!result.ok)throw new Error(result.message||JSON.stringify(result.results||result));
    activeOperation={...payload,started:Date.now(),before:Object.fromEntries((payload.nodes||[]).map(name=>[name,latestData.nodes.find(n=>n.name===name)?.status?.postmaster_start_time]))}; resultBox.className='action-result success'; resultBox.textContent='Patroni принял команду. Следующий блок показывает проверку фактического результата по состоянию кластера.'; updateOperationTracker(latestData);
  } catch(error){resultBox.className='action-result failure';resultBox.textContent=`Ошибка: ${error.message}`;saveOperationLog({timestamp:Date.now(),status:'failed',label:ACTION_LABELS_RU[payload.action]||payload.action,detail:error.message});} finally {document.querySelectorAll('.control-panel button').forEach(button=>button.disabled=false);if(latestData)updateControls(latestData);setTimeout(refresh,800);}
}

document.querySelectorAll('button[data-action]').forEach(button=>button.addEventListener('click',()=>{const action=button.dataset.action;const nodes=selectedControlNodes();const roles=nodes.map(name=>`${name} (${nodeRoleRu(latestData?.nodes.find(n=>n.name===name)?.status?.role)})`).join(', ');const primarySelected=nodes.some(name=>isPrimary(latestData?.nodes.find(node=>node.name===name)?.status?.role));const confirmations={postgres_restart:`Перезапустить PostgreSQL: ${roles}?${primarySelected?' Выбран первичный сервер: возможны автоматическое переключение и разрыв соединений.':''}`,pause:'Перейти в режим ручного обслуживания для всего кластера? До выполнения resume Patroni не будет автоматически повышать реплику и исправлять некоторые опасные состояния.'};runAction({action,nodes},confirmations[action]||null);}));
document.querySelector('#switchover-button').addEventListener('click',()=>{const leader=latestData?.summary?.leaders?.[0];const candidate=document.querySelector('#switchover-candidate').value;runAction({action:'switchover',leader,candidate},`Передать роль первичного сервера с ${leader} на ${candidate}?`);});

document.querySelectorAll('[data-control-target]').forEach(button=>button.addEventListener('click',()=>{const target=button.dataset.controlTarget;document.querySelectorAll('[data-control-target]').forEach(item=>item.classList.toggle('active',item===button));document.querySelectorAll('[data-control-view]').forEach(view=>view.classList.toggle('active',view.dataset.controlView===target));sessionStorage.setItem('controlView',target);}));
const savedControlView=sessionStorage.getItem('controlView');if(savedControlView)document.querySelector(`[data-control-target="${savedControlView}"]`)?.click();
document.querySelectorAll('input[name="control-node"]').forEach(input=>input.addEventListener('change',()=>latestData&&updateControls(latestData)));
document.querySelector('#switchover-candidate').addEventListener('change',()=>latestData&&updateControls(latestData));
document.querySelectorAll('[data-copy-command]').forEach(button=>button.addEventListener('click',async()=>{const command=document.querySelector(`#${button.dataset.copyCommand}`).textContent;try{await navigator.clipboard.writeText(command);button.textContent='Скопировано ✓';setTimeout(()=>button.textContent='Копировать команду',1600);}catch{button.textContent='Не удалось скопировать';}}));
document.querySelector('#clear-operation-history').addEventListener('click',()=>{operationLog=[];sessionStorage.removeItem('operationLog');renderOperationLog();});
renderOperationLog();

document.querySelectorAll('[data-view-target]').forEach(button=>button.addEventListener('click',()=>{const target=button.dataset.viewTarget;document.querySelectorAll('[data-view-target]').forEach(item=>item.classList.toggle('active',item===button));document.querySelectorAll('[data-view]').forEach(view=>view.classList.toggle('active',view.dataset.view===target));sessionStorage.setItem('activeView',target);}));
const requestedView=new URLSearchParams(window.location.search).get('view');
const savedView=requestedView || sessionStorage.getItem('activeView');
if(savedView)document.querySelector(`[data-view-target="${savedView}"]`)?.click();

async function refresh() {
  if(refreshInFlight)return; refreshInFlight=true; const live=document.querySelector('#live-status');
  try { const response=await fetch('/api/cluster',{cache:'no-store'});if(!response.ok)throw new Error(`HTTP ${response.status}`);const data=await response.json();latestData=data;
    renderSummary(data);renderDiagnostics(data);renderArchitecture(data);renderEntrypoints(data);renderRoleMap(data.cluster);renderTopology(data.cluster,data.summary);renderConfig(data.cluster);renderReplicationDirection(data);renderHistory(data);renderEtcdHealth(data);updateControls(data);updateOperationTracker(data);
    const primaryStatus=data.nodes.find(node=>isPrimary(node.status?.role))?.status;
    nodesContainer.replaceChildren(...data.nodes.map(renderNode));replicationContainer.replaceChildren(...data.nodes.map(node=>renderReplicationCard(node,data,primaryStatus)));metricsContainer.replaceChildren(...data.nodes.map(node=>renderMetricsCard(node,data)));
    live.className='live fresh';live.querySelector('strong').textContent='данные обновляются';errorBox.classList.add('hidden');
  } catch(error){live.className='live error';live.querySelector('strong').textContent='нет свежих данных';document.querySelector('#lab-status-detail').textContent='Связь с сервером панели потеряна; показанные ниже значения могут быть устаревшими.';errorBox.textContent=`Не удалось обновить панель: ${error.message}`;errorBox.classList.remove('hidden');} finally {refreshInFlight=false;}
}

refresh(); setInterval(refresh,2000);
