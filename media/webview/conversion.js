(function () {
  const {
    post,
    onMessage,
    el,
    clear,
    badge,
    statusKind,
    formatMs,
    plural,
    button,
    addButton,
    statusDot,
    severityKind,
    sectionTitle,
    codeBlock,
    empty
  } = window.SqlGlyph;

  const app = document.getElementById('app');
  let state = null;

  onMessage(function (message) {
    if (message.type === 'state') {
      state = message.state;
      render();
    }
  });

  function chip(label, plain) {
    return el('span', 'chip' + (plain ? ' plain' : ''), label);
  }

  function dialectButton(label, value, type) {
    const node = el('button', 'dialect-button');
    node.type = 'button';
    node.appendChild(el('span', 'label', label));
    node.appendChild(el('span', 'value', value));
    node.title = 'Change the ' + label.toLowerCase() + ' dialect';
    node.addEventListener('click', function () {
      post(type);
    });
    return node;
  }

  function revealButton(span) {
    const node = button('Reveal', 'reveal', { span: span }, 'ghost');
    node.title = 'Reveal this location in the editor';
    return node;
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
    if (diagnostic.span) {
      head.appendChild(revealButton(diagnostic.span));
    }
    item.appendChild(head);
    item.appendChild(el('p', 'item-body', diagnostic.message));
    if (diagnostic.detail) {
      item.appendChild(el('p', 'item-detail', diagnostic.detail));
    }
    return item;
  }

  function transformationItem(transformation) {
    const box = el('div', 'transformation');
    const head = el('div', 'item-head');
    head.appendChild(badge(transformation.category, 'neutral'));
    head.appendChild(el('span', 'item-meta', transformation.nodeType));
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
          'No rule-based explanation. Review this transformation manually.'
        )
      );
    }

    box.appendChild(
      el(
        'div',
        'item-meta',
        transformation.confidence +
          (transformation.review ? ' · ' + transformation.review : '')
      )
    );
    return box;
  }

  function renderEngine() {
    const row = el('div', 'engine-row');
    const kind = state.engine.ready
      ? 'ok'
      : state.engine.status === 'unconfigured' || state.engine.status === 'missing-dependency'
        ? 'warn'
        : 'bad';
    row.appendChild(statusDot(kind));
    row.appendChild(el('span', 'muted small', state.engine.message));
    if (!state.engine.ready) {
      row.appendChild(button('Set up', 'setupEngine', null, 'ghost'));
    }
    return row;
  }

  function renderDialects() {
    const card = el('div', 'card');
    const row = el('div', 'dialect-row');
    row.appendChild(dialectButton('Source', state.sourceSettingLabel, 'selectSource'));
    row.appendChild(el('span', 'arrow', '→'));
    row.appendChild(dialectButton('Target', state.targetSettingLabel, 'selectTarget'));
    card.appendChild(row);

    const actions = el('div', 'actions');
    addButton(actions, 'Convert Selection', 'convertSelection');
    addButton(actions, 'Convert File', 'convertDocument', null, 'secondary');
    addButton(actions, 'Compare', 'compare', null, 'secondary');
    addButton(actions, 'Inspect AST', 'inspectActive', null, 'secondary');
    card.appendChild(actions);

    if (!state.hasActiveEditor) {
      card.appendChild(el('p', 'note', 'Open a SQL file to enable conversions.'));
    }
    return card;
  }

  function renderResult() {
    const card = el('div', 'card');
    const head = el('div', 'result-head');
    head.appendChild(
      el(
        'span',
        'result-title',
        state.fileName + ' · ' + (state.scope === 'selection' ? 'selection' : 'entire file')
      )
    );
    head.appendChild(badge(state.statusLabel, statusKind(state.status)));
    card.appendChild(head);
    card.appendChild(
      el('div', 'result-path', state.sourceLabel + ' → ' + state.targetLabel)
    );

    const chips = el('div', 'chips');
    chips.appendChild(
      chip(state.counts.errors + ' ' + plural(state.counts.errors, 'error'))
    );
    chips.appendChild(
      chip(state.counts.warnings + ' ' + plural(state.counts.warnings, 'warning'))
    );
    chips.appendChild(
      chip(
        state.counts.explained + ' explained',
        true
      )
    );
    if (state.counts.unexplained > 0) {
      chips.appendChild(chip(state.counts.unexplained + ' unexplained', true));
    }
    chips.appendChild(chip(state.statementCount + ' ' + plural(state.statementCount, 'statement'), true));
    chips.appendChild(chip(formatMs(state.elapsedMs), true));
    card.appendChild(chips);

    const actions = el('div', 'actions');
    addButton(actions, 'Show Diff', 'showDiff');
    addButton(actions, 'Analysis', 'showAnalysis', null, 'secondary');
    addButton(actions, 'Copy', 'copy', null, 'secondary');
    addButton(actions, 'Replace', 'replace', null, 'secondary');
    addButton(actions, 'Save As…', 'saveAs', null, 'secondary');
    addButton(actions, 'Open Result', 'openResult', null, 'secondary');
    card.appendChild(actions);

    card.appendChild(
      el(
        'p',
        'note',
        'Not executed. No database connection. Semantic equivalence was not verified.'
      )
    );
    return card;
  }

  function renderDiagnostics() {
    if (!state.diagnostics || state.diagnostics.length === 0) {
      return null;
    }
    const section = el('div', 'section');
    section.appendChild(
      sectionTitle('Diagnostics', badge(state.diagnostics.length + ' shown', 'neutral'))
    );
    const list = el('div', 'list');
    for (const diagnostic of state.diagnostics) {
      list.appendChild(diagnosticItem(diagnostic));
    }
    section.appendChild(list);
    return section;
  }

  function renderTransformations() {
    if (!state.transformations || state.transformations.length === 0) {
      return null;
    }
    const section = el('div', 'section');
    const right = el('div', 'filters');
    right.appendChild(badge(state.transformations.length + ' shown', 'neutral'));
    if (state.transformationsTruncated) {
      right.appendChild(badge('truncated', 'warning'));
    }
    section.appendChild(sectionTitle('Transformations', right));
    const list = el('div', 'list');
    for (const transformation of state.transformations) {
      list.appendChild(transformationItem(transformation));
    }
    section.appendChild(list);
    return section;
  }

  function renderEmpty() {
    const card = el('div', 'card');
    card.appendChild(el('h2', '', 'Ready'));
    card.appendChild(
      el(
        'p',
        'empty',
        'Select SQL in the editor, then convert or inspect the AST. Parsing and generation run locally; no SQL is uploaded.'
      )
    );
    return card;
  }

  function renderFooter() {
    const footer = el('div', 'footer');
    addButton(footer, 'Select Source', 'selectSource', null, 'ghost');
    addButton(footer, 'Select Target', 'selectTarget', null, 'ghost');
    addButton(footer, 'Settings', 'openSettings', null, 'ghost');
    addButton(footer, 'Engine Output', 'showOutput', null, 'ghost');
    return footer;
  }

  function render() {
    clear(app);

    if (!state) {
      app.appendChild(empty('Loading SQL Glyph…'));
      return;
    }

    const header = el('div', 'header');
    header.appendChild(el('h1', '', 'SQL Glyph'));
    header.appendChild(badge('Local', 'neutral'));
    app.appendChild(header);
    app.appendChild(el('p', 'tagline', 'Decipher. Transform. Transpile.'));

    app.appendChild(renderEngine());
    app.appendChild(renderDialects());

    if (state.hasResult) {
      app.appendChild(renderResult());
      const diagnostics = renderDiagnostics();
      if (diagnostics) {
        app.appendChild(diagnostics);
      }
      const transformations = renderTransformations();
      if (transformations) {
        app.appendChild(transformations);
      }
    } else {
      app.appendChild(renderEmpty());
    }

    app.appendChild(renderFooter());
  }

  post('ready');
})();
