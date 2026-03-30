const state = {
  manifest: [],
  strategies: [],
  selectedStrategy: null,
  paths: [],
  selectedPath: null,
  nodes: [],
  events: [],
  validation: null,
  analysis: {
    analyzePath: null,
    probabilityToReachGoal: null,
    expectedStepsToGoal: null,
    expectedStateDelta: null,
    hittingTimeDistribution: null,
    distributionAtStep: null,
  },
  callLog: [],
};

const els = {
  strategyList: document.getElementById('strategy-list'),
  strategiesEmpty: document.getElementById('strategies-empty'),
  pathList: document.getElementById('path-list'),
  validationSummary: document.getElementById('validation-summary'),
  validationIssues: document.getElementById('validation-issues'),
  graphCanvas: document.getElementById('graph-canvas'),
  graphEmpty: document.getElementById('graph-empty'),
  graphTitle: document.getElementById('graph-title'),
  graphBadges: document.getElementById('graph-badges'),
  nodeTableBody: document.getElementById('node-table-body'),
  eventTableBody: document.getElementById('event-table-body'),
  analysisMetrics: document.getElementById('analysis-metrics'),
  analysisTableWrap: document.getElementById('analysis-table-wrap'),
  hittingTimeChart: document.getElementById('hitting-time-chart'),
  stepDistributionChart: document.getElementById('step-distribution-chart'),
  callReference: document.getElementById('call-reference'),
  callLog: document.getElementById('call-log'),
  toastRoot: document.getElementById('toast-root'),
  strategyForm: document.getElementById('strategy-form'),
  pathForm: document.getElementById('path-form'),
  nodeForm: document.getElementById('node-form'),
  eventForm: document.getElementById('event-form'),
  analysisMaxSteps: document.getElementById('analysis-max-steps'),
  analysisStep: document.getElementById('analysis-step'),
  nodeId: document.getElementById('node-id'),
  nodeName: document.getElementById('node-name'),
  nodeKind: document.getElementById('node-kind'),
  nodeNote: document.getElementById('node-note'),
  nodeSubmitButton: document.getElementById('node-submit-button'),
  nodeDeleteButton: document.getElementById('node-delete-button'),
  eventId: document.getElementById('event-id'),
  eventName: document.getElementById('event-name'),
  eventFrom: document.getElementById('event-from'),
  eventTo: document.getElementById('event-to'),
  eventProbability: document.getElementById('event-probability'),
  eventStateDelta: document.getElementById('event-state-delta'),
  eventReason: document.getElementById('event-reason'),
  eventSubmitButton: document.getElementById('event-submit-button'),
  eventDeleteButton: document.getElementById('event-delete-button'),
};

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function showToast(message, type = 'info') {
  const item = document.createElement('div');
  item.className = 'toast';
  if (type === 'error') {
    item.style.background = 'rgba(187, 87, 70, 0.95)';
  }
  item.textContent = message;
  els.toastRoot.appendChild(item);
  setTimeout(() => {
    item.style.opacity = '0';
    item.style.transform = 'translateY(6px)';
    setTimeout(() => item.remove(), 180);
  }, 2400);
}

function addLogEntry(call) {
  const entry = {
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    time: new Date(),
    call,
    status: 'pending',
    result: null,
    error: null,
  };
  state.callLog.unshift(entry);
  renderCallLog();
  return entry;
}

