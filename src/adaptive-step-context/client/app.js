const state = {
  sessions: [],
  session: null,
  selectedSessionId: new URLSearchParams(location.search).get('session') || '',
  timelineLive: true,
  timelineCutoff: 0,
};

const ids = [
  'sessionSelect', 'sessionMeta', 'title', 'stepCount', 'readyCount', 'meanHeat', 'meanProjection',
  'goalText', 'rows', 'coldColor', 'midColor', 'hotColor', 'gradientPreview', 'legendRamp',
  'liveTimeline', 'timelineStep', 'timelineLabel', 'timelineTrack', 'lensBanner',
  'wCurrent', 'wCurrentReasoning', 'wCurrentOutput', 'wCurrentObservation',
  'wGoal', 'wProjected', 'wProjectedReasoning', 'wProjectedOutput', 'wProjectedObservation',
  'projectionAlpha', 'wRecency', 'recencyRange',
];
const el = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
const channelNames = ['reasoning', 'output', 'observation'];
const pruneThreshold = 0.6;

function number(id) {
  return Number(el[id].value);
}

function weights() {
  return {
    current: number('wCurrent'),
    currentChannels: {
      reasoning: number('wCurrentReasoning'),
      output: number('wCurrentOutput'),
      observation: number('wCurrentObservation'),
    },
    goal: number('wGoal'),
    projected: number('wProjected'),
    projectedChannels: {
      reasoning: number('wProjectedReasoning'),
      output: number('wProjectedOutput'),
      observation: number('wProjectedObservation'),
    },
    projectionAlpha: number('projectionAlpha'),
    recency: 0,
    recencyRange: Math.max(1, number('recencyRange')),
  };
}

function updateSliderLabels() {
  document.querySelectorAll('.slider').forEach(label => {
    const input = label.querySelector('input');
    const out = label.querySelector('b');
    if (input && out) out.textContent = Number(input.value).toFixed(input.step === '1' ? 0 : 2);
  });
}

function dot(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return null;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function cosine01(a, b) {
  const value = dot(a, b);
  if (value === null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, (value + 1) / 2));
}

function add(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  return a.map((x, i) => x + b[i]);
}

function sub(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  return a.map((x, i) => x - b[i]);
}

function scale(a, k) {
  return a?.map(x => x * k) || null;
}

function project(current, previous, alpha) {
  const velocity = sub(current, previous);
  return add(current, scale(velocity, alpha));
}

function avgVectors(vectors) {
  const valid = vectors.filter(v => Array.isArray(v) && v.length > 0);
  if (!valid.length) return null;
  const len = valid[0].length;
  if (!valid.every(v => v.length === len)) return null;
  const out = new Array(len).fill(0);
  for (const v of valid) {
    for (let i = 0; i < len; i++) out[i] += v[i] / valid.length;
  }
  return out;
}

function stepCombined(step) {
  return avgVectors(channelNames.map(channel => step.embeddings?.[channel]));
}

function channelScore(step, target, channelWeights) {
  let total = 0;
  let weightTotal = 0;
  const parts = {};
  for (const channel of channelNames) {
    const weight = channelWeights[channel] ?? 0;
    const score = cosine01(step.embeddings?.[channel], target?.[channel]);
    parts[channel] = score;
    if (score !== null && weight > 0) {
      total += score * weight;
      weightTotal += weight;
    }
  }
  return { value: weightTotal > 0 ? total / weightTotal : 0, parts };
}

function buildProjection(steps, index, alpha) {
  if (index < 2) return {};
  const current = steps[index - 1];
  const previous = steps[index - 2];
  return {
    reasoning: project(current?.embeddings?.reasoning, previous?.embeddings?.reasoning, alpha),
    output: project(current?.embeddings?.output, previous?.embeddings?.output, alpha),
    observation: project(current?.embeddings?.observation, previous?.embeddings?.observation, alpha),
  };
}

function timelineCutoff(session) {
  const total = session.steps?.length || 0;
  return state.timelineLive ? total : Math.max(0, Math.min(total, state.timelineCutoff));
}

function syncTimelineControls(session) {
  const total = session?.steps?.length || 0;
  const cutoff = session ? timelineCutoff(session) : 0;
  el.timelineStep.max = String(total);
  el.timelineStep.value = String(cutoff);
  el.liveTimeline.checked = state.timelineLive;
  el.timelineLabel.textContent = state.timelineLive
    ? `Context after latest step (${total})`
    : `Context after step ${cutoff}`;
}

