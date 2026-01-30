/**
 * ToolUI - Server-side API for tools to create custom UI interfaces
 * 
 * This module provides a simple API for tools to:
 * 1. Create custom visual interfaces with HTML
 * 2. Update the UI state during execution
 * 3. Communicate with the client-side UI
 * 
 * Usage in tools:
 * ```javascript
 * // Create a UI instance
 * const ui = toolUI.create({
 *   label: 'Searching the web...',
 *   labelFinished: 'Searched the web',
 *   html: '<div class="search-progress">...</div>',
 *   height: 200
 * });
 * 
 * // Update the UI during execution
 * ui.update({ data: { progress: 50, status: 'Analyzing results...' } });
 * 
 * // Finish the UI
 * ui.finish();
 * ```
 */

import { randomUUID } from 'crypto';

/**
 * Creates a ToolUI manager that can be injected into tool execution context
 */
export class ToolUIManager {
  constructor(emit) {
    this.emit = emit;
    this.activeUIs = new Map();
  }

  /**
   * Create a new custom UI instance
   * @param {Object} config - UI configuration
   * @param {string} config.label - Label shown while processing (e.g., "Searching...")
   * @param {string} [config.labelFinished] - Label shown when done (e.g., "Searched")
   * @param {string} config.html - HTML content for the custom interface
   * @param {number} [config.height] - Height of the UI area in pixels (default: auto)
   * @param {Object} [config.data] - Initial data to pass to the UI
   * @returns {ToolUIInstance} UI instance with update/finish methods
   */
  create(config) {
    const uiId = randomUUID();
    const startTime = Date.now();

    // Emit UI start event
    if (this.emit) {
      this.emit('tool:ui:start', {
        uiId,
        label: config.label || 'Processing...',
        labelFinished: config.labelFinished,
        html: config.html || '',
        height: config.height,
        data: config.data || {}
      });
    }

    const instance = new ToolUIInstance(uiId, this.emit, startTime);
    this.activeUIs.set(uiId, instance);
    
    return instance;
  }

  /**
   * Finish all active UIs
   */
  finishAll() {
    for (const [uiId, instance] of this.activeUIs) {
      if (!instance.isFinished) {
        instance.finish();
      }
    }
    this.activeUIs.clear();
  }
}

/**
 * Individual UI instance for a single tool UI
 */
class ToolUIInstance {
  constructor(uiId, emit, startTime) {
    this.uiId = uiId;
    this.emit = emit;
    this.startTime = startTime;
    this.isFinished = false;
  }

  /**
   * Update the UI state
   * @param {Object} updates - What to update
   * @param {string} [updates.label] - New label text
   * @param {string} [updates.html] - New HTML content
   * @param {number} [updates.height] - New height
   * @param {Object} [updates.data] - Data to merge with existing data
   */
  update(updates) {
    if (this.isFinished) return;

    if (this.emit) {
      this.emit('tool:ui:update', {
        uiId: this.uiId,
        ...updates
      });
    }
  }

  /**
   * Mark the UI as finished
   * @param {boolean} [allDone=true] - Whether all UIs in the block are done
   */
  finish(allDone = true) {
    if (this.isFinished) return;
    
    this.isFinished = true;
    const duration = Date.now() - this.startTime;

    if (this.emit) {
      this.emit('tool:ui:end', {
        uiId: this.uiId,
        duration,
        allDone
      });
    }
  }
}

/**
 * Create a ToolUI manager bound to an emit function
 * This is typically called from executor to inject into tool context
 */
export function createToolUIManager(emit) {
  return new ToolUIManager(emit);
}

/**
 * HTML Templates for common UI patterns
 * Tools can use these as a base or inspiration
 */
export const UITemplates = {
  /**
   * Progress bar template
   * Data: { progress: number (0-100), status: string }
   */
  progressBar: `
    <div style="padding: 16px; font-family: Inter, sans-serif;">
      <div style="margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
        <span id="status" style="color: #a1a1aa; font-size: 13px;">Initializing...</span>
        <span id="percent" style="color: #06b6d4; font-size: 13px; font-weight: 500;">0%</span>
      </div>
      <div style="height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden;">
        <div id="progress" style="height: 100%; width: 0%; background: linear-gradient(90deg, #06b6d4, #22d3ee); border-radius: 3px; transition: width 0.3s ease;"></div>
      </div>
    </div>
    <script>
      toolUI.onUpdate = function(data) {
        document.getElementById('progress').style.width = (data.progress || 0) + '%';
        document.getElementById('percent').textContent = (data.progress || 0) + '%';
        if (data.status) document.getElementById('status').textContent = data.status;
      };
    </script>
  `,

  /**
   * Search results template
   * Data: { query: string, results: Array<{title, url, snippet}>, status: string }
   */
  searchResults: `
    <div style="padding: 16px; font-family: Inter, sans-serif;">
      <div id="query" style="color: #71717a; font-size: 12px; margin-bottom: 12px; display: flex; align-items: center; gap: 8px;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
        </svg>
        <span id="query-text">Searching...</span>
      </div>
      <div id="status" style="color: #a1a1aa; font-size: 13px; margin-bottom: 12px;"></div>
      <div id="results" style="display: flex; flex-direction: column; gap: 10px;"></div>
    </div>
    <script>
      toolUI.onUpdate = function(data) {
        if (data.query) {
          document.getElementById('query-text').textContent = '"' + data.query + '"';
        }
        if (data.status) {
          document.getElementById('status').textContent = data.status;
        }
        if (data.results && data.results.length > 0) {
          const container = document.getElementById('results');
          container.innerHTML = data.results.map(function(r) {
            return '<div style="padding: 10px; background: rgba(255,255,255,0.03); border-radius: 8px; border: 1px solid rgba(255,255,255,0.06);">' +
              '<div style="color: #22d3ee; font-size: 13px; font-weight: 500; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">' + (r.title || 'Result') + '</div>' +
              '<div style="color: #71717a; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">' + (r.url || '') + '</div>' +
              (r.snippet ? '<div style="color: #a1a1aa; font-size: 12px; margin-top: 6px; line-height: 1.4;">' + r.snippet + '</div>' : '') +
            '</div>';
          }).join('');
        }
      };
    </script>
  `,

  /**
   * Stages/Steps template
   * Data: { stages: Array<{name, status: 'pending'|'active'|'done'}>, currentStage: number }
   */
  stages: `
    <div style="padding: 16px; font-family: Inter, sans-serif;">
      <div id="stages" style="display: flex; flex-direction: column; gap: 8px;"></div>
    </div>
    <script>
      toolUI.onUpdate = function(data) {
        if (data.stages) {
          const container = document.getElementById('stages');
          container.innerHTML = data.stages.map(function(s, i) {
            var icon = s.status === 'done' ? '✓' : s.status === 'active' ? '●' : '○';
            var color = s.status === 'done' ? '#22c55e' : s.status === 'active' ? '#06b6d4' : '#52525b';
            var textColor = s.status === 'active' ? '#e4e4e7' : s.status === 'done' ? '#a1a1aa' : '#71717a';
            return '<div style="display: flex; align-items: center; gap: 10px;">' +
              '<span style="color: ' + color + '; font-size: 14px; width: 16px; text-align: center;">' + icon + '</span>' +
              '<span style="color: ' + textColor + '; font-size: 13px;' + (s.status === 'active' ? ' font-weight: 500;' : '') + '">' + s.name + '</span>' +
            '</div>';
          }).join('');
        }
      };
    </script>
  `
};

export default { ToolUIManager, createToolUIManager, UITemplates };