function updateLogEntry(entry, patch) {
  Object.assign(entry, patch);
  renderCallLog();
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

function formatCall(name, args) {
  return `${name}(${args.map((arg) => {
    if (typeof arg === 'string') return JSON.stringify(arg);
    return formatJson(arg);
  }).join(', ')})`;
}

const api = {
  async getManifest() {
    const payload = await requestJson('/api/manifest');
    return payload.calls || [];
  },

  async call(name, args = []) {
    const call = formatCall(name, args);
    const logEntry = addLogEntry(call);
    try {
      const payload = await requestJson('/api/call', {
        method: 'POST',
        body: JSON.stringify({ name, args }),
      });
      updateLogEntry(logEntry, {
        status: 'success',
        result: payload.result,
      });
      return payload.result;
    } catch (error) {
      updateLogEntry(logEntry, {
        status: 'error',
        error: error.message,
      });
      throw error;
    }
  },
};

function selectedStrategyId() {
  return state.selectedStrategy?.id || null;
}

function selectedPathId() {
  return state.selectedPath?.id || null;
}

function nodeStats() {
  const stats = new Map();
  for (const node of state.nodes) {
    stats.set(node.id, { outgoingProbability: 0, outgoingCount: 0, incomingCount: 0 });
  }
  for (const event of state.events) {
    const source = stats.get(event.fromNodeId);
    const target = stats.get(event.toNodeId);
    if (source) {
      source.outgoingProbability += Number(event.probability || 0);
      source.outgoingCount += 1;
    }
    if (target) {
      target.incomingCount += 1;
    }
  }
  return stats;
}

function reachableNodeIds() {
  if (!state.selectedPath) return new Set();
  const reachable = new Set([state.selectedPath.rootNodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const event of state.events) {
      if (reachable.has(event.fromNodeId) && !reachable.has(event.toNodeId)) {
        reachable.add(event.toNodeId);
        changed = true;
      }
    }
  }
  return reachable;
}

function getNodeById(nodeId) {
  return state.nodes.find((node) => node.id === nodeId) || null;
}

function ensureSelection() {
  if (state.selectedStrategy && !state.strategies.some((item) => item.id === state.selectedStrategy.id)) {
    state.selectedStrategy = null;
  }
  if (state.selectedPath && !state.paths.some((item) => item.id === state.selectedPath.id)) {
    state.selectedPath = null;
  }
}

async function loadStrategies(preferredStrategyId) {
  state.strategies = await api.call('strategy.strategies.list', []);
  if (preferredStrategyId) {
    state.selectedStrategy = state.strategies.find((item) => item.id === preferredStrategyId) || null;
  } else if (!state.selectedStrategy && state.strategies.length > 0) {
    state.selectedStrategy = state.strategies[0];
  } else if (state.selectedStrategy) {
    state.selectedStrategy = state.strategies.find((item) => item.id === state.selectedStrategy.id) || state.strategies[0] || null;
  }
  ensureSelection();
  renderStrategies();
}

async function loadStrategy(strategyId, preferredPathId) {
  state.selectedStrategy = await api.call('strategy.strategies.get', [strategyId]);
  state.paths = await api.call('strategy.paths.list', [strategyId]);
  if (preferredPathId) {
    state.selectedPath = state.paths.find((path) => path.id === preferredPathId) || null;
  } else if (state.selectedPath) {
    state.selectedPath = state.paths.find((path) => path.id === state.selectedPath.id) || null;
  } else {
    state.selectedPath = state.paths[0] || null;
  }
  renderStrategies();
  renderPaths();

  if (state.selectedPath) {
    await loadPath(strategyId, state.selectedPath.id);
  } else {
    state.nodes = [];
    state.events = [];
    state.validation = null;
    resetAnalysis();
    resetNodeForm();
    resetEventForm();
    renderPathView();
  }
}

async function loadPath(strategyId, pathId) {
  state.selectedPath = await api.call('strategy.paths.get', [strategyId, pathId]);
  state.nodes = await api.call('strategy.nodes.list', [strategyId, pathId]);
  state.events = await api.call('strategy.events.list', [strategyId, pathId]);
  state.validation = await api.call('strategy.paths.validate', [strategyId, pathId]);
  resetAnalysis();
  if (els.nodeId.value && !state.nodes.some((node) => node.id === els.nodeId.value)) {
    resetNodeForm();
  }
  if (els.eventId.value && !state.events.some((event) => event.id === els.eventId.value)) {
    resetEventForm();
  }
  renderPaths();
  renderPathView();
}

function resetAnalysis() {
  state.analysis = {
    analyzePath: null,
    probabilityToReachGoal: null,
    expectedStepsToGoal: null,
    expectedStateDelta: null,
    hittingTimeDistribution: null,
    distributionAtStep: null,
  };
  renderAnalysis();
}

function resetNodeForm() {
  els.nodeForm.reset();
  els.nodeId.value = '';
  const rootOption = els.nodeKind.querySelector('option[value="root"]');
  if (rootOption) {
    rootOption.remove();
  }
  els.nodeKind.disabled = false;
  els.nodeSubmitButton.textContent = 'Add node';
  els.nodeDeleteButton.classList.add('hidden');
  renderPathView();
}

function resetEventForm() {
  els.eventForm.reset();
  els.eventId.value = '';
  els.eventSubmitButton.textContent = 'Add event';
  els.eventDeleteButton.classList.add('hidden');
  populateEventNodeOptions();
  renderPathView();
}

function populateNodeForm(node) {
  els.nodeId.value = node.id;
  els.nodeName.value = node.name || '';
  let rootOption = els.nodeKind.querySelector('option[value="root"]');
  if (node.kind === 'root' && !rootOption) {
    rootOption = document.createElement('option');
    rootOption.value = 'root';
    rootOption.textContent = 'root (locked)';
    els.nodeKind.prepend(rootOption);
  }
  if (node.kind !== 'root' && rootOption) {
    rootOption.remove();
  }
  els.nodeKind.value = node.kind;
  els.nodeNote.value = node.note || '';
  els.nodeKind.disabled = node.kind === 'root';
  els.nodeSubmitButton.textContent = 'Save node';
  els.nodeDeleteButton.classList.toggle('hidden', node.kind === 'root');
  renderPathView();
}

function populateEventForm(event) {
  els.eventId.value = event.id;
  els.eventName.value = event.name || '';
  populateEventNodeOptions();
  els.eventFrom.value = event.fromNodeId;
  els.eventTo.value = event.toNodeId;
  els.eventProbability.value = String(event.probability);
  els.eventStateDelta.value = String(event.stateDelta);
  els.eventReason.value = event.reason || '';
  els.eventSubmitButton.textContent = 'Save event';
  els.eventDeleteButton.classList.remove('hidden');
  renderPathView();
}

function selectedNodeId() {
  return els.nodeId.value || null;
}

function selectedEventId() {
  return els.eventId.value || null;
}

function populateEventNodeOptions() {
  const options = state.nodes
    .map((node) => `<option value="${escapeHtml(node.id)}">${escapeHtml(node.name)} (${escapeHtml(node.kind)})</option>`)
    .join('');
  els.eventFrom.innerHTML = options;
  els.eventTo.innerHTML = options;
}

function renderStrategies() {
  els.strategiesEmpty.classList.toggle('hidden', state.strategies.length > 0);
  els.strategyList.innerHTML = '';

  for (const strategy of state.strategies) {
    const card = document.createElement('article');
    card.className = `entity-card${state.selectedStrategy?.id === strategy.id ? ' active' : ''}`;
    card.innerHTML = `
      <header>
        <div>
          <h3>${escapeHtml(strategy.name)}</h3>
          <div class="micro">${escapeHtml(strategy.id)}</div>
        </div>
        <button class="ghost-button compact danger">Delete</button>
      </header>
      <p>${escapeHtml(strategy.description || 'No description')}</p>
      <div class="micro">${strategy.pathCount} paths</div>
    `;

    card.addEventListener('click', async (event) => {
      if (event.target.closest('button')) return;
      try {
        await loadStrategy(strategy.id);
        showToast(`Loaded strategy "${strategy.name}"`);
      } catch (error) {
        showToast(error.message, 'error');
      }
    });

    card.querySelector('button').addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!confirm(`Delete strategy "${strategy.name}"?`)) return;
      try {
        await api.call('strategy.strategies.remove', [strategy.id]);
        if (state.selectedStrategy?.id === strategy.id) {
          state.selectedStrategy = null;
          state.selectedPath = null;
          state.nodes = [];
          state.events = [];
          state.validation = null;
          resetAnalysis();
        }
        await loadStrategies();
        if (state.selectedStrategy) {
          await loadStrategy(state.selectedStrategy.id);
        } else {
          renderPaths();
          renderPathView();
        }
        showToast(`Deleted "${strategy.name}"`);
      } catch (error) {
        showToast(error.message, 'error');
      }
    });

    els.strategyList.appendChild(card);
  }
}

