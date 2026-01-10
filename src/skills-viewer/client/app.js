/**
 * ACN Skills Viewer - Main Application
 * 
 * Single-page application with hash-based routing.
 */

// ============================================================================
// API Client
// ============================================================================

const api = {
  async request(endpoint, options = {}) {
    const response = await fetch(`/api${endpoint}`, {
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options,
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    
    return response.json();
  },

  async getTables() {
    const data = await this.request('/tables');
    return data.tables;
  },

  async createTable(name) {
    await this.request('/tables', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  },

  async deleteTable(name) {
    await this.request(`/tables/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
  },

  async getEntries(tableName) {
    const data = await this.request(`/tables/${encodeURIComponent(tableName)}/entries`);
    return data.entries;
  },

  async addEntry(tableName, content) {
    const data = await this.request(`/tables/${encodeURIComponent(tableName)}/entries`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
    return data.entry;
  },

  async updateEntry(tableName, id, content) {
    const data = await this.request(
      `/tables/${encodeURIComponent(tableName)}/entries/${encodeURIComponent(id)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ content }),
      }
    );
    return data.entry;
  },

  async deleteEntry(tableName, id) {
    await this.request(
      `/tables/${encodeURIComponent(tableName)}/entries/${encodeURIComponent(id)}`,
      { method: 'DELETE' }
    );
  },

  async searchEntries(tableName, query, limit = 20) {
    const data = await this.request(`/tables/${encodeURIComponent(tableName)}/search`, {
      method: 'POST',
      body: JSON.stringify({ query, limit }),
    });
    return data.results;
  },
};

// ============================================================================
// Toast Notifications
// ============================================================================

const toast = {
  container: null,
  
  init() {
    this.container = document.createElement('div');
    this.container.className = 'toast-container';
    document.body.appendChild(this.container);
  },
  
  show(message, type = 'info', duration = 3000) {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    this.container.appendChild(el);
    
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(20px)';
      setTimeout(() => el.remove(), 200);
    }, duration);
  },
  
  error(message) { this.show(message, 'error', 5000); },
  success(message) { this.show(message, 'success'); },
};

// ============================================================================
// Modal
// ============================================================================

