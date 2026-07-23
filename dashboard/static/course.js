let course = null;
let stateKey = null;
let state = null;
const moduleCache = new Map();
const lesson = document.querySelector('#lesson');
const moduleNav = document.querySelector('#module-nav');
const toast = document.querySelector('#toast');
let clusterData = null;
let clusterRequestInFlight = false;
let toastTimer = null;

const explorationRoutes = {
  'postgres-replication': {href: '/?view=replication#dashboard-start', label: 'Наблюдать репликацию'},
  'ha-architecture': {href: '/?view=overview#dashboard-start', label: 'Исследовать архитектуру и DCS'},
  'patroni-concepts': {href: '/?view=overview#dashboard-start', label: 'Проверить состояние кластера'},
  'cluster-operations': {href: '/?view=control#dashboard-start', label: 'Открыть управление стендом'},
  'patroni-configuration': {href: '/?view=overview#dashboard-start', label: 'Сопоставить настройки и состояние'},
  'incident-recovery': {href: '/?view=control#dashboard-start', label: 'Провести эксперимент с отказом'},
};

function defaultState() {
  return {
    moduleRevisions: Object.fromEntries(course.modules.map(module => [module.id, module.revision])),
    activeModule: course.modules[0].id,
    quizPassed: {},
    quizAnswers: {},
    examPassed: {},
  };
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(stateKey) || '{}');
    const result = {...defaultState(), ...saved};
    const currentRevisions = defaultState().moduleRevisions;
    const savedRevisions = saved.moduleRevisions
      || (saved.contentRevision === 4 ? currentRevisions : {});
    let migrated = false;
    for (const module of course.modules) {
      if (savedRevisions[module.id] === module.revision) continue;
      result.quizPassed = {...result.quizPassed};
      result.quizAnswers = {...result.quizAnswers};
      result.examPassed = {...result.examPassed};
      delete result.quizPassed[module.id];
      delete result.quizAnswers[module.id];
      delete result.examPassed[module.id];
      migrated = true;
    }
    result.moduleRevisions = currentRevisions;
    delete result.contentRevision;
    if (migrated || saved.contentRevision !== undefined) {
      localStorage.setItem(stateKey, JSON.stringify(result));
    }
    return result;
  } catch (_) {
    return defaultState();
  }
}

