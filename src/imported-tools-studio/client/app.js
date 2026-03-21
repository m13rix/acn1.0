const state = {
  tab: 'installed',
  installed: [],
  draft: null,
  busy: false,
};

const elements = {
  panelTitle: document.getElementById('panel-title'),
  panelSubtitle: document.getElementById('panel-subtitle'),
  panelContent: document.getElementById('panel-content'),
  reviewContent: document.getElementById('review-content'),
  refreshInstalled: document.getElementById('refresh-installed'),
  tabs: Array.from(document.querySelectorAll('.tab')),
};

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

function setReviewHtml(html) {
  elements.reviewContent.innerHTML = html;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = String(text ?? '');
  return div.innerHTML;
}

function renderInstalled() {
  elements.panelTitle.textContent = 'Installed Imports';
  elements.panelSubtitle.textContent = 'Generated ACN namespaces, runtime versions, and quick actions.';

  if (state.installed.length === 0) {
    elements.panelContent.innerHTML = `
      <div class="empty-state">
        <h3>No imported tools yet</h3>
        <p>Inspect an MCP server or a ClawHub skill to generate the first namespace.</p>
      </div>
    `;
    return;
  }

  elements.panelContent.innerHTML = `
    <div class="card-grid">
      ${state.installed.map((entry) => `
        <article class="card">
          <div class="card-topline">
            <span class="badge">${escapeHtml(entry.kind)}</span>
            <span class="muted">${escapeHtml(entry.runtime.version)}</span>
          </div>
          <h3>${escapeHtml(entry.displayName)}</h3>
          <p class="mono">${escapeHtml(entry.namespace)}</p>
          <p>${escapeHtml(entry.description)}</p>
          <div class="card-meta">
            <span>${entry.methods.length} methods</span>
            <span>${entry.smokeTest?.passed ? 'smoke passed' : 'smoke pending'}</span>
          </div>
          <div class="card-actions">
            <button data-action="refresh" data-id="${escapeHtml(entry.id)}">Refresh</button>
            <button data-action="reinstall" data-id="${escapeHtml(entry.id)}">Reinstall</button>
            <button data-action="delete" data-id="${escapeHtml(entry.id)}" class="danger">Delete</button>
          </div>
        </article>
      `).join('')}
    </div>
  `;

  elements.panelContent.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.getAttribute('data-id');
      const action = button.getAttribute('data-action');
      if (!id || !action) return;
      try {
        if (action === 'delete') {
          await api(`/imports/${encodeURIComponent(id)}`, { method: 'DELETE' });
          await loadInstalled();
          setReviewHtml('<div class="review-empty">Import deleted.</div>');
          return;
        }
        const endpoint = action === 'refresh'
          ? `/imports/${encodeURIComponent(id)}/refresh`
          : `/imports/${encodeURIComponent(id)}/reinstall`;
        const payload = await api(endpoint, { method: 'POST' });
        if (payload.draft) {
          state.draft = payload.draft;
          renderReview();
        }
        await loadInstalled();
      } catch (error) {
        setReviewHtml(`<div class="review-error">${escapeHtml(error.message || error)}</div>`);
      }
    });
  });
}

function renderSourceForm(kind) {
  if (kind === 'mcp') {
    renderMcpPackageForm();
    return;
  }

  const title = kind === 'mcp' ? 'Inspect MCP Source' : 'Inspect ClawHub Source';
  const description = kind === 'mcp'
    ? 'Resolve a local path, git repo, or package reference into a local stdio MCP integration.'
    : 'Resolve an executable ClawHub skill from a local path, git repo, or slug-like repo reference.';
  elements.panelTitle.textContent = title;
  elements.panelSubtitle.textContent = description;
  elements.panelContent.innerHTML = `
    <form id="inspect-form" class="stack">
      <label>
        <span>Source Type</span>
        <select name="type">
          <option value="localPath">Local Path</option>
          <option value="git">Git URL</option>
          <option value="${kind === 'mcp' ? 'package' : 'clawhubSlug'}">${kind === 'mcp' ? 'Package Reference' : 'ClawHub Slug / Repo'}</option>
        </select>
      </label>
      <label>
        <span>Source Value</span>
        <input name="value" placeholder="${kind === 'mcp' ? 'C:\\\\path\\\\to\\\\server or npm package' : 'C:\\\\path\\\\to\\\\skill or owner/repo'}" required>
      </label>
      <label>
        <span>Display Name</span>
        <input name="displayName" placeholder="${kind === 'mcp' ? 'SdamGIA' : 'Gog'}">
      </label>
      <label>
        <span>Command Override</span>
        <input name="command" placeholder="Optional explicit executable">
      </label>
      <label>
        <span>Args Override</span>
        <input name="args" placeholder="Optional args, separated by spaces">
      </label>
      <label>
        <span>Extra Docs</span>
        <textarea name="docs" placeholder="Paste README fragments, usage notes, or ACN-specific guidance"></textarea>
      </label>
      <button type="submit" class="primary-button">Inspect ${kind === 'mcp' ? 'MCP' : 'ClawHub'} Source</button>
    </form>
  `;

  document.getElementById('inspect-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = {
      kind,
      source: {
        type: form.get('type'),
        value: form.get('value'),
        displayName: form.get('displayName') || undefined,
        command: form.get('command') || undefined,
        args: String(form.get('args') || '').trim() ? String(form.get('args')).trim().split(/\s+/) : undefined,
      },
      docs: String(form.get('docs') || '').trim()
        ? [{ name: 'ui-notes.md', content: String(form.get('docs')).trim() }]
        : [],
    };

    try {
      const response = await api('/imports/inspect', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      state.draft = response.draft;
      renderReview();
    } catch (error) {
      setReviewHtml(`<div class="review-error">${escapeHtml(error.message || error)}</div>`);
    }
  });
}