function renderTimelineTrack(scored, cutoff) {
  if (!scored.length) {
    el.timelineTrack.innerHTML = '<span class="timeline-empty">No steps yet</span>';
    return;
  }
  el.timelineTrack.innerHTML = scored.map(({ heat, step, isFuture }, index) => `
    <button
      class="timeline-dot${index + 1 === cutoff ? ' active' : ''}${isFuture ? ' future' : ''}"
      style="--dot-color:${heatColor(heat)}"
      title="rewind to context after step ${index + 1}"
      data-cutoff="${index + 1}"
    >
      ${step.index + 1}
    </button>
  `).join('');
}

function scoreSteps(session) {
  const w = weights();
  const steps = session.steps || [];
  const cutoff = timelineCutoff(session);
  const visibleSteps = steps.slice(0, cutoff);
  const last = [...visibleSteps].reverse().find(step => step.embeddingStatus === 'ready');
  const currentTarget = last?.embeddings || {};
  const projectedTarget = buildProjection(visibleSteps, visibleSteps.length, w.projectionAlpha);

  const scored = steps.map((step, index) => {
    const isFuture = index >= cutoff;
    const current = channelScore(step, currentTarget, w.currentChannels);
    const projected = channelScore(step, projectedTarget, w.projectedChannels);
    const goalScore = cosine01(stepCombined(step), session.goalEmbedding) ?? 0;
    const recency = 0;
    const weighted =
      current.value * w.current
      + projected.value * w.projected
      + goalScore * w.goal
      + recency * w.recency;
    const maxWeight = w.current + w.projected + w.goal + w.recency || 1;
    const heat = Math.max(0, Math.min(1, weighted / maxWeight));
    const projectionForThisStep = buildProjection(steps, index, w.projectionAlpha);
    const accuracy = channelScore(step, projectionForThisStep, { reasoning: 1, output: 1, observation: 1 });
    const lensHit = channelScore(step, projectedTarget, { reasoning: 1, output: 1, observation: 1 });
    return {
      step,
      heat,
      current,
      projected,
      goalScore,
      recency,
      isFuture,
      projectionAccuracy: index > 0 ? accuracy : null,
      lensProjectionHit: cutoff > 0 ? lensHit : null,
    };
  });

  return { scored, cutoff, visibleSteps };
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  return [0, 2, 4].map(i => parseInt(clean.slice(i, i + 2), 16));
}

function rgbToHex(rgb) {
  return `#${rgb.map(x => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
}

function mix(c1, c2, t) {
  return c1.map((x, i) => x + (c2[i] - x) * t);
}

function heatColor(value) {
  const cold = hexToRgb(el.coldColor.value);
  const mid = hexToRgb(el.midColor.value);
  const hot = hexToRgb(el.hotColor.value);
  return value < 0.5
    ? rgbToHex(mix(cold, mid, value * 2))
    : rgbToHex(mix(mid, hot, (value - 0.5) * 2));
}

function excerpt(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > 210 ? `${clean.slice(0, 207)}...` : clean || 'empty channel';
}

function bar(title, value, text) {
  const safe = value ?? 0;
  return `
    <div class="barbox">
      <div class="barlabel"><span>${title}</span><strong>${safe.toFixed(3)}</strong></div>
      <div class="bar" style="--value:${Math.max(0, Math.min(1, safe))}"><i></i></div>
      <div class="excerpt">${escapeHtml(text)}</div>
    </div>
  `;
}

function mini(value) {
  return `<div class="mini">${(value ?? 0).toFixed(2)}</div>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  })[ch]);
}

