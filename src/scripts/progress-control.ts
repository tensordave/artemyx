import type { Map as MaplibreMap, IControl } from 'maplibre-gl';

interface ProgressState {
  operation: string;
  status: 'idle' | 'loading' | 'processing' | 'success' | 'error';
  message?: string;
  timestamp?: number;
}

interface HistoryEntry extends ProgressState {
  timestamp: number; // Required for history entries
}

export class ProgressControl implements IControl {
  private map?: MaplibreMap;
  private container?: HTMLDivElement;
  private statusLine?: HTMLDivElement;
  private expandedPanel?: HTMLDivElement;
  private historyContainer?: HTMLDivElement;
  private minimizeButton?: HTMLButtonElement;
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
    this.container = document.createElement('div');
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group progress-control';

    // Create the status line container (collapsed state)
    this.statusLine = document.createElement('div');
    this.statusLine.className = 'progress-status-line';
    this.statusLine.textContent = 'Ready';
    this.statusLine.addEventListener('click', () => this.toggleExpansion());

    // Create the expanded panel (hidden by default)
    this.expandedPanel = document.createElement('div');
    this.expandedPanel.className = 'progress-expanded-panel';
    this.expandedPanel.style.display = 'none';

    // Create panel header with minimize button
    const header = document.createElement('div');
    header.className = 'progress-panel-header';

    const title = document.createElement('span');
    title.textContent = 'Progress History';
    header.appendChild(title);

    this.minimizeButton = document.createElement('button');
    this.minimizeButton.className = 'progress-minimize-btn';
    this.minimizeButton.textContent = '−';
    this.minimizeButton.title = 'Minimize';
    this.minimizeButton.addEventListener('click', () => this.toggleExpansion());
    header.appendChild(this.minimizeButton);

    this.expandedPanel.appendChild(header);

    // Create scrollable history container
    this.historyContainer = document.createElement('div');
    this.historyContainer.className = 'progress-history-container';
    this.expandedPanel.appendChild(this.historyContainer);

    this.container.appendChild(this.statusLine);
    this.container.appendChild(this.expandedPanel);

    return this.container;
  }

  onRemove(): void {
    this.container?.parentNode?.removeChild(this.container);
    this.map = undefined;
  }

  /**
   * Update the progress display with current operation status
   */
  updateProgress(operation: string, status: ProgressState['status'], message?: string): void {
    // Cancel any pending idle — new work is coming in
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
   * Toggle between collapsed (status line) and expanded (history panel) views
   */
  private toggleExpansion(): void {
    this.isExpanded = !this.isExpanded;

    if (this.statusLine && this.expandedPanel) {
      if (this.isExpanded) {
        this.statusLine.style.display = 'none';
        this.expandedPanel.style.display = 'flex';
        this.renderHistory();
      } else {
        this.statusLine.style.display = 'block';
        this.expandedPanel.style.display = 'none';
      }
    }
  }

  /**
   * Render the history entries with timestamps
   */
  private renderHistory(): void {
    if (!this.historyContainer) return;

    const container = this.historyContainer; // Capture for use in forEach

    // Clear existing content
    container.innerHTML = '';

    // Render each history entry
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

    // Auto-scroll to bottom
    container.scrollTop = container.scrollHeight;
  }

  /**
   * Format timestamp as HH:MM:SS
   */
  private formatTimestamp(timestamp: number): string {
    const date = new Date(timestamp);
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
  }

  /**
   * Get status symbol for history entries
   */
  private getStatusSymbol(status: ProgressState['status']): string {
    switch (status) {
      case 'loading':
      case 'processing':
        return '>';
      case 'success':
        return '✓';
      case 'error':
        return '✗';
      case 'idle':
        return '-';
    }
  }

  /**
   * Get status text for history entry
   */
  private getStatusText(entry: HistoryEntry): string {
    const { operation, status, message } = entry;

    switch (status) {
      case 'idle':
        return 'Ready';
      case 'loading':
        return `Downloading ${operation}...`;
      case 'processing':
        return `Processing ${operation}...`;
      case 'success':
        return message || `${operation} complete`;
      case 'error':
        return `Error: ${message || operation}`;
    }
  }

  /**
   * Render the current state to the UI
   */
  private render(): void {
    if (!this.statusLine) return;

    const { operation, status, message } = this.state;

    // Build the status text with terminal-like formatting
    let statusText = '';
    let statusClass = '';

    switch (status) {
      case 'idle':
        statusText = 'Ready';
        statusClass = 'status-idle';
        break;
      case 'loading':
        statusText = `> Downloading ${operation}...`;
        statusClass = 'status-loading';
        break;
      case 'processing':
        statusText = `> Processing ${operation}...`;
        statusClass = 'status-processing';
        break;
      case 'success':
        statusText = message || `✓ ${operation} complete`;
        statusClass = 'status-success';
        break;
      case 'error':
        statusText = `✗ Error: ${message || operation}`;
        statusClass = 'status-error';
        break;
    }

    this.statusLine.textContent = statusText;
    this.statusLine.className = `progress-status-line ${statusClass}`;

    // If expanded, also update the history view
    if (this.isExpanded) {
      this.renderHistory();
    }
  }
}