function renderMcpPackageForm() {
  elements.panelTitle.textContent = 'Import MCP Package';
  elements.panelSubtitle.textContent = 'Paste the npm package name and a display name. The studio will connect to it as an MCP config using npx and inspect tools directly from the live server.';
  elements.panelContent.innerHTML = `
    <form id="inspect-form" class="stack">
      <label>
        <span>npm Package</span>
        <input name="packageName" placeholder="sdamgia-mcp-server" required>
      </label>
      <label>
        <span>Display Name</span>
        <input name="displayName" placeholder="SdamGIA" required>
      </label>
      <label>
        <span>Knowledge Mode</span>
        <select name="knowledgeMode">
          <option value="both">Description + Skills</option>
          <option value="skills">Skills Only</option>
          <option value="description">Description Only</option>
        </select>
      </label>
      <button type="submit" class="primary-button">Inspect MCP Package</button>
    </form>
  `;

  document.getElementById('inspect-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = {
      kind: 'mcp',
      packageName: String(form.get('packageName') || '').trim(),
      displayName: String(form.get('displayName') || '').trim(),
      knowledgeMode: String(form.get('knowledgeMode') || 'both'),
    };

    try {
      const response = await api('/imports/inspect', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      state.draft = response.draft;
      renderReview();
    } catch (error) {
      setReviewHtml(`<div class="review-error">${escapeHtml(error.message || error)}</div>`);
    }
  });
}

function renderReview() {
  if (!state.draft) {
    setReviewHtml('<div class="review-empty">Nothing inspected yet.</div>');
    return;
  }
  const blockers = state.draft.risk.blockers || [];
  const warnings = state.draft.risk.warnings || [];
  const inferred = state.draft.risk.inferred || [];
  setReviewHtml(`
    <div class="review-block">
      <div class="review-header">
        <div>
          <h3>${escapeHtml(state.draft.displayName)}</h3>
          <p class="mono">${escapeHtml(state.draft.namespace)}</p>
        </div>
        <span class="badge">${escapeHtml(state.draft.kind)}</span>
      </div>
      <p>${escapeHtml(state.draft.description)}</p>
      <div class="review-meta">
        <span>${state.draft.methods.length} methods</span>
        <span>${escapeHtml(state.draft.runtime.command)}</span>
        <span>${escapeHtml(state.draft.knowledgeMode || 'description')}</span>
        <span>${state.draft.skills?.entries?.length || 0} skill entries</span>
      </div>
      ${blockers.length ? `<div class="risk risk-blockers"><strong>Blockers</strong><ul>${blockers.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}
      ${warnings.length ? `<div class="risk risk-warnings"><strong>Warnings</strong><ul>${warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}
      ${inferred.length ? `<div class="risk risk-inferred"><strong>Inferred</strong><ul>${inferred.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}
      <div class="method-list">
        ${state.draft.methods.map((method) => `
          <article class="method-card">
            <div class="card-topline">
              <span class="badge subtle">${escapeHtml(method.originalName)}</span>
              <span>${method.positionalOverload ? 'positional overload' : 'object only'}</span>
            </div>
            <h4>${escapeHtml(method.methodName)}</h4>
            <p>${escapeHtml(method.description || 'Imported method')}</p>
            <p class="mono">${escapeHtml(method.orderedParameters.join(', ') || 'no parameters')}</p>
          </article>
        `).join('')}
      </div>
      <button id="apply-draft" class="primary-button"${blockers.length ? ' disabled' : ''}>Apply Import</button>
    </div>
  `);

  const apply = document.getElementById('apply-draft');
  if (apply) {
    apply.addEventListener('click', async () => {
      try {
        const response = await api('/imports/apply', {
          method: 'POST',
          body: JSON.stringify({ draft: state.draft }),
        });
        state.draft = response.import;
        await loadInstalled();
        setReviewHtml('<div class="review-empty">Import activated and smoke-tested successfully.</div>');
        selectTab('installed');
      } catch (error) {
        setReviewHtml(`<div class="review-error">${escapeHtml(error.message || error)}</div>`);
      }
    });
  }
}

function selectTab(tab) {
  state.tab = tab;
  elements.tabs.forEach((button) => {
    button.classList.toggle('is-active', button.dataset.tab === tab);
  });
  if (tab === 'installed') {
    renderInstalled();
  } else if (tab === 'mcp') {
    renderSourceForm('mcp');
  } else {
    renderSourceForm('clawhub');
  }
}

async function loadInstalled() {
  const response = await api('/imports');
  state.installed = response.imports || [];
  if (state.tab === 'installed') {
    renderInstalled();
  }
}

elements.refreshInstalled.addEventListener('click', () => {
  loadInstalled().catch((error) => {
    setReviewHtml(`<div class="review-error">${escapeHtml(error.message || error)}</div>`);
  });
});

elements.tabs.forEach((button) => {
  button.addEventListener('click', () => selectTab(button.dataset.tab));
});

loadInstalled().then(renderReview).catch((error) => {
  setReviewHtml(`<div class="review-error">${escapeHtml(error.message || error)}</div>`);
});