function render() {
  updateSliderLabels();
  document.documentElement.style.setProperty('--cold', el.coldColor.value);
  document.documentElement.style.setProperty('--mid', el.midColor.value);
  document.documentElement.style.setProperty('--hot', el.hotColor.value);

  const session = state.session;
  if (!session) {
    el.rows.innerHTML = '<div class="empty">No adaptive session is active yet.</div>';
    return;
  }

  syncTimelineControls(session);
  const { scored, cutoff } = scoreSteps(session);
  const ready = session.steps.filter(step => step.embeddingStatus === 'ready').length;
  const heatAvg = scored.length ? scored.reduce((sum, row) => sum + row.heat, 0) / scored.length : 0;
  const projections = scored.map(row => row.projectionAccuracy?.value).filter(v => typeof v === 'number');
  const projectionAvg = projections.length ? projections.reduce((sum, value) => sum + value, 0) / projections.length : 0;

  el.title.textContent = `${session.agentName} / ${session.id}`;
  el.goalText.textContent = session.goal || 'No original user goal captured yet.';
  el.sessionMeta.innerHTML = `
    <div>model: <strong>${escapeHtml(session.embeddingModel)}</strong></div>
    <div>goal embedding: <strong>${escapeHtml(session.goalEmbeddingStatus)}</strong></div>
    <div>started: ${escapeHtml(new Date(session.startedAt).toLocaleString())}</div>
  `;
  el.stepCount.textContent = String(session.steps.length);
  el.readyCount.textContent = String(ready);
  el.meanHeat.textContent = heatAvg.toFixed(2);
  el.meanProjection.textContent = projectionAvg.toFixed(2);
  el.lensBanner.textContent = state.timelineLive
    ? `Live lens: scoring against all ${session.steps.length} available steps.`
    : `Rewind lens: scoring as if only the first ${cutoff} step${cutoff === 1 ? '' : 's'} existed. Future rows are ghosted.`;

  if (!scored.length) {
    renderTimelineTrack(scored, cutoff);
    el.rows.innerHTML = '<div class="empty">Waiting for model steps. The heatmap will fill as the agent reasons, calls tools, and observes results.</div>';
    return;
  }

  renderTimelineTrack(scored, cutoff);
  el.rows.innerHTML = scored.map(({ step, heat, current, projected, goalScore, projectionAccuracy, lensProjectionHit, isFuture }) => {
    const isPruned = heat < pruneThreshold && !isFuture;
    return `
    <article class="row${isFuture ? ' future' : ''}${isPruned ? ' pruned' : ''}">
      <div class="idx">${step.index + 1}${isPruned ? '<span class="pruned-badge">cut</span>' : ''}</div>
      <div class="heat-cell" style="--cell-color:${heatColor(heat)}">
        <div class="heat-score">${heat.toFixed(3)}</div>
      </div>
      ${bar('near current / reasoning', current.parts.reasoning ?? 0, step.reasoning)}
      ${bar('near current / output', current.parts.output ?? 0, step.output)}
      ${bar('near current / observation', current.parts.observation ?? 0, step.observation)}
      ${mini(goalScore)}
      ${bar(isFuture ? 'lens projection hit' : 'projected vs real', (isFuture ? lensProjectionHit : projectionAccuracy)?.value ?? 0, [
        `reasoning ${((isFuture ? lensProjectionHit : projectionAccuracy)?.parts.reasoning ?? 0).toFixed(3)}`,
        `output ${((isFuture ? lensProjectionHit : projectionAccuracy)?.parts.output ?? 0).toFixed(3)}`,
        `observation ${((isFuture ? lensProjectionHit : projectionAccuracy)?.parts.observation ?? 0).toFixed(3)}`,
      ].join(' / '))}
    </article>
  `;
  }).join('');
}

async function loadSessions() {
  const res = await fetch('/api/sessions');
  const data = await res.json();
  state.sessions = data.sessions || [];
  if (!state.selectedSessionId && state.sessions[0]) {
    state.selectedSessionId = state.sessions[0].id;
  }
  el.sessionSelect.innerHTML = state.sessions.map(session => `
    <option value="${escapeHtml(session.id)}"${session.id === state.selectedSessionId ? ' selected' : ''}>
      ${escapeHtml(session.agentName)} / ${escapeHtml(session.id)} / ${session.steps.length} steps
    </option>
  `).join('');
}

async function loadSession() {
  if (!state.selectedSessionId) {
    state.session = null;
    render();
    return;
  }
  const res = await fetch(`/api/sessions/${encodeURIComponent(state.selectedSessionId)}`);
  if (!res.ok) {
    state.session = null;
    render();
    return;
  }
  const data = await res.json();
  state.session = data.session;
  if (state.timelineLive) state.timelineCutoff = state.session.steps.length;
  else state.timelineCutoff = Math.min(state.timelineCutoff, state.session.steps.length);
  render();
}

async function tick() {
  try {
    await loadSessions();
    await loadSession();
  } catch (error) {
    console.warn('Adaptive heatmap refresh failed:', error);
  }
}

for (const id of ids) {
  const node = el[id];
  if (node?.matches?.('input') && !['liveTimeline', 'timelineStep'].includes(id)) {
    node.addEventListener('input', render);
  }
}

el.liveTimeline.addEventListener('change', () => {
  state.timelineLive = el.liveTimeline.checked;
  if (state.session && state.timelineLive) state.timelineCutoff = state.session.steps.length;
  render();
});

el.timelineStep.addEventListener('input', () => {
  state.timelineLive = false;
  state.timelineCutoff = Number(el.timelineStep.value);
  render();
});

el.timelineTrack.addEventListener('click', event => {
  const button = event.target.closest('[data-cutoff]');
  if (!button) return;
  state.timelineLive = false;
  state.timelineCutoff = Number(button.dataset.cutoff);
  render();
});

el.sessionSelect.addEventListener('change', () => {
  state.selectedSessionId = el.sessionSelect.value;
  const url = new URL(location.href);
  url.searchParams.set('session', state.selectedSessionId);
  history.replaceState(null, '', url);
  void loadSession();
});

updateSliderLabels();
void tick();
setInterval(tick, 1500);