function showModal({ title, content, onSubmit, submitText = 'Save', cancelText = 'Cancel' }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    
    const close = (result) => {
      overlay.remove();
      resolve(result);
    };
    
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h2 class="modal-title">${title}</h2>
          <button class="btn btn-ghost btn-icon close-btn">✕</button>
        </div>
        <div class="modal-body">
          ${content}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary cancel-btn">${cancelText}</button>
          <button class="btn btn-primary submit-btn">${submitText}</button>
        </div>
      </div>
    `;
    
    overlay.querySelector('.close-btn').onclick = () => close(null);
    overlay.querySelector('.cancel-btn').onclick = () => close(null);
    overlay.querySelector('.submit-btn').onclick = () => {
      const result = onSubmit ? onSubmit(overlay) : true;
      if (result !== false) close(result);
    };
    
    overlay.onclick = (e) => {
      if (e.target === overlay) close(null);
    };
    
    document.body.appendChild(overlay);
    
    // Focus first input
    const input = overlay.querySelector('input, textarea');
    if (input) input.focus();
  });
}

// ============================================================================
// Utility Functions
// ============================================================================

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function truncate(text, maxLength = 200) {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

// ============================================================================
// Pages
// ============================================================================

const pages = {
  // Home Page - List all tables
  async home() {
    const main = document.getElementById('main-content');
    main.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Skill Tables</h1>
          <p class="page-description">Manage your skills knowledge base</p>
        </div>
        <button class="btn btn-primary btn-lg" id="create-table-btn">
          + New Table
        </button>
      </div>
      <div class="loading"><div class="spinner"></div></div>
    `;
    
    document.getElementById('create-table-btn').onclick = async () => {
      const result = await showModal({
        title: 'Create New Table',
        content: `
          <div class="input-group">
            <label class="input-label">Table Name</label>
            <input type="text" class="input" id="table-name-input" 
                   placeholder="e.g., programming, tools, frameworks"
                   pattern="[a-zA-Z0-9_-]+" />
            <small style="color: var(--color-text-muted); font-size: 0.75rem;">
              Only letters, numbers, underscores, and hyphens allowed
            </small>
          </div>
        `,
        submitText: 'Create',
        onSubmit: (modal) => {
          const input = modal.querySelector('#table-name-input');
          const name = input.value.trim();
          if (!name) {
            toast.error('Please enter a table name');
            return false;
          }
          if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
            toast.error('Invalid name format');
            return false;
          }
          return name;
        },
      });
      
      if (result) {
        try {
          await api.createTable(result);
          toast.success(`Table "${result}" created`);
          pages.home(); // Refresh
        } catch (err) {
          toast.error(err.message);
        }
      }
    };
    
    try {
      const tables = await api.getTables();
      
      if (tables.length === 0) {
        main.innerHTML = `
          <div class="page-header">
            <div>
              <h1 class="page-title">Skill Tables</h1>
              <p class="page-description">Manage your skills knowledge base</p>
            </div>
            <button class="btn btn-primary btn-lg" id="create-table-btn">
              + New Table
            </button>
          </div>
          <div class="empty-state">
            <div class="empty-state-icon">📚</div>
            <h2 class="empty-state-title">No tables yet</h2>
            <p class="empty-state-description">
              Create your first skill table to get started
            </p>
          </div>
        `;
        document.getElementById('create-table-btn').onclick = async () => {
          const result = await showModal({
            title: 'Create New Table',
            content: `
              <div class="input-group">
                <label class="input-label">Table Name</label>
                <input type="text" class="input" id="table-name-input" 
                       placeholder="e.g., programming, tools, frameworks" />
              </div>
            `,
            submitText: 'Create',
            onSubmit: (modal) => modal.querySelector('#table-name-input').value.trim() || false,
          });
          
          if (result) {
            try {
              await api.createTable(result);
              toast.success(`Table "${result}" created`);
              pages.home();
            } catch (err) {
              toast.error(err.message);
            }
          }
        };
        return;
      }
      
      const grid = document.createElement('div');
      grid.className = 'tables-grid';
      
      for (const table of tables) {
        const card = document.createElement('div');
        card.className = 'card card-clickable table-card';
        card.innerHTML = `
          <div class="table-card-header">
            <div>
              <div class="table-card-name">${escapeHtml(table.name)}</div>
              <span class="table-card-count">${table.count} entries</span>
            </div>
            <div class="table-card-actions">
              <button class="btn btn-danger btn-icon delete-btn" title="Delete table">🗑</button>
            </div>
          </div>
        `;
        
        card.onclick = (e) => {
          if (!e.target.closest('.delete-btn')) {
            window.location.hash = `/table/${encodeURIComponent(table.name)}`;
          }
        };
        
        card.querySelector('.delete-btn').onclick = async (e) => {
          e.stopPropagation();
          const confirmed = await showModal({
            title: 'Delete Table',
            content: `
              <p>Are you sure you want to delete <strong>${escapeHtml(table.name)}</strong>?</p>
              <p style="color: var(--color-text-muted); margin-top: var(--spacing-sm);">
                This will permanently delete all ${table.count} entries.
              </p>
            `,
            submitText: 'Delete',
            onSubmit: () => true,
          });
          
          if (confirmed) {
            try {
              await api.deleteTable(table.name);
              toast.success(`Table "${table.name}" deleted`);
              pages.home();
            } catch (err) {
              toast.error(err.message);
            }
          }
        };
        
        grid.appendChild(card);
      }
      
      main.querySelector('.loading').replaceWith(grid);
    } catch (err) {
      main.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">⚠️</div>
          <h2 class="empty-state-title">Error loading tables</h2>
          <p class="empty-state-description">${escapeHtml(err.message)}</p>
          <button class="btn btn-primary" onclick="pages.home()">Retry</button>
        </div>
      `;
    }
  },
  
  // Table View Page - View/edit entries
  async tableView(tableName) {
    const main = document.getElementById('main-content');
    let currentEntries = [];
    let isSearchMode = false;
    
    main.innerHTML = `
      <div class="table-view-header">
        <a href="#/" class="back-link">← Back to tables</a>
        <div class="page-header">
          <div>
            <h1 class="page-title">${escapeHtml(tableName)}</h1>
          </div>
          <button class="btn btn-primary" id="add-entry-btn">+ Add Entry</button>
        </div>
      </div>
      
      <div class="table-view-toolbar">
        <div class="search-bar">
          <span class="search-icon">🔍</span>
          <input type="text" class="input" id="search-input" 
                 placeholder="Semantic search... (press Enter)" />
        </div>
        <button class="btn btn-secondary" id="clear-search-btn" style="display: none;">
          Clear Search
        </button>
      </div>
      
      <div id="entries-container">
        <div class="loading"><div class="spinner"></div></div>
      </div>
    `;
    
    const searchInput = document.getElementById('search-input');
    const clearSearchBtn = document.getElementById('clear-search-btn');
    const entriesContainer = document.getElementById('entries-container');
    
    // Add entry handler
    document.getElementById('add-entry-btn').onclick = async () => {
      const result = await showModal({
        title: 'Add New Entry',
        content: `
          <div class="input-group">
            <label class="input-label">Content</label>
            <textarea class="input textarea" id="entry-content-input" 
                      placeholder="Enter skill documentation, instructions, or knowledge..."></textarea>
          </div>
        `,
        submitText: 'Add Entry',
        onSubmit: (modal) => {
          const content = modal.querySelector('#entry-content-input').value.trim();
          if (!content) {
            toast.error('Please enter some content');
            return false;
          }
          return content;
        },
      });
      
      if (result) {
        try {
          await api.addEntry(tableName, result);
          toast.success('Entry added');
          loadEntries();
        } catch (err) {
          toast.error(err.message);
        }
      }
    };
    
    // Search handler
    searchInput.onkeydown = async (e) => {
      if (e.key === 'Enter') {
        const query = searchInput.value.trim();
        if (!query) return;
        
        entriesContainer.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
        
        try {
          currentEntries = await api.searchEntries(tableName, query);
          isSearchMode = true;
          clearSearchBtn.style.display = 'block';
          renderEntries();
        } catch (err) {
          toast.error(err.message);
        }
      }
    };
    
    // Clear search handler
    clearSearchBtn.onclick = () => {
      searchInput.value = '';
      isSearchMode = false;
      clearSearchBtn.style.display = 'none';
      loadEntries();
    };
    
    // Load entries
    async function loadEntries() {
      entriesContainer.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
      
      try {
        currentEntries = await api.getEntries(tableName);
        isSearchMode = false;
        renderEntries();
      } catch (err) {
        entriesContainer.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">⚠️</div>
            <h2 class="empty-state-title">Error loading entries</h2>
            <p class="empty-state-description">${escapeHtml(err.message)}</p>
          </div>
        `;
      }
    }
    
    // Render entries
    function renderEntries() {
      if (currentEntries.length === 0) {
        entriesContainer.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">${isSearchMode ? '🔍' : '📝'}</div>
            <h2 class="empty-state-title">${isSearchMode ? 'No results found' : 'No entries yet'}</h2>
            <p class="empty-state-description">
              ${isSearchMode ? 'Try a different search query' : 'Add your first entry to this table'}
            </p>
          </div>
        `;
        return;
      }
      
      const list = document.createElement('div');
      list.className = 'entries-list';
      
      for (const entry of currentEntries) {
        const card = document.createElement('div');
        card.className = 'card entry-card';
        
        const hasDistance = entry._distance !== undefined;
        const similarity = hasDistance ? ((1 - entry._distance) * 100).toFixed(1) : null;
        
        card.innerHTML = `
          <div class="entry-card-header">
            <div class="entry-card-meta">
              ${hasDistance ? `<span class="entry-score">${similarity}% match</span>` : ''}
              <span>Updated ${formatDate(entry.updatedAt)}</span>
            </div>
            <div class="entry-card-actions">
              <button class="btn btn-ghost btn-icon edit-btn" title="Edit">✏️</button>
              <button class="btn btn-danger btn-icon delete-btn" title="Delete">🗑</button>
            </div>
          </div>
          <div class="entry-content">${escapeHtml(entry.content)}</div>
          ${entry.content.length > 300 ? '<button class="btn btn-ghost entry-expand-btn">Show more</button>' : ''}
        `;
        
        // Expand/collapse
        const contentEl = card.querySelector('.entry-content');
        const expandBtn = card.querySelector('.entry-expand-btn');
        if (expandBtn) {
          expandBtn.onclick = () => {
            contentEl.classList.toggle('expanded');
            expandBtn.textContent = contentEl.classList.contains('expanded') ? 'Show less' : 'Show more';
          };
        }
        
        // Edit handler
        card.querySelector('.edit-btn').onclick = async () => {
          const result = await showModal({
            title: 'Edit Entry',
            content: `
              <div class="input-group">
                <label class="input-label">Content</label>
                <textarea class="input textarea" id="entry-content-input">${escapeHtml(entry.content)}</textarea>
              </div>
            `,
            submitText: 'Save Changes',
            onSubmit: (modal) => {
              const content = modal.querySelector('#entry-content-input').value.trim();
              if (!content) {
                toast.error('Content cannot be empty');
                return false;
              }
              return content;
            },
          });
          
          if (result) {
            try {
              await api.updateEntry(tableName, entry.id, result);
              toast.success('Entry updated');
              loadEntries();
            } catch (err) {
              toast.error(err.message);
            }
          }
        };
        
        // Delete handler
        card.querySelector('.delete-btn').onclick = async () => {
          const confirmed = await showModal({
            title: 'Delete Entry',
            content: `
              <p>Are you sure you want to delete this entry?</p>
              <div style="margin-top: var(--spacing-md); padding: var(--spacing-md); 
                          background: var(--color-bg); border-radius: var(--radius-md);
                          font-family: var(--font-mono); font-size: 0.8rem;
                          max-height: 100px; overflow: hidden; color: var(--color-text-muted);">
                ${escapeHtml(truncate(entry.content, 200))}
              </div>
            `,
            submitText: 'Delete',
          });
          
          if (confirmed) {
            try {
              await api.deleteEntry(tableName, entry.id);
              toast.success('Entry deleted');
              loadEntries();
            } catch (err) {
              toast.error(err.message);
            }
          }
        };
        
        list.appendChild(card);
      }
      
      entriesContainer.innerHTML = '';
      entriesContainer.appendChild(list);
    }
    
    loadEntries();
  },
};

// ============================================================================
// Router
// ============================================================================

function router() {
  const hash = window.location.hash.slice(1) || '/';
  
  if (hash === '/') {
    pages.home();
  } else if (hash.startsWith('/table/')) {
    const tableName = decodeURIComponent(hash.slice(7));
    pages.tableView(tableName);
  } else {
    // 404 - redirect to home
    window.location.hash = '/';
  }
}

// ============================================================================
// Initialize
// ============================================================================

window.addEventListener('hashchange', router);
window.addEventListener('DOMContentLoaded', () => {
  toast.init();
  router();
});

// Expose pages for retry buttons
window.pages = pages;
