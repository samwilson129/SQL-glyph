(function () {
  const {
    post,
    onMessage,
    el,
    clear,
    badge,
    button,
    addButton,
    severityKind,
    sectionTitle,
    codeBlock,
    empty,
    formatMs,
    plural,
    statusKind
  } = window.SqlGlyph;

  const app = document.getElementById('app');
  let state = null;
  let severityFilter = 'all';

  onMessage(function (message) {
    if (message.type === 'state') {
      state = message.state;
      render();
    }
  });

  function revealButton(span) {
    const node = button('Reveal', 'reveal', { span: span }, 'ghost');
    node.title = 'Reveal this location in the source editor';
    return node;
  }

  function stat(value, label) {
    const box = el('div', 'stat');
    box.appendChild(el('div', 'value', String(value)));
    box.appendChild(el('div', 'label', label));
    return box;
  }

  function diagnosticItem(diagnostic) {
    const item = el('div', 'list-item ' + severityKind(diagnostic.severity));
    const head = el('div', 'item-head');
    head.appendChild(badge(diagnostic.severity, diagnostic.severity));
    head.appendChild(
      el(
        'span',
        'item-meta',
        diagnostic.category + (diagnostic.ruleId ? ' · ' + diagnostic.ruleId : '')
      )
    );
    if (diagnostic.confidence) {
      head.appendChild(el('span', 'item-meta', diagnostic.confidence + ' confidence'));
    }
    if (diagnostic.span) {
      head.appendChild(revealButton(diagnostic.span));
    }
    item.appendChild(head);
    item.appendChild(el('p', 'item-body', diagnostic.message));
    if (diagnostic.detail) {
      item.appendChild(el('p', 'item-detail', diagnostic.detail));
    }
    if (diagnostic.expression) {
      item.appendChild(codeBlock(diagnostic.expression));
    }
    return item;
  }

  function transformationItem(transformation) {
    const box = el('div', 'transformation');
    const head = el('div', 'item-head');
    head.appendChild(badge(transformation.category, 'neutral'));
    head.appendChild(el('span', 'item-meta', transformation.nodeType));
    head.appendChild(
      el('span', 'item-meta', 'statement ' + (transformation.statementIndex + 1))
    );
    if (transformation.span) {
      head.appendChild(revealButton(transformation.span));
    }
    box.appendChild(head);

    const pair = el('div', 'pair');
    pair.appendChild(codeBlock(transformation.original));
    pair.appendChild(el('div', 'arrow-row', '↓'));
    pair.appendChild(codeBlock(transformation.converted));
    box.appendChild(pair);

    if (transformation.explanation) {
      box.appendChild(el('p', 'explanation', transformation.explanation));
      if (transformation.detail) {
        box.appendChild(el('p', 'item-detail', transformation.detail));
      }
    } else {
      box.appendChild(
        el(
          'p',
          'explanation unexplained',
          'No rule-based explanation is available. Review this transformation manually; SQL Glyph does not invent reasons.'
        )
      );
    }

    box.appendChild(
      el(
        'div',
        'item-meta',
        'confidence: ' +
          transformation.confidence +
          (transformation.ruleId ? ' · rule: ' + transformation.ruleId : '')
      )
    );
    return box;
  }

  function renderDiagnostics() {
    const section = el('details', 'section');
    section.open = true;
    const right = el('div', 'filters');
    const counts = {
      all: state.diagnostics.length,
      error: 0,
      warning: 0,
      info: 0
    };
    for (const diagnostic of state.diagnostics) {
      if (counts[diagnostic.severity] !== undefined) {
        counts[diagnostic.severity] += 1;
      }
    }
    for (const key of ['all', 'error', 'warning', 'info']) {
      const filter = el(
        'button',
        'secondary' + (severityFilter === key ? ' active' : ''),
        key === 'all' ? 'All ' + counts.all : key + ' ' + counts[key]
      );
      filter.type = 'button';
      filter.addEventListener('click', function () {
        severityFilter = key;
        render();
      });
      right.appendChild(filter);
    }
    const summary = el('summary');
    summary.appendChild(el('span', '', 'Diagnostics'));
    summary.appendChild(right);
    section.appendChild(summary);

    const filtered = state.diagnostics.filter(function (diagnostic) {
      return severityFilter === 'all' || diagnostic.severity === severityFilter;
    });

    if (filtered.length === 0) {
      section.appendChild(empty('No diagnostics in this category.'));
      return section;
    }

    const list = el('div', 'list');
    for (const diagnostic of filtered) {
      list.appendChild(diagnosticItem(diagnostic));
    }
    section.appendChild(list);
    return section;
  }

  function renderTransformations() {
    const section = el('details', 'section');
    section.open = true;
    const right = el('div', 'filters');
    right.appendChild(badge(state.transformations.length + ' total', 'neutral'));
    if (state.metadata.transformationsTruncated) {
      right.appendChild(badge('truncated', 'warning'));
    }
    const summary = el('summary');
    summary.appendChild(el('span', '', 'Transformations'));
    summary.appendChild(right);
    section.appendChild(summary);

    if (state.transformations.length === 0) {
      section.appendChild(empty('No structural transformations were detected.'));
      return section;
    }

    const list = el('div', 'list');
    for (const transformation of state.transformations) {
      list.appendChild(transformationItem(transformation));
    }
    section.appendChild(list);
    return section;
  }

  function renderDiff() {
    const section = el('details', 'section');
    section.open = false;
    const right = el('div', 'filters');
    right.appendChild(badge('+' + state.diff.added, 'success'));
    right.appendChild(badge('−' + state.diff.removed, 'unsupported'));
    const summary = el('summary');
    summary.appendChild(el('span', '', 'Text diff'));
    summary.appendChild(right);
    section.appendChild(summary);

    if (!state.diff.changed) {
      section.appendChild(empty('The generated SQL has no textual changes.'));
      return section;
    }

    const diff = el('div', 'diff');
    for (const row of state.diff.rows) {
      const line = el('div', 'diff-row ' + row.type);
      line.appendChild(el('span', 'line-no', row.oldLine === null ? '' : row.oldLine));
      line.appendChild(el('span', 'line-no', row.newLine === null ? '' : row.newLine));
      line.appendChild(
        el('span', 'sign', row.type === 'added' ? '+' : row.type === 'removed' ? '−' : '')
      );
      line.appendChild(el('span', 'text', row.text.length > 0 ? row.text : ' '));
      diff.appendChild(line);
    }
    section.appendChild(diff);
    if (state.diff.truncated) {
      section.appendChild(el('p', 'note', 'The diff was truncated for display.'));
    }
    return section;
  }

  function renderMetadata() {
    const section = el('details', 'section');
    section.open = false;
    const summary = el('summary');
    summary.appendChild(el('span', '', 'Metadata'));
    section.appendChild(summary);

    const metadata = el('div', 'metadata');
    const entries = [
      ['Source dialect', state.metadata.sourceDialect],
      ['Target dialect', state.metadata.targetDialect],
      ['Statements', state.metadata.statementCount],
      ['Input statements', state.metadata.inputStatementCount ?? state.metadata.statementCount],
      ['Partial result', state.metadata.partial ? 'yes' : 'no'],
      ['Statement errors', state.metadata.statementErrorCount ?? 0],
      ['Round-trip verified', state.metadata.roundTripVerified === false ? 'no' : 'yes'],
      ['Pretty printed', state.metadata.pretty ? 'yes' : 'no'],
      ['Elapsed', formatMs(state.metadata.elapsedMs)],
      ['SQLGlot', state.metadata.sqlglotVersion],
      ['Engine', state.metadata.engineVersion],
      ['Same dialect', state.metadata.sameDialect ? 'yes' : 'no'],
      ['Executed', state.metadata.executed ? 'yes' : 'no'],
      ['Database connected', state.metadata.databaseConnected ? 'yes' : 'no'],
      ['Semantically verified', state.metadata.semanticallyVerified ? 'yes' : 'no'],
      ['Local processing', state.metadata.localProcessing ? 'yes' : 'no']
    ];
    for (const entry of entries) {
      const row = el('div');
      row.appendChild(el('span', 'key', entry[0]));
      row.appendChild(el('span', 'value', String(entry[1])));
      metadata.appendChild(row);
    }
    section.appendChild(metadata);

    if (state.metadata.engineWarnings && state.metadata.engineWarnings.length > 0) {
      section.appendChild(el('h3', '', 'Engine warnings'));
      for (const warning of state.metadata.engineWarnings) {
        section.appendChild(el('p', 'item-detail', warning));
      }
    }
    return section;
  }

  function render() {
    clear(app);

    if (!state) {
      app.appendChild(empty('Loading conversion analysis…'));
      return;
    }

    const header = el('div', 'header');
    header.appendChild(el('h1', '', 'Conversion Analysis'));
    header.appendChild(badge(state.statusLabel, statusKind(state.status)));
    app.appendChild(header);
    app.appendChild(el('p', 'tagline', 'Decipher. Transform. Transpile.'));

    const headCard = el('div', 'card');
    const head = el('div', 'result-head');
    head.appendChild(
      el(
        'span',
        'result-title',
        state.fileName + ' · ' + (state.scope === 'selection' ? 'selection' : 'entire file')
      )
    );
    head.appendChild(el('span', 'item-meta', state.sourceLabel + ' → ' + state.targetLabel));
    headCard.appendChild(head);

    const chips = el('div', 'chips');
    chips.appendChild(el('span', 'chip', state.counts.errors + ' errors'));
    chips.appendChild(el('span', 'chip plain', state.counts.warnings + ' warnings'));
    chips.appendChild(el('span', 'chip plain', state.counts.info + ' info'));
    chips.appendChild(el('span', 'chip plain', state.counts.explained + ' explained'));
    chips.appendChild(el('span', 'chip plain', state.counts.unexplained + ' unexplained'));
    headCard.appendChild(chips);

    const toolbar = el('div', 'toolbar');
    addButton(toolbar, 'Copy Result', 'copy');
    addButton(toolbar, 'Show Diff', 'showDiff', null, 'secondary');
    addButton(toolbar, 'Replace…', 'replace', null, 'secondary');
    addButton(toolbar, 'Save As…', 'saveAs', null, 'secondary');
    addButton(toolbar, 'Open Result', 'openResult', null, 'secondary');
    addButton(toolbar, 'Engine Output', 'showOutput', null, 'ghost');
    headCard.appendChild(toolbar);
    app.appendChild(headCard);

    const stats = el('div', 'stats');
    stats.appendChild(stat(state.counts.errors, 'Errors'));
    stats.appendChild(stat(state.counts.warnings, 'Warnings'));
    stats.appendChild(stat(state.counts.info, 'Info'));
    stats.appendChild(stat(state.counts.explained, 'Explained'));
    stats.appendChild(stat(state.counts.unexplained, 'Unexplained'));
    app.appendChild(stats);

    app.appendChild(renderDiagnostics());
    app.appendChild(renderTransformations());
    app.appendChild(renderDiff());
    app.appendChild(renderMetadata());

    app.appendChild(el('p', 'note', state.note));
  }

  post('ready');
})();
