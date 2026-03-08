import type { Map as MaplibreMap, IControl } from 'maplibre-gl';
import { circleIcon, circleNotchIcon, cloudArrowDownIcon, databaseIcon, trashIcon } from '../icons';

interface ProgressState {
  operation: string;
  status: 'idle' | 'loading' | 'processing' | 'success' | 'error';
  message?: string;
  timestamp?: number;
  iconOverride?: string;
}

interface HistoryEntry extends ProgressState {
  timestamp: number; // Required for history entries
}

export class ProgressControl implements IControl {
  private map?: MaplibreMap;
  private container?: HTMLDivElement;
  private mapContainer?: HTMLElement;
  private statusRow?: HTMLDivElement;
  private iconBase?: HTMLSpanElement;
  private iconInner?: HTMLSpanElement;
  private statusText?: HTMLSpanElement;
  private expandedPanel?: HTMLDivElement;
  private historyContainer?: HTMLDivElement;
  private minimizeButton?: HTMLButtonElement;
  private clearHistoryButton?: HTMLButtonElement;
  private state: ProgressState = {
    operation: '',
    status: 'idle',
  };
  private history: HistoryEntry[] = [];
  private readonly MAX_HISTORY = 100;
  private isExpanded = false;
  private _idleTimeout?: ReturnType<typeof setTimeout>;

  onAdd(map: MaplibreMap): HTMLElement {
    this.map = map;
    this.mapContainer = map.getContainer();
    this.container = document.createElement('div');
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group progress-control';

    // Collapsed state: icon + text row
    this.statusRow = document.createElement('div');
    this.statusRow.className = 'progress-status-row status-idle';
    this.statusRow.addEventListener('click', () => this.toggleExpansion());

    // Composite icon: base circle ring + state-driven inner icon
    const iconWrapper = document.createElement('div');
    iconWrapper.className = 'progress-icon-wrapper';

    this.iconBase = document.createElement('span');
    this.iconBase.className = 'progress-icon-base';
    this.iconBase.innerHTML = circleIcon;

    this.iconInner = document.createElement('span');
    this.iconInner.className = 'progress-icon-inner';

    iconWrapper.appendChild(this.iconBase);
    iconWrapper.appendChild(this.iconInner);

    // Text label (hidden on mobile via CSS)
    this.statusText = document.createElement('span');
    this.statusText.className = 'progress-status-text';
    this.statusText.textContent = 'Ready';

    this.statusRow.appendChild(iconWrapper);
    this.statusRow.appendChild(this.statusText);

    // Expanded panel (hidden by default) - unchanged from before
    this.expandedPanel = document.createElement('div');
    this.expandedPanel.className = 'progress-expanded-panel';
    this.expandedPanel.style.display = 'none';

    const header = document.createElement('div');
    header.className = 'progress-panel-header';

    const title = document.createElement('span');
    title.textContent = 'Progress History';
    header.appendChild(title);

    const headerButtons = document.createElement('div');
    headerButtons.className = 'progress-header-buttons';

    this.clearHistoryButton = document.createElement('button');
    this.clearHistoryButton.className = 'progress-clear-history-btn';
    this.clearHistoryButton.innerHTML = trashIcon;
    this.clearHistoryButton.title = 'Clear history';
    this.clearHistoryButton.addEventListener('click', () => this.clearHistory());
    headerButtons.appendChild(this.clearHistoryButton);

    this.minimizeButton = document.createElement('button');
    this.minimizeButton.className = 'progress-minimize-btn';
    this.minimizeButton.textContent = '\u2212';
    this.minimizeButton.title = 'Minimize';
    this.minimizeButton.addEventListener('click', () => this.toggleExpansion());
    headerButtons.appendChild(this.minimizeButton);

    header.appendChild(headerButtons);

    this.expandedPanel.appendChild(header);

    this.historyContainer = document.createElement('div');
    this.historyContainer.className = 'progress-history-container';
    this.expandedPanel.appendChild(this.historyContainer);

    this.container.appendChild(this.statusRow);
    this.mapContainer.appendChild(this.expandedPanel);

    return this.container;
  }

  onRemove(): void {
    this.container?.parentNode?.removeChild(this.container);
    this.expandedPanel?.parentNode?.removeChild(this.expandedPanel);
    this.map = undefined;
    this.mapContainer = undefined;
  }

  /**
   * Update the progress display with current operation status
   */
  updateProgress(operation: string, status: ProgressState['status'], message?: string, iconOverride?: string): void {
    // Cancel any pending idle - new work is coming in
    if (this._idleTimeout) {
      clearTimeout(this._idleTimeout);
      this._idleTimeout = undefined;
    }

    const timestamp = Date.now();

    this.state = {
      operation,
      status,
      message,
      timestamp,
      iconOverride,
    };

    // Append to history
    this.history.push({
      operation,
      status,
      message,
      timestamp,
    });

    // Cap history at MAX_HISTORY entries (drop oldest)
    if (this.history.length > this.MAX_HISTORY) {
      this.history.shift();
    }

    this.render();
  }