function renderPaths() {
  els.pathList.innerHTML = '';
  for (const path of state.paths) {
    const card = document.createElement('article');
    card.className = `entity-card${state.selectedPath?.id === path.id ? ' active' : ''}`;
    card.innerHTML = `
      <header>
        <div>
          <h3>${escapeHtml(path.name)}</h3>
          <div class="micro">${escapeHtml(path.id)}</div>
        </div>
      </header>
      <p>${escapeHtml(path.description || 'No description')}</p>
      <div class="micro">${path.nodeCount} nodes · ${path.eventCount} events</div>
    `;
    card.addEventListener('click', async () => {
      if (!state.selectedStrategy) return;
      try {
        await loadPath(state.selectedStrategy.id, path.id);
        showToast(`Loaded path "${path.name}"`);
      } catch (error) {
        showToast(error.message, 'error');
      }
    });
    els.pathList.appendChild(card);
  }
}

function renderValidation() {
  if (!state.selectedPath) {
    els.validationSummary.textContent = 'Select a path to validate it.';
    els.validationSummary.className = 'validation-summary';
    els.validationIssues.innerHTML = '';
    return;
  }

  if (!state.validation) {
    els.validationSummary.textContent = 'Validation not run yet.';
    els.validationSummary.className = 'validation-summary';
    els.validationIssues.innerHTML = '';
    return;
  }

  els.validationSummary.className = `validation-summary ${state.validation.valid ? 'good' : 'bad'}`;
  els.validationSummary.textContent = state.validation.valid
    ? 'Path is valid. Probabilities and terminal constraints pass.'
    : `Path is invalid. ${state.validation.issues.length} issue(s) found.`;

  els.validationIssues.innerHTML = state.validation.issues
    .map((issue) => `<li>${escapeHtml(issue)}</li>`)
    .join('');
}

function formatPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

function formatMaybeNumber(value) {
  if (value === null || typeof value === 'undefined') return '—';
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return value.toFixed(3);
}

function renderMetrics() {
  const analyzePath = state.analysis.analyzePath;
  const metricCards = [
    {
      label: 'Success probability',
      value: state.analysis.probabilityToReachGoal ?? analyzePath?.probabilityReachGoal,
      formatter: formatPercent,
    },
    {
      label: 'Expected steps',
      value: state.analysis.expectedStepsToGoal ?? analyzePath?.expectedStepsToGoal,
      formatter: formatMaybeNumber,
    },
    {
      label: 'Expected state delta',
      value: state.analysis.expectedStateDelta ?? analyzePath?.expectedCumulativeStateDelta,
      formatter: formatMaybeNumber,
    },
    {
      label: 'Unresolved mass',
      value: analyzePath?.unresolvedProbability,
      formatter: formatPercent,
    },
  ];

  els.analysisMetrics.innerHTML = metricCards
    .map((metric) => `
      <div class="metric-card">
        <strong>${metric.formatter(metric.value)}</strong>
        <span>${escapeHtml(metric.label)}</span>
      </div>
    `)
    .join('');
}

