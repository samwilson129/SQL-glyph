(function () {
  const vscode = acquireVsCodeApi();

  const DIALECT_LABELS = {
    postgres: 'PostgreSQL',
    mysql: 'MySQL',
    tsql: 'Microsoft SQL Server (T-SQL)',
    snowflake: 'Snowflake',
    bigquery: 'Google BigQuery',
    oracle: 'Oracle Database',
    sqlite: 'SQLite',
    duckdb: 'DuckDB',
    spark: 'Spark SQL',
    trino: 'Trino'
  };

  function post(type, data) {
    const message = Object.assign({ type: type }, data || {});
    vscode.postMessage(message);
  }

  function onMessage(handler) {
    window.addEventListener('message', function (event) {
      const message = event.data;
      if (message && typeof message.type === 'string') {
        handler(message);
      }
    });
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined && text !== null) {
      node.textContent = String(text);
    }
    return node;
  }

  function clear(node) {
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function badge(text, kind) {
    return el('span', 'badge ' + (kind || 'neutral'), text);
  }

  function labelFor(id) {
    return DIALECT_LABELS[id] || id || 'Unknown';
  }

  function statusKind(status) {
    if (status === 'success') {
      return 'success';
    }
    if (status === 'warning') {
      return 'warning';
    }
    return 'unsupported';
  }

  function formatMs(value) {
    const number = typeof value === 'number' ? value : 0;
    if (number < 1000) {
      return number + ' ms';
    }
    return (number / 1000).toFixed(2) + ' s';
  }

  function plural(count, singular, many) {
    return count === 1 ? singular : many || singular + 's';
  }

  function button(label, type, data, kind) {
    const node = el('button', kind || '', label);
    node.type = 'button';
    node.addEventListener('click', function () {
      post(type, data);
    });
    return node;
  }

  function addButton(container, label, type, data, kind) {
    const node = button(label, type, data, kind);
    container.appendChild(node);
    return node;
  }

  function statusDot(kind) {
    return el('span', 'status-dot ' + (kind || ''));
  }

  function severityKind(severity) {
    return severity === 'error' ? 'error' : severity === 'warning' ? 'warning' : 'info';
  }

  function sectionTitle(text, right) {
    const head = el('div', 'section-head');
    head.appendChild(el('h2', '', text));
    if (right) {
      head.appendChild(right);
    }
    return head;
  }

  function codeBlock(text) {
    const pre = el('pre');
    pre.textContent = text || '';
    return pre;
  }

  function empty(text) {
    return el('p', 'empty', text);
  }

  window.SqlGlyph = {
    post: post,
    onMessage: onMessage,
    el: el,
    clear: clear,
    badge: badge,
    labelFor: labelFor,
    statusKind: statusKind,
    formatMs: formatMs,
    plural: plural,
    button: button,
    addButton: addButton,
    statusDot: statusDot,
    severityKind: severityKind,
    sectionTitle: sectionTitle,
    codeBlock: codeBlock,
    empty: empty
  };
})();
