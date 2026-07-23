const state = {
  board: null,
  report: null,
  status: null,
  activity: null,
  currentTicketId: null,
  pendingRequestKey: null,
};

const statusLabels = { new: 'Новая', in_progress: 'В работе', done: 'Выполнена' };
const priorityLabels = { low: 'Низкий', normal: 'Обычный', high: 'Высокий' };
const eventLabels = { created: 'Заявка создана', status_changed: 'Состояние изменено', comment: 'Комментарий' };

const byId = id => document.getElementById(id);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function formatDate(value, withSeconds = false) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
  }).format(date);
}

function ticketWordAccusative(count) {
  const lastTwo = Math.abs(count) % 100;
  const last = lastTwo % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return 'заявок';
  if (last === 1) return 'заявку';
  if (last >= 2 && last <= 4) return 'заявки';
  return 'заявок';
}

function randomRequestKey() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const value = Math.random() * 16 | 0;
    return (character === 'x' ? value : (value & 0x3) | 0x8).toString(16);
  });
}

async function fetchJson(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', ...options });
  let payload = {};
  try { payload = await response.json(); } catch (_) { /* response without JSON */ }
  if (!response.ok) {
    const error = new Error(payload.message || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function showToast(message, kind = 'info') {
  const toast = byId('toast');
  toast.textContent = message;
  toast.className = `toast visible ${kind === 'error' ? 'error' : ''}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.className = 'toast'; }, 4200);
}

function instanceDescription(route) {
  if (!route?.available) return 'маршрут недоступен';
  const database = route.database;
  const mode = database.in_recovery ? 'реплика · доступно только чтение' : 'первичный сервер · запись разрешена';
  return `${route.host}:${route.port} → PostgreSQL ${database.server_address}:${database.server_port} · ${mode} · ${route.latency_ms} мс`;
}

function renderRoute(elementId, route, purpose) {
  const element = byId(elementId);
  element.classList.remove('loading', 'unavailable');
  const title = element.querySelector('strong');
  const detail = element.querySelector('p');
  if (!route?.available) {
    element.classList.add('unavailable');
    title.textContent = purpose === 'write' ? 'Запись временно недоступна' : 'Отчёт временно недоступен';
    detail.textContent = purpose === 'write'
      ? 'Новые прикладные операции выполнить нельзя'
      : 'Рабочая доска может продолжать работать через первичный сервер';
    return;
  }
  title.textContent = purpose === 'write' ? 'Запись доступна' : 'Реплика отвечает';
  detail.textContent = `${route.database.server_address}:${route.database.server_port} · ${route.latency_ms} мс`;
}

function renderStatus(payload) {
  state.status = payload;
  renderRoute('write-route', payload.write, 'write');
  renderRoute('read-route', payload.read, 'read');
  byId('write-technical').textContent = instanceDescription(payload.write);
  byId('read-technical').textContent = instanceDescription(payload.read);
  byId('simulation-toggle').checked = Boolean(payload.simulation_enabled);

  const overall = byId('overall-state');
  overall.className = 'hero-state';
  const title = overall.querySelector('strong');
  const detail = overall.querySelector('small');
  if (payload.write.available && payload.read.available) {
    overall.classList.add('ok');
    title.textContent = 'Основная работа и отчёт доступны';
    detail.textContent = 'Оба маршрута подтверждены настоящими SQL-запросами';
  } else if (payload.write.available) {
    overall.classList.add('degraded');
    title.textContent = 'Заявки принимаются, отчёт недоступен';
    detail.textContent = 'Создание и обработка заявок работают, но чтение с реплики недоступно';
  } else if (payload.read.available) {
    overall.classList.add('degraded');
    title.textContent = 'Запись недоступна, реплика отвечает';
    detail.textContent = 'Существующие данные можно читать, но изменять нельзя';
  } else {
    overall.classList.add('down');
    title.textContent = 'Приложение не может обратиться к базе';
    detail.textContent = 'Проверьте точку входа и состояние кластера в панели';
  }
}

async function loadStatus() {
  try {
    renderStatus(await fetchJson('/api/status'));
  } catch (_) {
    renderStatus({ write: { available: false }, read: { available: false }, simulation_enabled: false });
  }
}

function ticketCard(ticket) {
  return `
    <button type="button" class="ticket-card" data-ticket-id="${ticket.id}">
      <span class="ticket-card-head"><span>№${ticket.id} · v${ticket.version}</span><i class="priority ${escapeHtml(ticket.priority)}" title="${priorityLabels[ticket.priority] || ticket.priority}"></i></span>
      <strong>${escapeHtml(ticket.title)}</strong>
      <p>${escapeHtml(ticket.description)}</p>
      <span class="ticket-meta"><span>${escapeHtml(ticket.assignee || 'Не назначена')}</span><span>${formatDate(ticket.updated_at)}</span></span>
    </button>`;
}

function renderBoard(payload) {
  state.board = payload;
  const grouped = { new: [], in_progress: [], done: [] };
  payload.tickets.forEach(ticket => grouped[ticket.status]?.push(ticket));
  for (const status of Object.keys(grouped)) {
    const container = document.querySelector(`.ticket-list[data-status="${status}"]`);
    container.innerHTML = grouped[status].length
      ? grouped[status].map(ticketCard).join('')
      : '<p class="ticket-empty">В этой колонке пока нет заявок.</p>';
    const countId = status === 'in_progress' ? 'count-in-progress' : `count-${status}`;
    byId(countId).textContent = grouped[status].length;
  }
  document.querySelectorAll('[data-ticket-id]').forEach(card => {
    card.addEventListener('click', () => openTicket(Number(card.dataset.ticketId)));
  });
  byId('board-updated').textContent = `${formatDate(payload.database.database_time, true)} · ${payload.latency_ms} мс`;
  byId('board').classList.remove('hidden');
  byId('board-error').classList.add('hidden');
}

async function loadBoard({ quiet = false } = {}) {
  try {
    renderBoard(await fetchJson('/api/board'));
  } catch (error) {
    const target = byId('board-error');
    target.textContent = 'Рабочая доска временно недоступна: приложение не может выполнить запрос через маршрут записи. Уже показанные данные могли устареть.';
    target.classList.remove('hidden');
    if (!state.board) byId('board').classList.add('hidden');
    if (!quiet) showToast(error.message, 'error');
  }
}

function renderReport(payload) {
  state.report = payload;
  const summary = payload.summary;
  const boardTotal = state.board?.tickets?.length;
  const difference = Number.isFinite(boardTotal) ? boardTotal - Number(summary.total) : 0;
  const lagNote = difference > 0
    ? `На рабочей доске уже на ${difference} ${ticketWordAccusative(difference)} больше. Реплика ещё не отразила последние изменения.`
    : 'Количество заявок совпадает с текущей рабочей доской.';
  byId('report-content').innerHTML = `
    <div class="report-total"><span>Всего заявок на реплике</span><strong>${summary.total}</strong></div>
    <div class="report-states">
      <div><strong>${summary.new}</strong><span>новые</span></div>
      <div><strong>${summary.in_progress}</strong><span>в работе</span></div>
      <div><strong>${summary.done}</strong><span>выполнены</span></div>
    </div>
    <div class="report-note ${difference > 0 ? '' : 'ok'}">${escapeHtml(lagNote)}<br>Последнее изменение в данных: ${formatDate(summary.data_updated_at, true)}</div>
    <div class="assignee-list"><h3>Открытые заявки по исполнителям</h3>${payload.assignees.length
      ? payload.assignees.map(row => `<div class="assignee-row"><span>${escapeHtml(row.assignee)}</span><strong>${row.ticket_count}</strong></div>`).join('')
      : '<div class="assignee-row"><span>Открытых заявок нет</span><strong>0</strong></div>'}</div>`;
  byId('report-content').classList.remove('hidden', 'loading-block');
  byId('report-error').classList.add('hidden');
}

async function loadReport({ quiet = false } = {}) {
  try {
    renderReport(await fetchJson('/api/report'));
  } catch (error) {
    const target = byId('report-error');
    target.textContent = 'Сводный отчёт временно недоступен. Это не означает, что создание и обработка заявок также остановлены.';
    target.classList.remove('hidden');
    byId('report-content').classList.add('hidden');
    if (!quiet) showToast(error.message, 'error');
  }
}

function renderActivity(payload) {
  state.activity = payload;
  byId('simulation-toggle').checked = Boolean(payload.enabled);
  byId('activity-success').textContent = payload.successes;
  byId('activity-failure').textContent = payload.failures;
  byId('activity-log').innerHTML = payload.operations.length
    ? payload.operations.slice(0, 14).map(operation => `
      <p class="${operation.ok ? '' : 'error'}"><time>${formatDate(operation.timestamp, true)}${operation.duration_ms != null ? ` · ${operation.duration_ms} мс` : ''}</time>${escapeHtml(operation.message)}</p>`).join('')
    : '<p>Операций пока нет.</p>';
}

async function loadActivity() {
  try { renderActivity(await fetchJson('/api/activity')); } catch (_) { /* process may be restarting */ }
}

function renderTicketDetails(payload) {
  const ticket = payload.ticket;
  byId('dialog-title').textContent = `№${ticket.id} · ${ticket.title}`;
  byId('ticket-details').innerHTML = `
    <p class="ticket-description">${escapeHtml(ticket.description)}</p>
    <div class="ticket-facts">
      <div><span>Приоритет</span><strong>${priorityLabels[ticket.priority] || ticket.priority}</strong></div>
      <div><span>Состояние</span><strong>${statusLabels[ticket.status] || ticket.status}</strong></div>
      <div><span>Версия</span><strong>${ticket.version}</strong></div>
      <div><span>Последний COMMIT</span><strong>txid ${ticket.transaction_id}<br>${escapeHtml(ticket.committed_by || '—')}</strong></div>
    </div>`;
  const statusForm = byId('status-form');
  statusForm.elements.status.value = ticket.status;
  statusForm.elements.assignee.value = ticket.assignee || '';
  byId('event-list').innerHTML = `<h3>История изменений</h3>${payload.events.map(event => `
    <article class="event"><strong>${eventLabels[event.event_type] || event.event_type} · ${escapeHtml(event.actor)}</strong><span>${escapeHtml(event.details)}</span><small>${formatDate(event.created_at, true)} · txid ${event.transaction_id} · ${escapeHtml(event.committed_by || '—')}</small></article>`).join('')}`;
}

async function openTicket(ticketId) {
  state.currentTicketId = ticketId;
  try {
    const payload = await fetchJson(`/api/tickets/${ticketId}`);
    renderTicketDetails(payload);
    if (!byId('ticket-dialog').open) byId('ticket-dialog').showModal();
  } catch (error) { showToast(error.message, 'error'); }
}

async function refreshApplication() {
  await Promise.all([loadStatus(), loadBoard({ quiet: true }), loadReport({ quiet: true }), loadActivity()]);
}

byId('ticket-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = byId('create-ticket');
  const result = byId('create-result');
  if (!state.pendingRequestKey) state.pendingRequestKey = randomRequestKey();
  const payload = {
    request_key: state.pendingRequestKey,
    title: form.elements.title.value,
    description: form.elements.description.value,
    priority: form.elements.priority.value,
  };
  button.disabled = true;
  button.textContent = 'Сохраняем заявку…';
  result.className = 'form-result hidden';
  try {
    const response = await fetchJson('/api/tickets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    result.textContent = response.created
      ? `Заявка №${response.ticket.id} зафиксирована. Она может появиться в отчёте с небольшой задержкой.`
      : `Этот запрос уже был выполнен: найдена заявка №${response.ticket.id}. Вторая заявка не создана.`;
    result.className = 'form-result';
    form.reset();
    state.pendingRequestKey = null;
    button.textContent = 'Создать заявку';
    await Promise.all([loadBoard({ quiet: true }), loadReport({ quiet: true }), loadActivity()]);
  } catch (error) {
    result.textContent = `${error.message} Идентификатор запроса сохранён: повторная отправка сначала проверит, не была ли заявка уже создана.`;
    result.className = 'form-result error';
    button.textContent = 'Повторить тот же запрос';
  } finally {
    button.disabled = false;
    loadStatus();
  }
});

byId('status-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!state.currentTicketId) return;
  const form = event.currentTarget;
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    await fetchJson(`/api/tickets/${state.currentTicketId}/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: form.elements.status.value, assignee: form.elements.assignee.value }),
    });
    await Promise.all([openTicket(state.currentTicketId), loadBoard({ quiet: true }), loadReport({ quiet: true }), loadActivity()]);
    showToast('Состояние заявки и запись истории зафиксированы одной транзакцией');
  } catch (error) { showToast(error.message, 'error'); } finally { button.disabled = false; loadStatus(); }
});