function renderBars(container, items, formatter) {
  if (!items || items.length === 0) {
    container.classList.add('empty-bars');
    container.textContent = 'No data yet.';
    return;
  }

  container.classList.remove('empty-bars');
  const max = Math.max(...items.map((item) => item.value), 0.0001);
  container.innerHTML = items.map((item) => `
    <div class="bar-row">
      <div class="bar-label">${escapeHtml(item.label)}</div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${Math.max(4, (item.value / max) * 100)}%"></div>
      </div>
      <div class="bar-value">${escapeHtml(formatter(item.value))}</div>
    </div>
  `).join('');
}

function renderAnalysisTable() {
  const analyzePath = state.analysis.analyzePath;
  if (!analyzePath?.stepDistributions?.length) {
    els.analysisTableWrap.innerHTML = '';
    return;
  }

  els.analysisTableWrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Step</th>
          <th>Goal</th>
          <th>Fail</th>
          <th>Unresolved</th>
          <th>Step delta</th>
          <th>Cumulative delta</th>
        </tr>
      </thead>
      <tbody>
        ${analyzePath.stepDistributions.map((row) => `
          <tr>
            <td>${row.step}</td>
            <td>${formatPercent(row.probabilityReachGoal)}</td>
            <td>${formatPercent(row.probabilityReachFail)}</td>
            <td>${formatPercent(row.unresolvedProbability)}</td>
            <td>${formatMaybeNumber(row.expectedStepStateDelta)}</td>
            <td>${formatMaybeNumber(row.cumulativeExpectedStateDelta)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderAnalysis() {
  renderMetrics();
  const analyzePath = state.analysis.analyzePath;
  const hitting = state.analysis.hittingTimeDistribution
    || analyzePath?.hittingTimeGoal
    || [];
  renderBars(
    els.hittingTimeChart,
    hitting.map((item) => ({ label: `step ${item.step}`, value: item.probability })),
    formatPercent
  );

  const distribution = state.analysis.distributionAtStep?.nodeProbabilities || [];
  renderBars(
    els.stepDistributionChart,
    distribution.map((item) => ({ label: item.nodeName, value: item.probability })),
    formatPercent
  );

  renderAnalysisTable();
}

function renderReference() {
  els.callReference.innerHTML = state.manifest.map((item) => `
    <article class="reference-item">
      <h3>${escapeHtml(item.name)}</h3>
      <p><strong>${escapeHtml(item.group)}</strong> · ${escapeHtml(item.summary)}</p>
    </article>
  `).join('');
}

function renderCallLog() {
  if (state.callLog.length === 0) {
    els.callLog.innerHTML = '<div class="empty-callout">Every API call will appear here with the exact <code>strategy.*</code> invocation.</div>';
    return;
  }

  els.callLog.innerHTML = state.callLog.map((entry) => `
    <article class="log-entry ${entry.status}">
      <div class="log-meta">
        <span>${escapeHtml(entry.time.toLocaleTimeString())}</span>
        <span>${escapeHtml(entry.status.toUpperCase())}</span>
      </div>
      <pre class="log-call">${escapeHtml(entry.call)}</pre>
      ${entry.error ? `<pre>${escapeHtml(entry.error)}</pre>` : ''}
      ${entry.result !== null ? `
        <details>
          <summary>result</summary>
          <pre>${escapeHtml(formatJson(entry.result))}</pre>
        </details>
      ` : ''}
    </article>
  `).join('');
}

function layoutGraph() {
  if (!state.selectedPath) {
    return null;
  }

  const outgoing = new Map();
  for (const node of state.nodes) {
    outgoing.set(node.id, []);
  }
  for (const event of state.events) {
    const bucket = outgoing.get(event.fromNodeId) || [];
    bucket.push(event);
    outgoing.set(event.fromNodeId, bucket);
  }

  const levels = new Map([[state.selectedPath.rootNodeId, 0]]);
  const queue = [state.selectedPath.rootNodeId];
  let head = 0;

  while (head < queue.length) {
    const currentId = queue[head++];
    const currentLevel = levels.get(currentId) || 0;
    for (const event of outgoing.get(currentId) || []) {
      if (!levels.has(event.toNodeId)) {
        levels.set(event.toNodeId, currentLevel + 1);
        queue.push(event.toNodeId);
      }
    }
  }

  let maxLevel = Math.max(0, ...levels.values());
  for (const node of state.nodes) {
    if (!levels.has(node.id)) {
      maxLevel += 1;
      levels.set(node.id, maxLevel);
    }
  }

  const levelBuckets = new Map();
  for (const node of state.nodes) {
    const level = levels.get(node.id) || 0;
    const bucket = levelBuckets.get(level) || [];
    bucket.push(node);
    levelBuckets.set(level, bucket);
  }

  const widestColumn = Math.max(1, ...Array.from(levelBuckets.values()).map((items) => items.length));
  const width = Math.max(980, (maxLevel + 1) * 260 + 260);
  const height = Math.max(520, widestColumn * 150 + 140);
  const positions = new Map();

  for (const [level, bucket] of Array.from(levelBuckets.entries()).sort((a, b) => a[0] - b[0])) {
    bucket.sort((left, right) => {
      const kindOrder = { root: 0, intermediate: 1, goal: 2, fail: 3 };
      return (kindOrder[left.kind] - kindOrder[right.kind]) || left.name.localeCompare(right.name);
    });
    const x = 140 + level * 240;
    const step = height / (bucket.length + 1);
    bucket.forEach((node, index) => {
      positions.set(node.id, {
        x,
        y: Math.round(step * (index + 1)),
      });
    });
  }

  return { width, height, positions };
}

function buildGraphMarkup() {
  if (!state.selectedPath || state.nodes.length === 0) {
    return { width: 0, height: 0, markup: '' };
  }

  const layout = layoutGraph();
  if (!layout) {
    return { width: 0, height: 0, markup: '' };
  }

  const stats = nodeStats();
  const reachable = reachableNodeIds();
  const selectedNode = selectedNodeId();
  const selectedEvent = selectedEventId();
  const nodeRect = { width: 182, height: 62 };
  const pairCounts = new Map();
  const edgeCurves = new Map();

  for (const event of state.events) {
    const key = `${event.fromNodeId}__${event.toNodeId}`;
    const count = pairCounts.get(key) || 0;
    pairCounts.set(key, count + 1);
  }

  const pairSeen = new Map();
  for (const event of state.events) {
    const key = `${event.fromNodeId}__${event.toNodeId}`;
    const total = pairCounts.get(key) || 1;
    const index = pairSeen.get(key) || 0;
    pairSeen.set(key, index + 1);
    edgeCurves.set(event.id, total === 1 ? 0 : (index - (total - 1) / 2) * 26);
  }

  const edgesMarkup = state.events.map((event) => {
    const source = layout.positions.get(event.fromNodeId);
    const target = layout.positions.get(event.toNodeId);
    if (!source || !target) return '';
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const distance = Math.sqrt((dx * dx) + (dy * dy)) || 1;
    const normalX = -dy / distance;
    const normalY = dx / distance;
    const curve = edgeCurves.get(event.id) || 0;
    const sourceX = source.x + nodeRect.width / 2 - 10;
    const sourceY = source.y;
    const targetX = target.x - nodeRect.width / 2 + 10;
    const targetY = target.y;
    const controlX = (sourceX + targetX) / 2 + normalX * curve;
    const controlY = (sourceY + targetY) / 2 + normalY * curve;
    const labelX = (sourceX + 2 * controlX + targetX) / 4;
    const labelY = (sourceY + 2 * controlY + targetY) / 4 - 8;
    const sourceStats = stats.get(event.fromNodeId);
    const invalid = sourceStats && Math.abs(sourceStats.outgoingProbability - 1) > 1e-9;
    return `
      <g data-event-id="${escapeHtml(event.id)}">
        <path
          class="graph-edge${selectedEvent === event.id ? ' selected' : ''}${invalid ? ' invalid' : ''}"
          data-event-id="${escapeHtml(event.id)}"
          d="M ${sourceX} ${sourceY} Q ${controlX} ${controlY} ${targetX} ${targetY}"
          marker-end="url(#graph-arrow)"
        ></path>
        <text
          class="graph-edge-label"
          data-event-id="${escapeHtml(event.id)}"
          x="${labelX}"
          y="${labelY}"
        >${escapeHtml(`${event.name} · p=${Number(event.probability).toFixed(2)} · Δ${Number(event.stateDelta) >= 0 ? '+' : ''}${Number(event.stateDelta).toFixed(2)}`)}</text>
      </g>
    `;
  }).join('');

  const nodesMarkup = state.nodes.map((node) => {
    const position = layout.positions.get(node.id);
    const stat = stats.get(node.id) || { outgoingProbability: 0, outgoingCount: 0, incomingCount: 0 };
    const unreachable = !reachable.has(node.id);
    const isSelected = selectedNode === node.id;
    const warning = node.kind !== 'goal' && node.kind !== 'fail' && stat.outgoingCount > 0 && Math.abs(stat.outgoingProbability - 1) > 1e-9;
    const noteLine = node.note ? escapeHtml(node.note).slice(0, 28) : (unreachable ? 'unreachable from root' : `${stat.outgoingCount} outgoing event(s)`);
    return `
      <g
        class="graph-node ${escapeHtml(node.kind)}${isSelected ? ' selected' : ''}"
        data-node-id="${escapeHtml(node.id)}"
        transform="translate(${position.x - nodeRect.width / 2}, ${position.y - nodeRect.height / 2})"
      >
        <rect rx="22" ry="22" width="${nodeRect.width}" height="${nodeRect.height}" ${warning ? 'style="stroke:#a4681d;stroke-width:2.3"' : ''}></rect>
        <text class="graph-node-label" x="18" y="24">${escapeHtml(node.name)}</text>
        <text class="graph-node-meta" x="18" y="42">${escapeHtml(`${node.kind} · out=${stat.outgoingProbability.toFixed(2)}${unreachable ? ' · unreachable' : ''}`)}</text>
        <text class="graph-node-meta" x="18" y="56">${noteLine}</text>
      </g>
    `;
  }).join('');

  return {
    width: layout.width,
    height: layout.height,
    markup: `
      <defs>
        <marker id="graph-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(32, 50, 53, 0.55)"></path>
        </marker>
      </defs>
      ${edgesMarkup}
      ${nodesMarkup}
    `,
  };
}

function renderGraphBadges() {
  if (!state.selectedPath) {
    els.graphBadges.innerHTML = '';
    return;
  }

  const reachable = reachableNodeIds();
  const goalCount = state.nodes.filter((node) => node.kind === 'goal').length;
  const failCount = state.nodes.filter((node) => node.kind === 'fail').length;
  const unreachableCount = state.nodes.filter((node) => !reachable.has(node.id)).length;
  const badges = [
    `${state.nodes.length} nodes`,
    `${state.events.length} events`,
    `${goalCount} goal`,
    `${failCount} fail`,
    `${unreachableCount} unreachable`,
  ];
  els.graphBadges.innerHTML = badges.map((label) => `<span class="graph-badge">${escapeHtml(label)}</span>`).join('');
}

function renderNodeTable() {
  const stats = nodeStats();
  const selected = selectedNodeId();
  els.nodeTableBody.innerHTML = state.nodes.map((node) => {
    const stat = stats.get(node.id) || { outgoingProbability: 0 };
    return `
      <tr data-node-id="${escapeHtml(node.id)}" class="${selected === node.id ? 'active' : ''}">
        <td>
          <strong>${escapeHtml(node.name)}</strong>
          <div class="micro">${escapeHtml(node.id)}</div>
        </td>
        <td>${escapeHtml(node.kind)}</td>
        <td>${stat.outgoingProbability.toFixed(2)}</td>
      </tr>
    `;
  }).join('');

  for (const row of els.nodeTableBody.querySelectorAll('tr[data-node-id]')) {
    row.addEventListener('click', () => {
      const node = getNodeById(row.dataset.nodeId);
      if (node) populateNodeForm(node);
    });
  }
}

function renderEventTable() {
  const selected = selectedEventId();
  els.eventTableBody.innerHTML = state.events.map((event) => {
    const fromNode = getNodeById(event.fromNodeId);
    const toNode = getNodeById(event.toNodeId);
    return `
      <tr data-event-id="${escapeHtml(event.id)}" class="${selected === event.id ? 'active' : ''}">
        <td>
          <strong>${escapeHtml(event.name)}</strong>
          <div class="micro">${escapeHtml(`${fromNode?.name || event.fromNodeId} → ${toNode?.name || event.toNodeId}`)}</div>
        </td>
        <td>${Number(event.probability).toFixed(2)}</td>
        <td>${Number(event.stateDelta).toFixed(2)}</td>
      </tr>
    `;
  }).join('');

  for (const row of els.eventTableBody.querySelectorAll('tr[data-event-id]')) {
    row.addEventListener('click', () => {
      const event = state.events.find((item) => item.id === row.dataset.eventId);
      if (event) populateEventForm(event);
    });
  }
}

function renderPathView() {
  populateEventNodeOptions();
  renderValidation();
  renderGraphBadges();
  renderNodeTable();
  renderEventTable();

  if (!state.selectedPath) {
    els.graphTitle.textContent = 'Path graph';
    els.graphEmpty.classList.remove('hidden');
    els.graphCanvas.setAttribute('viewBox', '0 0 100 100');
    els.graphCanvas.innerHTML = '';
    return;
  }

  els.graphTitle.textContent = state.selectedPath.name;
  const graph = buildGraphMarkup();
  els.graphCanvas.setAttribute('viewBox', `0 0 ${graph.width} ${graph.height}`);
  els.graphCanvas.setAttribute('width', String(graph.width));
  els.graphCanvas.setAttribute('height', String(graph.height));
  els.graphCanvas.innerHTML = graph.markup;
  els.graphEmpty.classList.toggle('hidden', !!graph.markup);

  for (const nodeEl of els.graphCanvas.querySelectorAll('[data-node-id]')) {
    nodeEl.addEventListener('click', () => {
      const node = getNodeById(nodeEl.dataset.nodeId);
      if (node) populateNodeForm(node);
    });
  }

  for (const edgeEl of els.graphCanvas.querySelectorAll('[data-event-id]')) {
    edgeEl.addEventListener('click', () => {
      const event = state.events.find((item) => item.id === edgeEl.dataset.eventId);
      if (event) populateEventForm(event);
    });
  }
}

async function refreshAll() {
  const currentStrategyId = state.selectedStrategy?.id;
  const currentPathId = state.selectedPath?.id;
  await loadStrategies(currentStrategyId);
  if (state.selectedStrategy) {
    await loadStrategy(state.selectedStrategy.id, currentPathId);
  } else {
    state.paths = [];
    state.selectedPath = null;
    state.nodes = [];
    state.events = [];
    state.validation = null;
    renderStrategies();
    renderPaths();
    renderPathView();
  }
}

async function runAnalysisCall(name) {
  if (!selectedStrategyId() || !selectedPathId()) {
    showToast('Select a strategy and path first.', 'error');
    return null;
  }

  const maxSteps = Number(els.analysisMaxSteps.value);
  const step = Number(els.analysisStep.value);

  switch (name) {
    case 'strategy.analysis.analyzePath':
      state.analysis.analyzePath = await api.call(name, [selectedStrategyId(), selectedPathId(), { maxSteps }]);
      break;
    case 'strategy.analysis.probabilityToReachGoal':
      state.analysis.probabilityToReachGoal = await api.call(name, [selectedStrategyId(), selectedPathId(), maxSteps]);
      break;
    case 'strategy.analysis.expectedStepsToGoal':
      state.analysis.expectedStepsToGoal = await api.call(name, [selectedStrategyId(), selectedPathId(), maxSteps]);
      break;
    case 'strategy.analysis.expectedStateDelta':
      state.analysis.expectedStateDelta = await api.call(name, [selectedStrategyId(), selectedPathId(), maxSteps]);
      break;
    case 'strategy.analysis.hittingTimeDistribution':
      state.analysis.hittingTimeDistribution = await api.call(name, [selectedStrategyId(), selectedPathId(), maxSteps]);
      break;
    case 'strategy.analysis.distributionAtStep':
      state.analysis.distributionAtStep = await api.call(name, [selectedStrategyId(), selectedPathId(), step]);
      break;
    default:
      break;
  }

  renderAnalysis();
}

async function runAnalysisSuite() {
  resetAnalysis();
  await runAnalysisCall('strategy.analysis.analyzePath');
  await runAnalysisCall('strategy.analysis.probabilityToReachGoal');
  await runAnalysisCall('strategy.analysis.expectedStepsToGoal');
  await runAnalysisCall('strategy.analysis.expectedStateDelta');
  await runAnalysisCall('strategy.analysis.hittingTimeDistribution');
  await runAnalysisCall('strategy.analysis.distributionAtStep');
  showToast('Analysis suite completed');
}

function bindEvents() {
  els.strategyForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(els.strategyForm);
    const name = String(form.get('name') || '').trim();
    const description = String(form.get('description') || '').trim();
    if (!name) return;

    try {
      const created = await api.call('strategy.strategies.create', [name, description || undefined]);
      els.strategyForm.reset();
      await loadStrategies(created.id);
      await loadStrategy(created.id);
      showToast(`Created strategy "${created.name}"`);
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  els.pathForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!selectedStrategyId()) {
      showToast('Create or select a strategy first.', 'error');
      return;
    }

    const form = new FormData(els.pathForm);
    const input = {
      name: String(form.get('name') || '').trim(),
      description: String(form.get('description') || '').trim() || undefined,
      rootName: String(form.get('rootName') || '').trim() || undefined,
    };
    if (!input.name) return;

    try {
      const created = await api.call('strategy.paths.create', [selectedStrategyId(), input]);
      els.pathForm.reset();
      await loadStrategy(selectedStrategyId(), created.id);
      showToast(`Created path "${created.name}"`);
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  els.nodeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!selectedStrategyId() || !selectedPathId()) {
      showToast('Select a path first.', 'error');
      return;
    }

    const patch = {
      name: els.nodeName.value.trim(),
      note: els.nodeNote.value.trim() || undefined,
    };
    if (!patch.name) return;

    try {
      if (selectedNodeId()) {
        const currentNode = getNodeById(selectedNodeId());
        const updatePatch = {
          ...patch,
          kind: currentNode?.kind === 'root' ? undefined : els.nodeKind.value,
        };
        const updated = await api.call('strategy.nodes.update', [
          selectedStrategyId(),
          selectedPathId(),
          selectedNodeId(),
          updatePatch,
        ]);
        await loadPath(selectedStrategyId(), selectedPathId());
        populateNodeForm(updated);
        showToast(`Updated node "${updated.name}"`);
      } else {
        const created = await api.call('strategy.nodes.add', [
          selectedStrategyId(),
          selectedPathId(),
          {
            ...patch,
            kind: els.nodeKind.value,
          },
        ]);
        await loadPath(selectedStrategyId(), selectedPathId());
        populateNodeForm(created);
        showToast(`Added node "${created.name}"`);
      }
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  els.eventForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!selectedStrategyId() || !selectedPathId()) {
      showToast('Select a path first.', 'error');
      return;
    }

    const payload = {
      fromNodeId: els.eventFrom.value,
      toNodeId: els.eventTo.value,
      name: els.eventName.value.trim(),
      probability: Number(els.eventProbability.value),
      stateDelta: Number(els.eventStateDelta.value),
      reason: els.eventReason.value.trim() || undefined,
    };
    if (!payload.name) return;

    try {
      if (selectedEventId()) {
        const updated = await api.call('strategy.events.update', [
          selectedStrategyId(),
          selectedPathId(),
          selectedEventId(),
          payload,
        ]);
        await loadPath(selectedStrategyId(), selectedPathId());
        populateEventForm(updated);
        showToast(`Updated event "${updated.name}"`);
      } else {
        const created = await api.call('strategy.events.add', [
          selectedStrategyId(),
          selectedPathId(),
          payload,
        ]);
        await loadPath(selectedStrategyId(), selectedPathId());
        populateEventForm(created);
        showToast(`Added event "${created.name}"`);
      }
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  document.getElementById('refresh-all-button').addEventListener('click', async () => {
    try {
      await refreshAll();
      showToast('Refreshed strategy data');
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  document.getElementById('reload-strategies-button').addEventListener('click', async () => {
    try {
      await refreshAll();
      showToast('Reloaded');
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  document.getElementById('validate-button').addEventListener('click', async () => {
    if (!selectedStrategyId() || !selectedPathId()) return;
    try {
      state.validation = await api.call('strategy.paths.validate', [selectedStrategyId(), selectedPathId()]);
      renderValidation();
      showToast(state.validation.valid ? 'Path is valid' : 'Validation found issues');
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  document.getElementById('delete-path-button').addEventListener('click', async () => {
    if (!selectedStrategyId() || !selectedPathId() || !state.selectedPath) return;
    if (!confirm(`Delete path "${state.selectedPath.name}"?`)) return;
    try {
      await api.call('strategy.paths.remove', [selectedStrategyId(), selectedPathId()]);
      const nextPath = state.paths.find((item) => item.id !== selectedPathId());
      await loadStrategy(selectedStrategyId(), nextPath?.id);
      showToast('Path deleted');
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  document.getElementById('clear-node-selection-button').addEventListener('click', resetNodeForm);
  document.getElementById('clear-event-selection-button').addEventListener('click', resetEventForm);
  document.getElementById('node-reset-button').addEventListener('click', resetNodeForm);
  document.getElementById('event-reset-button').addEventListener('click', resetEventForm);

  els.nodeDeleteButton.addEventListener('click', async () => {
    if (!selectedStrategyId() || !selectedPathId() || !selectedNodeId()) return;
    const node = getNodeById(selectedNodeId());
    if (!node || !confirm(`Delete node "${node.name}"?`)) return;
    try {
      await api.call('strategy.nodes.remove', [selectedStrategyId(), selectedPathId(), node.id]);
      await loadPath(selectedStrategyId(), selectedPathId());
      resetNodeForm();
      showToast(`Deleted node "${node.name}"`);
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  els.eventDeleteButton.addEventListener('click', async () => {
    if (!selectedStrategyId() || !selectedPathId() || !selectedEventId()) return;
    const eventRecord = state.events.find((item) => item.id === selectedEventId());
    if (!eventRecord || !confirm(`Delete event "${eventRecord.name}"?`)) return;
    try {
      await api.call('strategy.events.remove', [selectedStrategyId(), selectedPathId(), eventRecord.id]);
      await loadPath(selectedStrategyId(), selectedPathId());
      resetEventForm();
      showToast(`Deleted event "${eventRecord.name}"`);
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  document.getElementById('analysis-suite-button').addEventListener('click', () => runAnalysisSuite().catch((error) => showToast(error.message, 'error')));
  document.getElementById('run-suite-button').addEventListener('click', () => runAnalysisSuite().catch((error) => showToast(error.message, 'error')));
  document.getElementById('analysis-analyze-button').addEventListener('click', () => runAnalysisCall('strategy.analysis.analyzePath').catch((error) => showToast(error.message, 'error')));
  document.getElementById('analysis-prob-button').addEventListener('click', () => runAnalysisCall('strategy.analysis.probabilityToReachGoal').catch((error) => showToast(error.message, 'error')));
  document.getElementById('analysis-steps-button').addEventListener('click', () => runAnalysisCall('strategy.analysis.expectedStepsToGoal').catch((error) => showToast(error.message, 'error')));
  document.getElementById('analysis-delta-button').addEventListener('click', () => runAnalysisCall('strategy.analysis.expectedStateDelta').catch((error) => showToast(error.message, 'error')));
  document.getElementById('analysis-hit-button').addEventListener('click', () => runAnalysisCall('strategy.analysis.hittingTimeDistribution').catch((error) => showToast(error.message, 'error')));
  document.getElementById('analysis-dist-button').addEventListener('click', () => runAnalysisCall('strategy.analysis.distributionAtStep').catch((error) => showToast(error.message, 'error')));
  document.getElementById('clear-log-button').addEventListener('click', () => {
    state.callLog = [];
    renderCallLog();
  });
}

async function bootstrap() {
  bindEvents();
  resetAnalysis();
  renderCallLog();
  try {
    state.manifest = await api.getManifest();
    renderReference();
    await refreshAll();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

bootstrap();
