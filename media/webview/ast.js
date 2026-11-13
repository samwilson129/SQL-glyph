(function () {
  const {
    post,
    onMessage,
    el,
    clear,
    badge,
    button,
    addButton,
    statusDot,
    empty
  } = window.SqlGlyph;

  const app = document.getElementById('app');
  let state = null;
  let term = '';
  let tree = null;

  onMessage(function (message) {
    if (message.type === 'state') {
      state = message.state;
      render();
    }
  });

  function actionButton(label, type, data, title) {
    const node = button(label, type, data, 'ghost');
    node.title = title || label;
    node.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
    });
    return node;
  }

  function matches(node) {
    if (!term) {
      return true;
    }
    const properties = (node.properties || [])
      .map(function (property) {
        return property.name + ' ' + property.value;
      })
      .join(' ');
    const haystack = [
      node.type,
      node.label,
      node.title,
      node.sql,
      node.description,
      properties
    ]
      .join(' ')
      .toLowerCase();
    return haystack.indexOf(term) >= 0;
  }

  function subtreeMatches(node) {
    if (matches(node)) {
      return true;
    }
    return (node.children || []).some(function (group) {
      return (group.nodes || []).some(subtreeMatches);
    });
  }

  function nodeElement(node) {
    const details = el('details', 'ast-node');
    details.open = term ? true : node.depth < 1;

    const summary = el('summary');
    summary.appendChild(el('span', 'ast-type', node.type));
    summary.appendChild(el('span', 'ast-label', node.label));
    if (node.title && node.title !== node.label) {
      summary.appendChild(el('span', 'ast-title', node.title));
    }
    if (node.span) {
      summary.appendChild(
        actionButton('↗', 'revealNode', { span: node.span }, 'Reveal this node in the editor')
      );
    }
    details.appendChild(summary);

    if (node.description) {
      details.appendChild(el('p', 'ast-desc', node.description));
    }

    if (node.properties && node.properties.length > 0) {
      const props = el('div', 'ast-props');
      for (const property of node.properties) {
        const row = el('div', 'ast-prop');
        row.appendChild(el('span', 'name', property.name + ':'));
        row.appendChild(el('span', 'value', property.value));
        props.appendChild(row);
      }
      details.appendChild(props);
    }

    if (node.comments && node.comments.length > 0) {
      details.appendChild(el('div', 'ast-comments', node.comments.join(' · ')));
    }

    if (node.sql) {
      const actions = el('div', 'ast-actions');
      actions.appendChild(actionButton('Copy SQL', 'copyNodeSql', { sql: node.sql }, 'Copy node SQL'));
      details.appendChild(actions);
    }

    for (const group of node.children || []) {
      const nodes = (group.nodes || []).filter(subtreeMatches);
      if (nodes.length === 0) {
        continue;
      }
      details.appendChild(el('div', 'ast-role', group.label));
      for (const child of nodes) {
        details.appendChild(nodeElement(child));
      }
    }

    return details;
  }

  function renderTree() {
    if (!tree) {
      return;
    }
    clear(tree);
    if (!state.statements || state.statements.length === 0) {
      tree.appendChild(empty('The AST has no statements.'));
      return;
    }
    let shown = 0;
    for (const statement of state.statements) {
      if (subtreeMatches(statement)) {
        tree.appendChild(nodeElement(statement));
        shown += 1;
      }
    }
    if (shown === 0) {
      tree.appendChild(empty('No nodes match “' + term + '”.'));
    }
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

  function render() {
    clear(app);
    tree = null;

    if (!state) {
      app.appendChild(empty('Loading AST explorer…'));
      return;
    }

    const header = el('div', 'header');
    header.appendChild(el('h1', '', 'AST Explorer'));
    header.appendChild(badge('SQLGlot', 'neutral'));
    app.appendChild(header);
    app.appendChild(el('p', 'tagline', 'Decipher the parse tree'));

    app.appendChild(renderEngine());

    const card = el('div', 'card');
    const actions = el('div', 'actions');
    addButton(actions, 'Inspect Selection', 'inspectSelection');
    addButton(actions, 'Inspect File', 'inspectDocument', null, 'secondary');
    addButton(actions, 'Inspect Current', 'inspectActive', null, 'secondary');
    card.appendChild(actions);
    card.appendChild(
      el(
        'p',
        'note',
        'Parsing uses the configured source dialect. Auto detection asks when the dialect is ambiguous.'
      )
    );
    app.appendChild(card);

    if (!state.hasResult) {
      const emptyCard = el('div', 'card');
      emptyCard.appendChild(el('h2', '', 'No AST yet'));
      emptyCard.appendChild(
        el(
          'p',
          'empty',
          'Select SQL in the editor and inspect it. The tree is built by SQLGlot locally and never uploaded.'
        )
      );
      app.appendChild(emptyCard);
    } else {
      const summary = el('div', 'card');
      const head = el('div', 'result-head');
      head.appendChild(
        el(
          'span',
          'result-title',
          state.fileName + ' · ' + (state.scope === 'selection' ? 'selection' : 'entire file')
        )
      );
      head.appendChild(badge(state.sourceLabel || state.sourceSettingLabel, 'neutral'));
      summary.appendChild(head);

      const chips = el('div', 'chips');
      chips.appendChild(el('span', 'chip', state.statementCount + ' statements'));
      chips.appendChild(el('span', 'chip plain', state.nodeCount + ' nodes'));
      chips.appendChild(el('span', 'chip plain', 'depth ' + state.maxDepth));
      chips.appendChild(el('span', 'chip plain', 'SQLGlot ' + state.sqlglotVersion));
      summary.appendChild(chips);

      if (state.truncated) {
        summary.appendChild(
          el(
            'p',
            'note',
            'The tree was truncated (' +
              (state.truncationReason || 'limit reached') +
              '). Only the first ' +
              state.nodeCount +
              ' nodes are shown.'
          )
        );
      }
      app.appendChild(summary);

      const searchCard = el('div', 'card');
      const searchRow = el('div', 'search-row');
      const input = el('input');
      input.type = 'search';
      input.placeholder = 'Filter nodes by type, label, or SQL…';
      input.value = term;
      input.addEventListener('input', function () {
        term = input.value.trim().toLowerCase();
        renderTree();
      });
      searchRow.appendChild(input);
      searchCard.appendChild(searchRow);

      tree = el('div', 'ast-tree');
      searchCard.appendChild(tree);
      app.appendChild(searchCard);
      renderTree();
    }

    const footer = el('div', 'footer');
    addButton(footer, 'Select Source', 'selectSource', null, 'ghost');
    addButton(footer, 'Settings', 'openSettings', null, 'ghost');
    addButton(footer, 'Engine Output', 'showOutput', null, 'ghost');
    app.appendChild(footer);
  }

  post('ready');
})();