function saveState() {
  localStorage.setItem(stateKey, JSON.stringify(state));
  renderNavigation();
  renderOverallProgress();
}

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function showToast(message, kind = 'info') {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast visible ${kind}`;
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3500);
}

function formatBytes(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const bytes = Number(value);
  if (bytes === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const index = Math.min(Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function isPrimary(role) {
  return ['leader', 'primary', 'master'].includes(role);
}

function topologyMembers() {
  return clusterData?.cluster?.topology?.members || [];
}

function currentTimeline() {
  const leader = clusterData?.summary?.leaders?.[0];
  return topologyMembers().find(member => member.name === leader)?.timeline
    ?? clusterData?.nodes?.find(node => node.name === leader)?.status?.timeline
    ?? null;
}

function moduleComplete(module) {
  return module.kind === 'practical-exam'
    ? Boolean(state.examPassed[module.id])
    : Boolean(state.quizPassed[module.id]);
}

function renderOverallProgress() {
  const complete = course.modules.filter(moduleComplete).length;
  const percent = Math.round(complete / course.modules.length * 100);
  document.querySelector('#progress-title').textContent = `Пройдено ${complete} из ${course.modules.length} модулей`;
  document.querySelector('#progress-percent').textContent = `${percent}%`;
  document.querySelector('#progress-bar').style.width = `${percent}%`;
}

function renderNavigation() {
  moduleNav.replaceChildren();
  course.modules.forEach(module => {
    const button = element('button', 'module-link');
    button.classList.toggle('active', state.activeModule === module.id);
    button.classList.toggle('complete', moduleComplete(module));
    button.dataset.module = module.id;
    const number = element('span', 'module-number', moduleComplete(module) ? '✓' : String(module.number));
    const copy = element('span', 'module-copy');
    copy.append(element('strong', '', module.shortTitle), element('small', '', module.type));
    const status = element('span', 'module-status', moduleComplete(module) ? 'пройден' : state.quizPassed[module.id] || state.examPassed[module.id] ? 'в процессе' : '');
    button.append(number, copy, status);
    button.addEventListener('click', () => selectModule(module.id));
    moduleNav.append(button);
  });
}

async function selectModule(moduleId) {
  if (!course.modules.some(module => module.id === moduleId)) return;
  state.activeModule = moduleId;
  saveState();
  history.replaceState(null, '', `/course.html?module=${encodeURIComponent(moduleId)}`);
  await renderModule();
  window.scrollTo({top: document.querySelector('.course-layout').offsetTop - 16, behavior: 'smooth'});
  lesson.focus({preventScroll: true});
}

function renderModuleHeader(module) {
  const header = element('header', 'lesson-header');
  const meta = element('div', 'lesson-meta');
  meta.append(element('span', '', `Модуль ${module.number} из ${course.modules.length}`), element('span', '', module.type), element('span', '', module.duration));
  header.append(meta, element('h1', '', module.title), element('p', 'lesson-lead', module.lead));

  const outcomes = element('section', 'outcomes');
  outcomes.append(element('strong', '', 'После модуля вы сможете'));
  const list = element('ul');
  module.outcomes.forEach(outcome => list.append(element('li', '', outcome)));
  outcomes.append(list);
  header.append(outcomes);
  return header;
}

function renderDiagram(items) {
  const flow = element('div', 'concept-flow');
  items.forEach((item, index) => {
    const stage = element('div', 'concept-stage');
    stage.append(element('span', 'stage-index', item[0]));
    const copy = element('div');
    copy.append(element('strong', '', item[1]), element('small', '', item[2]));
    stage.append(copy);
    flow.append(stage);
    if (index < items.length - 1) flow.append(element('span', 'stage-arrow', '→'));
  });
  return flow;
}

function renderTable(table) {
  const wrapper = element('div', 'learning-table-wrap');
  const result = document.createElement('table');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  table.headers.forEach(label => headRow.append(element('th', '', label)));
  head.append(headRow);
  const body = document.createElement('tbody');
  table.rows.forEach(values => {
    const row = document.createElement('tr');
    values.forEach(value => row.append(element('td', '', value)));
    body.append(row);
  });
  result.append(head, body);
  wrapper.append(result);
  return wrapper;
}

function copyText(value) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(value).then(() => showToast('Команда скопирована', 'success'));
  } else {
    showToast('Буфер обмена недоступен — выделите команду вручную', 'warning');
  }
}

function renderCode(code) {
  const wrapper = element('div', 'code-block');
  const heading = element('div', 'code-heading');
  const button = element('button', '', 'Копировать');
  button.type = 'button';
  button.addEventListener('click', () => copyText(code.value));
  heading.append(element('span', '', code.label), button);
  wrapper.append(heading, element('pre', '', code.value));
  return wrapper;
}

function renderLearningSection(section, index) {
  const article = element('article', 'learning-section');
  const heading = element('div', 'learning-heading');
  heading.append(element('span', '', String(index + 1).padStart(2, '0')), element('h2', '', section.title));
  article.append(heading);
  (section.body || []).forEach(paragraph => article.append(element('p', '', paragraph)));
  if (section.diagram) article.append(renderDiagram(section.diagram));
  if (section.table) article.append(renderTable(section.table));
  if (section.code) article.append(renderCode(section.code));
  if (section.points) {
    const list = element('ul', 'key-points');
    section.points.forEach(point => list.append(element('li', '', point)));
    article.append(list);
  }
  if (section.callout) {
    const callout = element('aside', `callout ${section.callout.kind}`);
    callout.append(element('strong', '', section.callout.title), element('p', '', section.callout.text));
    article.append(callout);
  }
  return article;
}

function renderDocumentation(module) {
  const section = element('section', 'docs-bridge');
  const heading = element('div', 'section-title');
  heading.append(element('span', 'section-label', 'НАВЫК РАБОТЫ С ДОКУМЕНТАЦИЕЙ'), element('h2', '', 'Куда идти за подробностями'));
  section.append(heading, element('p', 'section-intro', 'Не читайте документацию подряд. Откройте нужный раздел, найдите термин из урока и проверьте параметры перед реальным изменением.'));
  const grid = element('div', 'docs-grid');
  module.docs.forEach(doc => {
    const link = element('a', 'doc-card');
    link.href = doc.url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.append(element('strong', '', doc.label), element('small', '', doc.purpose), element('span', '', 'Открыть официальный раздел ↗'));
    grid.append(link);
  });
  section.append(grid);
  return section;
}

function renderQuiz(module) {
  const section = element('section', 'knowledge-check');
  const heading = element('div', 'section-title');
  heading.append(element('span', 'section-label', 'ПРОВЕРКА ПОНИМАНИЯ'), element('h2', '', 'Объясните поведение, а не термин'));
  section.append(heading, element('p', 'section-intro', 'Все ответы должны быть верными. После ошибки используйте объяснение и попробуйте ещё раз.'));
  const form = element('form', 'quiz-form');
  module.quiz.forEach((question, questionIndex) => {
    const fieldset = element('fieldset', 'quiz-question');
    fieldset.dataset.question = question.id;
    fieldset.append(element('legend', '', `${questionIndex + 1}. ${question.question}`));
    question.options.forEach((option, optionIndex) => {
      const label = element('label', 'quiz-option');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = `${module.id}-${question.id}`;
      input.value = String(optionIndex);
      input.checked = Number(state.quizAnswers?.[module.id]?.[question.id]) === optionIndex;
      label.append(input, element('span', '', option));
      fieldset.append(label);
    });
    const feedback = element('div', 'quiz-feedback');
    fieldset.append(feedback);
    form.append(fieldset);
  });
  const controls = element('div', 'section-controls');
  const submit = element('button', 'primary-button', state.quizPassed[module.id] ? 'Проверка пройдена — проверить снова' : 'Проверить ответы');
  submit.type = 'submit';
  const status = element('span', `completion-badge ${state.quizPassed[module.id] ? 'complete' : ''}`, state.quizPassed[module.id] ? '✓ теория зачтена' : 'нужно ответить на все вопросы');
  controls.append(submit, status);
  form.append(controls);
  form.addEventListener('submit', event => checkQuiz(event, module));
  section.append(form);
  return section;
}

function checkQuiz(event, module) {
  event.preventDefault();
  const form = event.currentTarget;
  const answers = {};
  let allAnswered = true;
  let allCorrect = true;
  module.quiz.forEach(question => {
    const fieldset = form.querySelector(`[data-question="${question.id}"]`);
    const selected = fieldset.querySelector('input:checked');
    const feedback = fieldset.querySelector('.quiz-feedback');
    fieldset.classList.remove('correct', 'incorrect');
    if (!selected) {
      allAnswered = false;
      allCorrect = false;
      feedback.textContent = 'Выберите ответ.';
      fieldset.classList.add('incorrect');
      return;
    }
    const answer = Number(selected.value);
    answers[question.id] = answer;
    const correct = answer === question.answer;
    allCorrect = allCorrect && correct;
    fieldset.classList.add(correct ? 'correct' : 'incorrect');
    feedback.textContent = `${correct ? 'Верно.' : 'Пока нет.'} ${question.explanation}`;
  });
  state.quizAnswers[module.id] = answers;
  if (allAnswered && allCorrect) {
    state.quizPassed[module.id] = true;
    const badge = form.querySelector('.completion-badge');
    badge.className = 'completion-badge complete';
    badge.textContent = '✓ теория зачтена';
    showToast('Теоретическая часть модуля зачтена', 'success');
  } else {
    showToast(allAnswered ? 'Разберите объяснения и попробуйте ещё раз' : 'Ответьте на все вопросы', 'warning');
  }
  saveState();
  updateModuleCompletion(module);
}

function renderLab(module) {
  const lab = module.lab;
  const section = element('section', 'lab-section');
  section.id = 'current-lab';
  const heading = element('div', 'lab-heading');
  const headingCopy = element('div');
  headingCopy.append(element('span', 'section-label', 'ПРАКТИКА НА ЖИВОМ КЛАСТЕРЕ'), element('h2', '', lab.title));
  const badge = element('span', `lab-badge ${state.labPassed[module.id] ? 'complete' : ''}`, state.labPassed[module.id] ? '✓ лаборатория зачтена' : 'ожидает выполнения');
  heading.append(headingCopy, badge);
  section.append(heading, element('p', 'lab-objective', lab.objective));
  if (lab.risk) {
    const warning = element('aside', 'lab-risk');
    warning.append(element('strong', '', 'Влияние на стенд'), element('p', '', lab.risk));
    section.append(warning);
  }
  const steps = element('ol', 'lab-steps');
  lab.steps.forEach(step => steps.append(element('li', '', step)));
  section.append(steps);
  const workspace = element('div', 'lab-workspace');
  workspace.dataset.labType = lab.type;
  section.append(workspace);
  renderLabWorkspace(module, workspace);
  return section;
}

function clusterUnavailable(workspace) {
  workspace.replaceChildren(element('div', 'lab-result failure', 'Не удалось получить текущее состояние кластера. Проверьте панель состояния и повторите запрос.'));
}

function nodeOptions(select, placeholder) {
  select.replaceChildren();
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = placeholder;
  select.append(empty);
  (clusterData?.nodes || []).forEach(node => {
    const option = document.createElement('option');
    option.value = node.name;
    option.textContent = node.name;
    select.append(option);
  });
}

function labResult(workspace, message, kind = 'neutral') {
  let result = workspace.querySelector('.lab-result');
  if (!result) {
    result = element('div', 'lab-result');
    workspace.append(result);
  }
  result.className = `lab-result ${kind}`;
  result.textContent = message;
}

function passLab(module, message) {
  state.labPassed[module.id] = true;
  saveState();
  showToast('Лабораторная работа зачтена', 'success');
  const workspace = document.querySelector('#current-lab .lab-workspace');
  if (workspace) labResult(workspace, message, 'success');
  updateModuleCompletion(module);
}

function renderIdentifyReplicationLab(module, workspace) {
  if (!clusterData) return clusterUnavailable(workspace);
  const evidence = element('dl', 'preflight-evidence');
  (clusterData.nodes || []).filter(node => node.reachable).forEach(node => {
    const status = node.status || {};
    const routes = node.patroni_routes || {};
    const mode = routes.read_write?.available
      ? 'чтение и запись'
      : routes.read_only?.available
        ? 'только чтение'
        : 'режим не подтверждён';
    const wal = status.role === 'replica'
      ? `получено ${status.xlog?.received_location ?? '—'}, применено ${status.xlog?.replayed_location ?? '—'}`
      : `текущая позиция ${status.xlog?.location ?? '—'}`;
    const item = element('div');
    item.append(
      element('dt', '', `${node.name}: ${status.role || 'роль не определена'}`),
      element('dd', '', `${mode}; ${wal}; состояние потока ${status.replication_state || status.state || '—'}`),
    );
    evidence.append(item);
  });
  workspace.append(
    element('p', 'workspace-note', 'Наблюдения получены через Patroni REST API: роль и позиции WAL — GET /patroni, режим доступа — GET /read-write и GET /read-only.'),
    evidence,
  );
  const form = element('div', 'lab-form two-columns');
  const primaryLabel = element('label');
  primaryLabel.append(element('span', '', 'Текущий первичный сервер'));
  const primary = document.createElement('select');
  primary.id = 'lab-primary';
  nodeOptions(primary, 'Выберите узел');
  primaryLabel.append(primary);
  const replicaLabel = element('label');
  replicaLabel.append(element('span', '', 'Реплика: потоковая репликация (streaming)'));
  const replica = document.createElement('select');
  replica.id = 'lab-replica';
  nodeOptions(replica, 'Выберите узел');
  replicaLabel.append(replica);
  form.append(primaryLabel, replicaLabel);
  const button = element('button', 'primary-button', 'Проверить состояние кластера');
  button.type = 'button';
  button.addEventListener('click', () => {
    const leader = clusterData?.summary?.leaders?.[0];
    const selectedReplica = topologyMembers().find(member => member.name === replica.value);
    if (primary.value === leader && replica.value !== leader && selectedReplica && ['streaming', 'running'].includes(selectedReplica.state)) {
      const replicaNode = clusterData.nodes.find(node => node.name === replica.value);
      const access = replicaNode?.patroni_routes?.read_only?.available && !replicaNode?.patroni_routes?.read_write?.available
        ? 'Patroni подтверждает для неё режим только чтения'
        : 'режим доступа нужно проверить отдельно';
      passLab(module, `Верно: ${leader} сейчас является первичным сервером, а ${replica.value} получает его WAL. ${access}. Имена узлов сами по себе не задают роли.`);
    } else {
      labResult(workspace, 'Ответ не совпадает с текущей топологией. Смотрите role и state, а не номер в имени узла.', 'failure');
    }
  });
  workspace.append(form, button);
  if (state.labPassed[module.id]) labResult(workspace, 'Лаборатория уже зачтена. Роли могут измениться после следующего переключения.', 'success');
}

function healthyBaseline() {
  const configured = clusterData?.summary?.configured || 0;
  const members = topologyMembers();
  return clusterData?.summary?.leaders?.length === 1
    && clusterData?.summary?.reachable === configured
    && configured >= 2
    && members.filter(member => member.role !== 'leader').every(member => ['streaming', 'running'].includes(member.state));
}

function commandPanel(label, command) {
  const panel = element('div', 'lab-command');
  const heading = element('div');
  const copy = element('button', '', 'Копировать');
  copy.type = 'button';
  copy.addEventListener('click', () => copyText(command));
  heading.append(element('span', '', label), copy);
  panel.append(heading, element('code', '', command));
  return panel;
}

function resetLabState(module) {
  delete state.labState[module.id];
  delete state.labPassed[module.id];
  saveState();
  renderModule();
}

function renderFailoverLab(module, workspace) {
  if (!clusterData) return clusterUnavailable(workspace);
  const drill = state.labState[module.id] || {};
  const status = element('div', 'drill-status');
  const phases = [['baseline','Исходное состояние'],['failed-over','Новый первичный сервер и запись'],['recovered','Возврат реплики']];
  phases.forEach(([phase,label], index) => {
    const item = element('div', 'drill-phase');
    const reached = drill.phase === 'recovered' || drill.phase === phase || (drill.phase === 'failed-over' && phase === 'baseline');
    item.classList.toggle('reached', reached);
    item.append(element('span', '', reached ? '✓' : String(index + 1)), element('strong', '', label));
    status.append(item);
  });
  workspace.append(status);

  if (!drill.phase) {
    const button = element('button', 'primary-button', 'Зафиксировать исходное состояние');
    button.type = 'button';
    button.addEventListener('click', () => {
      if (!healthyBaseline()) return labResult(workspace, 'Предварительная проверка не пройдена: требуется один первичный сервер, доступность всех узлов и исправная реплика.', 'failure');
      const oldLeader = clusterData.summary.leaders[0];
      state.labState[module.id] = {phase:'baseline', oldLeader, baselineTimeline:currentTimeline(), startedAt:Date.now()};
      saveState();
      renderModule();
    });
    workspace.append(element('p', 'workspace-note', 'Сначала курс проверит, что кластер находится в устойчивом состоянии.'), button);
    return;
  }

  const stopCommand = `docker compose stop ${drill.oldLeader}`;
  const startCommand = `docker compose start ${drill.oldLeader}`;
  workspace.append(commandPanel('Остановить только исходный первичный сервер', stopCommand));
  const recovery = element('aside', 'recovery-note');
  recovery.append(element('strong', '', 'Команда восстановления должна быть под рукой'), element('code', '', startCommand));
  workspace.append(recovery);

  if (drill.phase === 'baseline') {
    const button = element('button', 'primary-button', 'Проверить автоматическое переключение');
    button.type = 'button';
    button.addEventListener('click', () => {
      const oldNode = clusterData.nodes.find(node => node.name === drill.oldLeader);
      const leader = clusterData.summary.leaders[0];
      const promotedTimeline = Number(currentTimeline());
      const baselineTimeline = Number(drill.baselineTimeline);
      const timelineAdvanced = Number.isFinite(promotedTimeline) && Number.isFinite(baselineTimeline) && promotedTimeline > baselineTimeline;
      const writeAvailable = Boolean(clusterData.entrypoints?.write?.available);
      if (oldNode?.reachable || !leader || leader === drill.oldLeader || !timelineAdvanced || !writeAvailable) return labResult(workspace, `Переключение ещё не подтверждено полностью: ${drill.oldLeader} ${oldNode?.reachable ? 'всё ещё доступен' : 'недоступен'}, текущий лидер — ${leader || 'не определён'}, линия времени — ${Number.isFinite(promotedTimeline) ? promotedTimeline : 'не определена'}, маршрут записи — ${writeAvailable ? 'доступен' : 'недоступен'}.`, 'failure');
      state.labState[module.id] = {...drill, phase:'failed-over', newLeader:leader, promotedTimeline};
      saveState();
      renderModule();
    });
    workspace.append(element('p', 'workspace-note', `Исходное состояние: первичный сервер ${drill.oldLeader}, линия времени ${drill.baselineTimeline}. Выполните команду остановки и дождитесь нового первичного сервера.`), button);
  } else if (drill.phase === 'failed-over') {
    const button = element('button', 'primary-button', 'Проверить возврат прежнего первичного сервера');
    button.type = 'button';
    button.addEventListener('click', () => {
      const oldNode = clusterData.nodes.find(node => node.name === drill.oldLeader);
      const oldMember = topologyMembers().find(member => member.name === drill.oldLeader);
      const leader = clusterData.summary.leaders[0];
      const activeTimeline = Number(currentTimeline());
      const oldTimeline = Number(oldMember?.timeline);
      const recovered = clusterData.summary.reachable === clusterData.summary.configured
        && leader === drill.newLeader
        && oldNode?.reachable
        && oldMember?.role !== 'leader'
        && ['streaming', 'running'].includes(oldMember?.state)
        && clusterData.entrypoints?.write?.available
        && Number.isFinite(activeTimeline)
        && oldTimeline === activeTimeline;
      if (!recovered) return labResult(workspace, `Возврат ещё не завершён: лидер ${leader || '—'}, узел ${drill.oldLeader}: роль ${oldMember?.role || 'не виден'}, состояние ${oldMember?.state || '—'}, линия времени ${Number.isFinite(oldTimeline) ? oldTimeline : 'не определена'} при текущей ${Number.isFinite(activeTimeline) ? activeTimeline : 'не определена'}, маршрут записи ${clusterData.entrypoints?.write?.available ? 'доступен' : 'недоступен'}.`, 'failure');
      state.labState[module.id] = {...drill, phase:'recovered'};
      passLab(module, `${drill.newLeader} остался первичным сервером, а ${drill.oldLeader} вернулся в роли реплики. Линия времени изменилась с ${drill.baselineTimeline} на ${currentTimeline()}.`);
      renderModule();
    });
    workspace.append(element('p', 'workspace-note', `Аварийное переключение подтверждено: новый первичный сервер ${drill.newLeader}, линия времени ${drill.promotedTimeline}. Теперь запустите прежний узел.`), button);
  } else {
    labResult(workspace, `Упражнение завершено: ${drill.newLeader} — первичный сервер, ${drill.oldLeader} вернулся в роли реплики.`, 'success');
    const repeat = element('button', 'secondary-button', 'Повторить упражнение с текущими ролями');
    repeat.type = 'button';
    repeat.addEventListener('click', () => resetLabState(module));
    workspace.append(repeat);
  }
}

function renderPatronictlObservationLab(module, workspace) {
  if (!clusterData) return clusterUnavailable(workspace);
  const prefix = 'PATRONICTL_NODE=db1  # замените на db2, если db1 недоступен\n';
  workspace.append(
    element('p', 'workspace-note', 'Сначала выполните команды и сохраните их вывод. Не определяйте роли по именам db1 и db2. Учебная система использует REST API и DCS только для проверки заполненной карточки.'),
    commandPanel('Снимок с отметкой времени', `${prefix}docker compose exec "$PATRONICTL_NODE" patronictl -c /etc/patroni/config.yml list --extended --timestamp`),
    commandPanel('Направление репликации', `${prefix}docker compose exec "$PATRONICTL_NODE" patronictl -c /etc/patroni/config.yml topology`),
    commandPanel('История и версии при углублённой проверке', `${prefix}docker compose exec "$PATRONICTL_NODE" patronictl -c /etc/patroni/config.yml history\ndocker compose exec "$PATRONICTL_NODE" patronictl -c /etc/patroni/config.yml version postgresql-cluster`),
  );

  const selectField = (label, options) => {
    const wrapper = element('label');
    wrapper.append(element('span', '', label));
    const select = document.createElement('select');
    options.forEach(([value, text]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      select.append(option);
    });
    wrapper.append(select);
    return {wrapper, select};
  };
  const nodeChoices = [
    ['', 'Выберите значение'],
    ...(clusterData.nodes || []).map(node => [node.name, node.name]),
    ['none', 'не определён'],
  ];
  const leaderField = selectField('Leader из patronictl list', nodeChoices);
  const replicaField = selectField('Участник, ожидаемый в роли Replica', nodeChoices);
  const replicaStateField = selectField('Состояние репликации', [
    ['', 'Выберите значение'],
    ['streaming', 'WAL поступает в режиме streaming'],
    ['unavailable', 'реплика недоступна'],
    ['other', 'реплика видна, но streaming не подтверждён'],
    ['unknown', 'состояние определить нельзя'],
  ]);
  const dcsField = selectField('Состояние DCS', [
    ['', 'Выберите значение'],
    ['available', 'DCS доступен'],
    ['unavailable', 'DCS недоступен'],
  ]);
  const writeField = selectField('Маршрут записи', [
    ['', 'Выберите значение'],
    ['available', 'запись доступна'],
    ['unavailable', 'запись недоступна'],
  ]);
  const redundancyField = selectField('Резервирование', [
    ['', 'Выберите значение'],
    ['available', 'есть исправная реплика'],
    ['lost', 'исправной реплики нет'],
  ]);
  const verdictField = selectField('Итоговая эксплуатационная оценка', [
    ['', 'Выберите вывод'],
    ['healthy', 'запись, резервирование и управление доступны'],
    ['degraded', 'запись доступна, но резервирование потеряно'],
    ['automation-impaired', 'запись доступна, но управление Patroni нарушено'],
    ['no-write', 'маршрут записи недоступен; требуется установить причину'],
  ]);
  const timelineLabel = element('label');
  timelineLabel.append(element('span', '', 'Текущая timeline Leader'));
  const timeline = document.createElement('input');
  timeline.type = 'text';
  timeline.inputMode = 'numeric';
  timeline.placeholder = 'Например, 7 или «не определена»';
  timelineLabel.append(timeline);

  const form = element('div', 'lab-form diagnostic-grid');
  form.append(
    leaderField.wrapper,
    replicaField.wrapper,
    replicaStateField.wrapper,
    timelineLabel,
    dcsField.wrapper,
    writeField.wrapper,
    redundancyField.wrapper,
    verdictField.wrapper,
  );
  workspace.append(form);

  const button = element('button', 'primary-button', 'Проверить диагностическую карточку');
  button.type = 'button';
  button.addEventListener('click', () => {
    const leader = clusterData.summary.leaders[0] || '';
    const members = topologyMembers();
    const replicaNode = (clusterData.nodes || []).find(node => node.name !== leader);
    const replicaMember = members.find(member => member.name !== leader);
    const replicaName = replicaMember?.name || replicaNode?.name || '';
    const replicaState = !replicaName
      ? 'unknown'
      : replicaNode && !replicaNode.reachable
        ? 'unavailable'
        : replicaMember?.state === 'streaming'
          ? 'streaming'
          : replicaMember
            ? 'other'
            : 'unknown';
    const activeTimeline = currentTimeline();
    const replicaTimeline = Number(replicaMember?.timeline);
    const timelineMatches = activeTimeline !== null
      && Number.isFinite(replicaTimeline)
      && Number(activeTimeline) === replicaTimeline;
    const redundancyAvailable = Boolean(leader && replicaMember?.state === 'streaming' && timelineMatches);
    const dcsAvailable = Boolean(clusterData.etcd?.reachable && clusterData.etcd?.health);
    const writeAvailable = Boolean(clusterData.entrypoints?.write?.available);
    const verdict = !writeAvailable
      ? 'no-write'
      : !dcsAvailable
        ? 'automation-impaired'
        : !redundancyAvailable
          ? 'degraded'
          : 'healthy';
    const expectedTimeline = activeTimeline === null ? 'не определена' : String(activeTimeline);
    const suppliedTimeline = timeline.value.trim().toLowerCase().replace('не определено', 'не определена');
    const checks = [
      [leaderField.select.value, leader || 'none', 'Leader'],
      [replicaField.select.value, replicaName || 'none', 'Replica'],
      [replicaStateField.select.value, replicaState, 'состояние репликации'],
      [suppliedTimeline, expectedTimeline, 'timeline'],
      [dcsField.select.value, dcsAvailable ? 'available' : 'unavailable', 'DCS'],
      [writeField.select.value, writeAvailable ? 'available' : 'unavailable', 'маршрут записи'],
      [redundancyField.select.value, redundancyAvailable ? 'available' : 'lost', 'резервирование'],
      [verdictField.select.value, verdict, 'итоговая оценка'],
    ];
    const mismatches = checks.filter(([actual, expected]) => actual !== expected).map(([, , label]) => label);
    if (!mismatches.length) {
      passLab(module, `Диагноз верен: Leader ${leader || 'не определён'}, реплика ${replicaName || 'не определена'}, timeline ${expectedTimeline}; DCS ${dcsAvailable ? 'доступен' : 'недоступен'}, запись ${writeAvailable ? 'доступна' : 'недоступна'}, резервирование ${redundancyAvailable ? 'сохранено' : 'потеряно'}.`);
    } else {
      labResult(workspace, `Повторно сопоставьте patronictl, DCS и маршрут записи. Требуют проверки: ${mismatches.join(', ')}. Не делайте вывод о всём кластере по одному полю.`, 'failure');
    }
  });
  workspace.append(button);
  if (state.labPassed[module.id]) labResult(workspace, 'Диагностическая карточка зачтена. Используйте тот же порядок перед каждой управляющей операцией.', 'success');
}

function renderConfigLab(module, workspace) {
  if (!clusterData) return clusterUnavailable(workspace);
  const prefix = 'PATRONICTL_NODE=db1  # замените на db2, если db1 недоступен\n';
  workspace.append(
    element('p', 'workspace-note', 'Сопоставьте динамическую конфигурацию с файлом стенда config/patroni.yml. Внутри контейнера он доступен как /etc/patroni/config.yml. Не выводите и не копируйте в отчёт пароли, ключи TLS и другие секреты.'),
    commandPanel('Прочитать динамическую конфигурацию из DCS', `${prefix}docker compose exec "$PATRONICTL_NODE" patronictl -c /etc/patroni/config.yml show-config postgresql-cluster`),
    commandPanel('Проверить структуру локального файла', `${prefix}docker compose exec "$PATRONICTL_NODE" sh -c 'grep -E "^(scope|namespace|name|restapi|etcd3|postgresql|bootstrap|watchdog|tags|log):" /etc/patroni/config.yml'`),
  );
  const sourceOptions = [
    ['', 'Выберите источник'],
    ['local', 'локальный YAML'],
    ['dynamic', 'динамическая конфигурация DCS'],
    ['environment', 'переменная окружения'],
    ['bootstrap', 'начальная bootstrap.dcs'],
  ];
  const actionOptions = [
    ['', 'Выберите изменение и применение'],
    ['yaml-reload', 'изменить YAML и выполнить reload'],
    ['yaml-restart', 'изменить YAML и заново запустить Patroni'],
    ['edit-config', 'выполнить edit-config'],
    ['environment-restart', 'изменить окружение и заново запустить Patroni'],
    ['bootstrap-only', 'учитывается только при создании кластера'],
    ['edit-config-restart', 'edit-config, затем restart PostgreSQL'],
  ];
  const settings = [
    ['name', 'Уникальное имя конкретного участника', 'local', 'yaml-restart'],
    ['restapi.connect_address', 'Адрес REST API, публикуемый участником', 'local', 'yaml-reload'],
    ['maximum_lag_on_failover', 'Общее ограничение кандидата по отставанию', 'dynamic', 'edit-config'],
    ['ttl', 'Срок действия лидерской блокировки', 'dynamic', 'edit-config'],
    ['bootstrap.dcs', 'Начальные общие правила нового кластера', 'bootstrap', 'bootstrap-only'],
    ['PATRONI_RESTAPI_PASSWORD', 'Пароль REST API, переданный при запуске', 'environment', 'environment-restart'],
    ['postgresql.parameters.shared_buffers', 'Общий параметр PostgreSQL контекста postmaster', 'dynamic', 'edit-config-restart'],
  ];
  const addOptions = (select, options) => options.forEach(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
  });
  const form = element('div', 'classification-form configuration-classification');
  settings.forEach(([key, description]) => {
    const row = element('div', 'classification-row');
    const copy = element('span');
    copy.append(element('code', '', key), element('small', '', description));
    const source = document.createElement('select');
    source.dataset.source = key;
    source.setAttribute('aria-label', `Источник параметра ${key}`);
    addOptions(source, sourceOptions);
    const action = document.createElement('select');
    action.dataset.action = key;
    action.setAttribute('aria-label', `Способ изменения параметра ${key}`);
    addOptions(action, actionOptions);
    row.append(copy, source, action);
    form.append(row);
  });
  workspace.append(form);

  const config = clusterData?.cluster?.config || {};
  const loop = config.loop_wait ?? 10;
  const retry = config.retry_timeout ?? 10;
  const ttl = config.ttl ?? 30;
  const explicit = ['loop_wait', 'retry_timeout', 'ttl'].filter(key => Object.prototype.hasOwnProperty.call(config, key));
  const defaults = ['loop_wait', 'retry_timeout', 'ttl'].filter(key => !Object.prototype.hasOwnProperty.call(config, key));
  const valid = loop + 2 * retry <= ttl;
  const invariant = element('div', `invariant ${valid ? 'valid' : 'invalid'}`);
  invariant.append(
    element('strong', '', `${loop} + 2 × ${retry} = ${loop + 2 * retry} ${valid ? '≤' : '>'} ${ttl}`),
    element('span', '', `${valid ? 'Ограничение выполнено.' : 'Ограничение нарушено.'} Явно заданы: ${explicit.join(', ') || 'нет'}; стандартные значения: ${defaults.join(', ') || 'нет'}.`),
  );
  workspace.append(invariant);

  const button = element('button', 'primary-button', 'Проверить источник и способ применения');
  button.type = 'button';
  button.addEventListener('click', () => {
    const wrongSources = [];
    const wrongActions = [];
    settings.forEach(([key, , expectedSource, expectedAction]) => {
      if (form.querySelector(`[data-source="${key}"]`).value !== expectedSource) wrongSources.push(key);
      if (form.querySelector(`[data-action="${key}"]`).value !== expectedAction) wrongActions.push(key);
    });
    if (!wrongSources.length && !wrongActions.length && valid) {
      passLab(module, 'Источники и способы применения определены верно. Вы отличили текущую конфигурацию DCS от bootstrap, локального YAML и переменных окружения.');
      return;
    }
    const messages = [];
    if (wrongSources.length) messages.push(`источник: ${wrongSources.join(', ')}`);
    if (wrongActions.length) messages.push(`изменение и применение: ${wrongActions.join(', ')}`);
    if (!valid) messages.push('ограничение loop_wait, retry_timeout и ttl');
    labResult(workspace, `Повторно проверьте: ${messages.join('; ')}. Сначала определите источник параметра, затем выберите способ изменения.`, 'failure');
  });
  workspace.append(button);
  if (state.labPassed[module.id]) labResult(workspace, 'Практикум по конфигурации зачтён. Повторяйте этот порядок для каждого нового параметра.', 'success');
}

function openDashboardControl() {
  sessionStorage.setItem('activeView', 'control');
  window.open('/?view=control', '_blank', 'noopener');
}

function renderSwitchoverLab(module, workspace) {
  if(!clusterData)return clusterUnavailable(workspace);
  const drill=state.labState[module.id] || {};
  if(!drill.phase){
    const button=element('button','primary-button','Выполнить предварительную проверку');button.type='button';button.addEventListener('click',()=>{
      if(!healthyBaseline())return labResult(workspace,'Предварительная проверка не пройдена: восстановите доступность всех узлов и потоковую репликацию.','failure');
      const oldLeader=clusterData.summary.leaders[0];const threshold=clusterData.cluster?.config?.maximum_lag_on_failover ?? 1048576;const candidate=topologyMembers().find(member=>member.name!==oldLeader&&member.state==='streaming'&&Number(member.replay_lag??member.lag??0)<=threshold);
      if(!candidate)return labResult(workspace,'Нет реплики с подходящим состоянием и отставанием в пределах maximum_lag_on_failover.','failure');
      state.labState[module.id]={phase:'baseline',oldLeader,candidate:candidate.name,baselineTimeline:currentTimeline(),startedAt:Date.now()};saveState();renderModule();
    });workspace.append(element('p','workspace-note','Курс проверит доступность узлов, наличие одного первичного сервера, состояние реплики и её отставание относительно maximum_lag_on_failover.'),button);return;
  }
  const evidence=element('dl','preflight-evidence');[['Исходный первичный сервер',drill.oldLeader],['Кандидат',drill.candidate],['Линия времени до операции',drill.baselineTimeline],['Точка записи HAProxy',clusterData.entrypoints?.write?.available?'доступна':'недоступна']].forEach(([label,value])=>{const item=element('div');item.append(element('dt','',label),element('dd','',value));evidence.append(item);});workspace.append(evidence);
  workspace.append(commandPanel('Основной способ: patronictl switchover', `docker compose exec ${drill.oldLeader} patronictl -c /etc/patroni/config.yml switchover postgresql-cluster --primary ${drill.oldLeader} --candidate ${drill.candidate} --force`));
  if(drill.phase==='complete'||state.labPassed[module.id]){
    labResult(workspace,`Переключение завершено. Новый первичный сервер — ${drill.candidate}; возвращать роль прежнему узлу только из-за его имени не требуется.`,'success');
    const repeat=element('button','secondary-button','Повторить с текущими ролями');repeat.type='button';repeat.addEventListener('click',()=>resetLabState(module));workspace.append(repeat);
    return;
  }
  const open=element('button','secondary-button','Учебная альтернатива: открыть панель ↗');open.type='button';open.addEventListener('click',openDashboardControl);
  const check=element('button','primary-button','Проверить результат переключения');check.type='button';check.addEventListener('click',()=>{
    const leader=clusterData.summary.leaders[0];const oldMember=topologyMembers().find(member=>member.name===drill.oldLeader);const timeline=Number(currentTimeline());const success=leader===drill.candidate&&clusterData.summary.reachable===clusterData.summary.configured&&oldMember?.role!=='leader'&&['streaming','running'].includes(oldMember?.state)&&timeline>Number(drill.baselineTimeline)&&clusterData.entrypoints?.write?.available;
    if(success){state.labState[module.id]={...drill,phase:'complete',newTimeline:timeline};passLab(module,`${drill.candidate} стал первичным сервером, ${drill.oldLeader} вернулся как реплика, линия времени выросла ${drill.baselineTimeline} → ${timeline}, точка записи доступна.`);renderModule();}
    else labResult(workspace,`Ожидаемый переход ещё не подтверждён: лидер ${leader||'—'}, прежний первичный сервер ${oldMember?.role||'—'}/${oldMember?.state||'—'}, линия времени ${timeline||'—'}, точка записи ${clusterData.entrypoints?.write?.available?'доступна':'недоступна'}.`,'failure');
  });
  const controls=element('div','button-row');controls.append(check,open);workspace.append(element('p','workspace-note',`Выполните показанную команду patronictl в терминале. Панель служит только для наблюдения. Не выполняйте аварийное переключение (failover): текущий первичный сервер ${drill.oldLeader} исправен.`),controls);
}

function renderRecoveryAssessmentLab(module, workspace) {
  if(!clusterData)return clusterUnavailable(workspace);
  const prefix='PATRONICTL_NODE=db1  # замените на db2, если db1 недоступен\n';
  workspace.append(commandPanel('Снимок состояния', `${prefix}docker compose exec "$PATRONICTL_NODE" patronictl -c /etc/patroni/config.yml list --extended --timestamp`));
  workspace.append(commandPanel('Топология', `${prefix}docker compose exec "$PATRONICTL_NODE" patronictl -c /etc/patroni/config.yml topology`));
  const leader=clusterData.summary.leaders[0];const members=topologyMembers();const replicas=members.filter(member=>member.name!==leader);const allReachable=clusterData.summary.reachable===clusterData.summary.configured;const replicasHealthy=replicas.length>0&&replicas.every(member=>member.state==='streaming');const dcsAvailable=Boolean(clusterData.etcd?.reachable&&clusterData.etcd?.health);const eligibleReplica=replicas.some(member=>member.state==='streaming');
  const expected=leader?(!allReachable||!replicasHealthy?'restore-replica':'observe'):!dcsAvailable?'restore-dcs':eligibleReplica?'consider-failover':'stabilize';
  const form=element('div','lab-form two-columns');
  const actionLabel=element('label');actionLabel.append(element('span','','Безопасный следующий шаг'));const action=document.createElement('select');[['','Выберите действие'],['observe','аварийная команда не нужна: продолжить наблюдение'],['restore-replica','восстановить реплику и резервирование'],['restore-dcs','сначала восстановить DCS и получить согласованные сведения'],['consider-failover','проверить изоляцию, состояние реплики и риск, затем рассмотреть failover'],['stabilize','не повышать узел: сначала найти подходящую реплику и собрать необходимые данные'],['reinit','немедленно выполнить reinit без дополнительных проверок']].forEach(([value,label])=>{const option=document.createElement('option');option.value=value;option.textContent=label;action.append(option);});actionLabel.append(action);
  const completionLabel=element('label');completionLabel.append(element('span','','Когда восстановление завершено'));const completion=document.createElement('select');[['','Выберите критерий'],['leader','появился любой Leader'],['full','один Leader, реплика streaming, текущая TL, DCS и маршруты исправны'],['container','запущены все контейнеры']].forEach(([value,label])=>{const option=document.createElement('option');option.value=value;option.textContent=label;completion.append(option);});completionLabel.append(completion);form.append(actionLabel,completionLabel);workspace.append(form);
  const button=element('button','primary-button','Проверить план');button.type='button';button.addEventListener('click',()=>{if(action.value===expected&&completion.value==='full')passLab(module,`План соответствует состоянию кластера: Leader ${leader||'не определён'}, DCS ${dcsAvailable?'доступен':'недоступен'}, доступно ${clusterData.summary.reachable} из ${clusterData.summary.configured} узлов. Перед разрушительной командой предусмотрена проверка изоляции, состояния реплики и риска потери данных.`);else labResult(workspace,`План не соответствует текущему состоянию. Leader: ${leader||'не определён'}, DCS: ${dcsAvailable?'доступен':'недоступен'}, узлов доступно ${clusterData.summary.reachable} из ${clusterData.summary.configured}. Одного отсутствия Leader недостаточно для failover.`, 'failure');});workspace.append(button);
  if(state.labPassed[module.id])labResult(workspace,'План восстановления зачтён. Лаборатория не выполняла failover или reinit автоматически.','success');
}

function renderLabWorkspace(module, workspace) {
  const renderers = {
    'identify-replication': renderIdentifyReplicationLab,
    'failover-drill': renderFailoverLab,
    'patronictl-observation': renderPatronictlObservationLab,
    'config-classification': renderConfigLab,
    'switchover-drill': renderSwitchoverLab,
    'recovery-assessment': renderRecoveryAssessmentLab,
  };
  renderers[module.lab.type](module, workspace);
}

function renderPracticalExam(module) {
  const exam = module.exam;
  const section = element('section', 'lab-section practical-exam');
  const heading = element('div', 'lab-heading');
  const headingCopy = element('div');
  headingCopy.append(element('span', 'section-label', 'ИТОГОВАЯ ПРАКТИЧЕСКАЯ РАБОТА'), element('h2', '', exam.title));
  const badge = element('span', `lab-badge ${state.examPassed[module.id] ? 'complete' : ''}`, state.examPassed[module.id] ? '✓ самопроверка завершена' : 'ожидает выполнения');
  heading.append(headingCopy, badge);
  section.append(heading, element('p', 'lab-objective', exam.objective));

  const warning = element('aside', 'lab-risk');
  warning.append(element('strong', '', 'Условия выполнения'), element('p', '', exam.conditions));
  section.append(warning);

  exam.stages.forEach((stage, index) => {
    const block = element('article', 'exam-stage');
    block.append(element('span', 'section-label', `ЭТАП ${index + 1}`), element('h3', '', stage.title), element('p', '', stage.task));
    const criteria = element('ul', 'exam-criteria');
    stage.criteria.forEach(item => criteria.append(element('li', '', item)));
    block.append(criteria);
    if (stage.evidence?.length) {
      block.append(element('strong', 'exam-evidence-title', 'Что сохранить для самопроверки'));
      const evidence = element('ul', 'exam-evidence');
      stage.evidence.forEach(item => evidence.append(element('li', '', item)));
      block.append(evidence);
    }
    section.append(block);
  });

  const acceptance = element('div', 'lab-workspace exam-acceptance');
  acceptance.append(element('h3', '', 'Итоговая самопроверка'), element('p', '', 'Отметьте пункт только после выполнения действия и сохранения подтверждения. Успех определяется фактическим состоянием кластера, а не самими отметками.'));
  const form = element('form', 'exam-checklist');
  exam.acceptance.forEach((item, index) => {
    const label = element('label', 'exam-check');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = `acceptance-${index}`;
    label.append(input, element('span', '', item));
    form.append(label);
  });
  const submit = element('button', 'primary-button', 'Отметить практику завершённой');
  submit.type = 'submit';
  form.append(submit);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const checks = [...form.querySelectorAll('input[type="checkbox"]')];
    if (!checks.every(input => input.checked)) {
      showToast('Подтвердите выполнение всех обязательных этапов', 'warning');
      return;
    }
    state.examPassed[module.id] = true;
    saveState();
    showToast('Итоговая практика отмечена как выполненная', 'success');
    renderModule();
  });
  acceptance.append(form);
  section.append(acceptance);
  return section;
}

function renderExplorationBridge(module) {
  const route = explorationRoutes[module.id];
  if (!route) return null;
  const section = element('aside', 'exploration-bridge');
  const copy = element('div');
  copy.append(element('span', 'section-label', 'ИССЛЕДОВАНИЕ НА СТЕНДЕ'), element('strong', '', 'Найдите изученное в работающем кластере'), element('p', '', 'Панель показывает текущее состояние и помогает наблюдать причинно-следственные связи. Она дополняет объяснение модуля, но не заменяет его.'));
  const link = element('a', 'secondary-button link-button', `${route.label} →`);
  link.href = route.href;
  section.append(copy, link);
  return section;
}

function updateModuleCompletion(module) {
  const panel = lesson.querySelector('.module-completion');
  if (!panel) return;
  const done = moduleComplete(module);
  panel.className = `module-completion ${done ? 'complete' : ''}`;
  panel.querySelector('[data-completion]').classList.toggle('done', done);
  panel.querySelector('strong').textContent = done ? 'Модуль пройден' : 'Чтобы завершить модуль';
  panel.querySelector('p').textContent = module.kind === 'practical-exam'
    ? (done ? 'Все этапы практического экзамена отмечены как выполненные.' : 'Выполните все испытания и убедитесь, что кластер вернулся в исправное состояние.')
    : (done ? 'Проверочный тест пройден.' : 'Ответьте правильно на все вопросы проверочного теста.');
}

function renderModuleFooter(module) {
  const wrapper = element('section', 'module-footer');
  const completion = element('div', 'module-completion');
  const itemLabel = module.kind === 'practical-exam' ? 'Итоговая практика' : 'Проверочный тест';
  completion.innerHTML = `<div><strong></strong><p></p></div><div class="completion-items"><span data-completion="module">${itemLabel}</span></div>`;
  wrapper.append(completion);
  const done = moduleComplete(module);
  completion.classList.toggle('complete', done);
  completion.querySelector('[data-completion]').classList.toggle('done', done);
  completion.querySelector('strong').textContent = done ? 'Модуль пройден' : 'Чтобы завершить модуль';
  completion.querySelector('p').textContent = module.kind === 'practical-exam'
    ? (done ? 'Все этапы практического экзамена отмечены как выполненные.' : 'Выполните все испытания и убедитесь, что кластер вернулся в исправное состояние.')
    : (done ? 'Проверочный тест пройден.' : 'Ответьте правильно на все вопросы проверочного теста.');
  const navigation = element('div', 'lesson-navigation');
  const index = course.modules.findIndex(item => item.id === module.id);
  if (index > 0) {
    const previous = element('button', 'secondary-button', `← ${course.modules[index - 1].shortTitle}`);
    previous.addEventListener('click', () => selectModule(course.modules[index - 1].id));
    navigation.append(previous);
  }
  if (index < course.modules.length - 1) {
    const next = element('button', 'primary-button', `${course.modules[index + 1].shortTitle} →`);
    next.addEventListener('click', () => selectModule(course.modules[index + 1].id));
    navigation.append(next);
  } else {
    const dashboard = element('a', 'primary-button link-button', 'Перейти к панели состояния →');
    dashboard.href = '/';
    navigation.append(dashboard);
  }
  wrapper.append(navigation);
  return wrapper;
}

async function loadModule(moduleId) {
  if (moduleCache.has(moduleId)) return moduleCache.get(moduleId);
  const descriptor = course.modules.find(item => item.id === moduleId) || course.modules[0];
  const response = await fetch(descriptor.source, {cache: 'no-store'});
  if (!response.ok) throw new Error(`Не удалось загрузить модуль ${descriptor.id}: HTTP ${response.status}`);
  const module = await response.json();
  moduleCache.set(module.id, module);
  return module;
}

async function renderModule() {
  const requestedId = state.activeModule;
  lesson.replaceChildren(element('div', 'lesson-loading', 'Загружаем учебный модуль…'));
  let module;
  try {
    module = await loadModule(requestedId);
  } catch (error) {
    lesson.replaceChildren(element('div', 'lab-result failure', error.message));
    return;
  }
  if (state.activeModule !== requestedId) return;
  lesson.replaceChildren();
  lesson.append(renderModuleHeader(module));
  const content = element('div', 'lesson-content');
  module.sections.forEach((section, index) => content.append(renderLearningSection(section, index)));
  const parts = [content, renderDocumentation(module)];
  const exploration = renderExplorationBridge(module);
  if (exploration) parts.push(exploration);
  if (module.kind === 'practical-exam') parts.push(renderPracticalExam(module));
  else parts.push(renderQuiz(module));
  parts.push(renderModuleFooter(module));
  lesson.append(...parts);
}

function renderLiveCluster() {
  const panel = document.querySelector('#live-cluster');
  if (!clusterData) {
    panel.classList.add('offline');
    document.querySelector('#live-updated').textContent = 'API недоступен';
    return;
  }
  panel.classList.remove('offline');
  const members = topologyMembers();
  const replicas = members.filter(member => member.role !== 'leader');
  const lags = replicas.map(member => Number(member.replay_lag ?? member.lag)).filter(Number.isFinite);
  document.querySelector('#live-primary').textContent = clusterData.summary.leaders.join(', ') || 'не определена';
  document.querySelector('#live-nodes').textContent = `${clusterData.summary.reachable} / ${clusterData.summary.configured}`;
  document.querySelector('#live-replication').textContent = replicas.length && replicas.every(member => ['streaming','running'].includes(member.state)) ? 'потоковая' : replicas.length ? 'требует внимания' : 'нет реплик';
  document.querySelector('#live-lag').textContent = lags.length ? formatBytes(Math.max(...lags)) : '—';
  document.querySelector('#live-updated').textContent = `опрос ${new Date(clusterData.collected_at * 1000).toLocaleTimeString()}`;
}

async function refreshCluster() {
  if (clusterRequestInFlight) return;
  clusterRequestInFlight = true;
  try {
    const response = await fetch('/api/cluster', {cache:'no-store'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    clusterData = await response.json();
  } catch (_) {
    clusterData = null;
  } finally {
    clusterRequestInFlight = false;
    renderLiveCluster();
  }
}

function renderGlossary() {
  const list = document.querySelector('#glossary-list');
  course.glossary.forEach(([term, definition]) => {
    const item = element('div', 'glossary-item');
    item.append(element('dt', '', term), element('dd', '', definition));
    list.append(item);
  });
}

function bindInterfaceEvents() {
  document.querySelectorAll('.open-glossary').forEach(button => button.addEventListener('click', () => document.querySelector('#glossary-dialog').showModal()));
  document.querySelector('#close-glossary').addEventListener('click', () => document.querySelector('#glossary-dialog').close());
  document.querySelector('#glossary-dialog').addEventListener('click', event => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
  document.querySelector('#reset-progress').addEventListener('click', async () => {
  if (!window.confirm('Сбросить ответы, отметку практического экзамена и прогресс курса? Состояние кластера изменено не будет.')) return;
  state = defaultState();
  history.replaceState(null, '', `/course.html?module=${state.activeModule}`);
  saveState();
  await renderModule();
  showToast('Учебный прогресс сброшен. Кластер не изменялся.', 'success');
  });
}

async function loadCourse() {
  const manifestResponse = await fetch('/course/course-manifest.json', {cache: 'no-store'});
  if (!manifestResponse.ok) throw new Error(`HTTP ${manifestResponse.status}`);
  const manifest = await manifestResponse.json();
  const glossaryResponse = await fetch(manifest.glossary, {cache: 'no-store'});
  if (!glossaryResponse.ok) throw new Error(`HTTP ${glossaryResponse.status}`);
  return {...manifest, glossary: await glossaryResponse.json()};
}

async function initialize() {
  try {
    course = await loadCourse();
  } catch (error) {
    lesson.replaceChildren(element('div', 'lab-result failure', `Не удалось загрузить содержание курса: ${error.message}`));
    return;
  }
  stateKey = `patroni-course-progress-v${course.version}`;
  state = loadState();
  bindInterfaceEvents();
  const requestedModule = new URLSearchParams(window.location.search).get('module');
  if (course.modules.some(module => module.id === requestedModule)) state.activeModule = requestedModule;
  if (!course.modules.some(module => module.id === state.activeModule)) state.activeModule = course.modules[0].id;
  renderGlossary();
  renderNavigation();
  renderOverallProgress();
  await refreshCluster();
  await renderModule();
  setInterval(refreshCluster, 3000);
}

initialize();