  /**
   * Inject pre-recorded history entries (e.g. from DB init that ran before the control mounted).
   * Entries are prepended to history with their original timestamps.
   */
  injectHistory(entries: Array<{ message: string; timestamp: number }>): void {
    const mapped: HistoryEntry[] = entries.map((e) => ({
      operation: 'database',
      status: 'processing' as const,
      message: e.message,
      timestamp: e.timestamp,
    }));
    this.history.unshift(...mapped);

    // Cap history
    if (this.history.length > this.MAX_HISTORY) {
      this.history = this.history.slice(-this.MAX_HISTORY);
    }

    if (this.isExpanded) {
      this.renderHistory();
    }
  }

  /**
   * Clear the progress display back to idle state (keeps history)
   */
  clear(): void {
    this.state = {
      operation: '',
      status: 'idle',
    };
    this.render();
  }

  /**
   * Clear all history entries and re-render the history panel.
   */
  private clearHistory(): void {
    this.history = [];
    if (this.isExpanded) {
      this.renderHistory();
    }
  }

  /**
   * Schedule a return to idle state after a delay.
   * Automatically cancelled if updateProgress() is called before it fires.
   */
  scheduleIdle(delay: number): void {
    if (this._idleTimeout) {
      clearTimeout(this._idleTimeout);
    }
    this._idleTimeout = setTimeout(() => {
      this._idleTimeout = undefined;
      this.clear();
    }, delay);
  }

  /**
   * Toggle the history panel. The status row stays visible at all times as the persistent toggle target.
   */
  private toggleExpansion(): void {
    this.isExpanded = !this.isExpanded;

    if (this.expandedPanel) {
      if (this.isExpanded) {
        this.expandedPanel.style.display = 'flex';
        this.renderHistory();
      } else {
        this.expandedPanel.style.display = 'none';
      }
    }
  }

  /**
   * Get the inner icon SVG for the current status.
   * Loading gets cloud-arrow-down, processing gets circle-notch (animated via CSS),
   * idle/success/error show no inner icon - status conveyed by color on the base ring.
   */
  private getInnerIconSvg(state: ProgressState): string {
    if (state.iconOverride) return state.iconOverride;
    switch (state.status) {
      case 'loading':
        return cloudArrowDownIcon;
      case 'processing':
        return circleNotchIcon;
      default:
        return '';
    }
  }

  /**
   * Render the current state to the UI
   */
  private render(): void {
    if (!this.statusRow || !this.iconInner || !this.statusText) return;

    const { operation, status, message, iconOverride } = this.state;

    // Update composite icon inner element
    this.iconInner.innerHTML = this.getInnerIconSvg(this.state);

    // Animate inner icon: glow for icon override, spin for processing, pulse for loading
    this.iconInner.classList.remove('spinning', 'pulsing', 'glowing');
    if (iconOverride) {
      this.iconInner.classList.add('glowing');
    } else if (status === 'processing') {
      this.iconInner.classList.add('spinning');
    } else if (status === 'loading') {
      this.iconInner.classList.add('pulsing');
    }

    // Build status text (same logic as before, minus the leading symbols)
    let text = '';
    switch (status) {
      case 'idle':
        text = 'Ready';
        break;
      case 'loading':
        text = message || `Downloading ${operation}...`;
        break;
      case 'processing':
        text = message || `Processing ${operation}...`;
        break;
      case 'success':
        text = message || `${operation} complete`;
        break;
      case 'error':
        text = `Error: ${message || operation}`;
        break;
    }

    this.statusText.textContent = text;

    // Apply status class to the row (drives icon base color via CSS)
    this.statusRow.className = `progress-status-row status-${status}`;

    // If expanded, also update the history view
    if (this.isExpanded) {
      this.renderHistory();
    }
  }

  /**
   * Render the history entries with timestamps
   */
  private renderHistory(): void {
    if (!this.historyContainer) return;

    const container = this.historyContainer;
    container.innerHTML = '';

    this.history.forEach((entry) => {
      const line = document.createElement('div');
      line.className = 'progress-history-entry';

      const timestamp = this.formatTimestamp(entry.timestamp);
      const statusSymbol = this.getStatusSymbol(entry.status);
      const statusText = this.getStatusText(entry);

      line.textContent = `[${timestamp}] ${statusSymbol} ${statusText}`;
      line.classList.add(`status-${entry.status}`);

      container.appendChild(line);
    });

    container.scrollTop = container.scrollHeight;
  }

  private formatTimestamp(timestamp: number): string {
    const date = new Date(timestamp);
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
  }

  private getStatusSymbol(status: ProgressState['status']): string {
    switch (status) {
      case 'loading':
      case 'processing':
        return '>';
      case 'success':
        return '\u2713';
      case 'error':
        return '\u2717';
      case 'idle':
        return '-';
    }
  }

  private getStatusText(entry: HistoryEntry): string {
    const { operation, status, message } = entry;

    switch (status) {
      case 'idle':
        return 'Ready';
      case 'loading':
        return message || `Downloading ${operation}...`;
      case 'processing':
        return message || `Processing ${operation}...`;
      case 'success':
        return message || `${operation} complete`;
      case 'error':
        return `Error: ${message || operation}`;
    }
  }
}