byId('comment-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!state.currentTicketId) return;
  const form = event.currentTarget;
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    await fetchJson(`/api/tickets/${state.currentTicketId}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment: form.elements.comment.value, actor: form.elements.actor.value }),
    });
    form.elements.comment.value = '';
    await Promise.all([openTicket(state.currentTicketId), loadBoard({ quiet: true }), loadReport({ quiet: true }), loadActivity()]);
    showToast('Комментарий добавлен');
  } catch (error) { showToast(error.message, 'error'); } finally { button.disabled = false; loadStatus(); }
});

byId('simulation-toggle').addEventListener('change', async event => {
  const enabled = event.target.checked;
  event.target.disabled = true;
  try {
    renderActivity(await fetchJson('/api/simulation', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-App': 'control' },
      body: JSON.stringify({ enabled }),
    }));
    showToast(enabled ? 'Учебные операторы начали работу' : 'Имитация работы остановлена');
  } catch (error) {
    event.target.checked = !enabled;
    showToast(error.message, 'error');
  } finally { event.target.disabled = false; }
});

byId('refresh-board').addEventListener('click', () => loadBoard());
byId('refresh-report').addEventListener('click', () => loadReport());
byId('close-dialog').addEventListener('click', () => byId('ticket-dialog').close());
byId('ticket-dialog').addEventListener('click', event => { if (event.target === event.currentTarget) event.currentTarget.close(); });

document.querySelectorAll('[href^="http://localhost:8088"]').forEach(link => {
  const url = new URL(link.href);
  url.hostname = location.hostname;
  link.href = url.toString();
});

refreshApplication();
setInterval(loadStatus, 4000);
setInterval(() => loadBoard({ quiet: true }), 5000);
setInterval(() => loadReport({ quiet: true }), 6000);
setInterval(loadActivity, 3000);
