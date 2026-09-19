(() => {
  'use strict';

  const EXTENSION_KEY = 'stPresetWeaver';
  const STORAGE_PREFIX = 'st-preset-weaver';
  const PROMPT_ORDER_ID = '100001';
  const COMMON_TAGS = ['常用', '角色扮演', '文笔', 'NSFW', '系统', '规则', '剧情', '战斗'];

  const state = {
    open: false,
    ready: false,
    view: 'presets',
    search: '',
    presetTag: '',
    moduleTag: '',
    selectedPreset: '',
    selectedModule: '',
    selectedGroup: '',
    selectedBackup: '',
    serverState: null,
    backups: [],
    status: '',
    statusType: '',
    saveTimer: 0,
    fabDragged: false,
  };

  function context() {
    return window.SillyTavern?.getContext?.();
  }

  function chatCompletionManager() {
    const contextValue = context();
    if (!contextValue || typeof contextValue.getPresetManager !== 'function') return null;
    return contextValue.getPresetManager('openai');
  }

  function currentPresetName() {
    return chatCompletionManager()?.getSelectedPresetName() || '';
  }

  function clone(value) {
    return structuredClone(value);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function notify(message, type = 'info') {
    if (window.toastr?.[type]) window.toastr[type](message);
  }

  function setStatus(message, type = '') {
    state.status = message;
    state.statusType = type;
    const element = document.querySelector('#pwStatus');
    if (element) {
      element.textContent = message;
      element.className = `pw-status ${type}`.trim();
    }
  }

  async function localStore() {
    const store = window.SillyTavern?.libs?.localforage;
    if (!store) throw new Error('SillyTavern localforage is unavailable.');
    return store;
  }

  async function storageKey() {
    const contextValue = context();
    if (!contextValue?.extensionSettings) throw new Error('SillyTavern extension settings are unavailable.');

    const settings = contextValue.extensionSettings;
    settings[EXTENSION_KEY] = settings[EXTENSION_KEY] || {};
    if (!settings[EXTENSION_KEY].storageKey) {
      settings[EXTENSION_KEY].storageKey = contextValue.uuidv4();
      contextValue.saveSettingsDebounced();
    }
    return `${STORAGE_PREFIX}:${settings[EXTENSION_KEY].storageKey}`;
  }

  function normalizeState(input) {
    const result = defaultServerState();
    if (!input || typeof input !== 'object') return result;
    const tags = value => Array.isArray(value)
      ? [...new Set(value.map(item => String(item).trim()).filter(Boolean))]
      : [];
    const isRecord = value => value && typeof value === 'object' && !Array.isArray(value);

    for (const key of ['modules', 'groups', 'presets']) {
      if (isRecord(input[key])) {
        result[key] = input[key];
      }
    }

    result.modules = Object.fromEntries(Object.entries(result.modules)
      .filter(([id, module]) => typeof id === 'string' && isRecord(module))
      .map(([id, module]) => [id, {
        ...module,
        id,
        name: String(module.name || '未命名模块'),
        tags: tags(module.tags),
        role: ['system', 'user', 'assistant'].includes(module.role) ? module.role : 'system',
        content: String(module.content || ''),
        presetName: typeof module.presetName === 'string' ? module.presetName : '',
        prompts: Array.isArray(module.prompts) ? clone(module.prompts) : undefined,
        injection_trigger: Array.isArray(module.injection_trigger) ? clone(module.injection_trigger) : [],
      }]));

    result.groups = Object.fromEntries(Object.entries(result.groups)
      .filter(([id, group]) => typeof id === 'string' && isRecord(group))
      .map(([id, group]) => [id, {
        ...group,
        id,
        name: String(group.name || '未命名分组'),
        moduleIds: [...new Set((Array.isArray(group.moduleIds) ? group.moduleIds : [])
          .filter(moduleId => result.modules[moduleId]))],
      }]));

    result.presets = Object.fromEntries(Object.entries(result.presets)
      .filter(([name, meta]) => typeof name === 'string' && isRecord(meta))
      .map(([name, meta]) => [name, {
        ...meta,
        tags: tags(meta.tags),
        lastUsed: Number(meta.lastUsed) || 0,
      }]));

    if (Array.isArray(input.backups)) {
      result.backups = input.backups.filter(record => isRecord(record)
        && typeof record.id === 'string'
        && typeof record.createdAt === 'string'
        && isRecord(record.preset));
    }

    if (input.settings && typeof input.settings === 'object') {
      result.settings = {
        ...result.settings,
        ...input.settings,
        autoBackup: input.settings.autoBackup === true,
        backupRetention: Math.max(1, Math.min(500, Number(input.settings.backupRetention) || 50)),
        theme: input.settings.theme === 'light' ? 'light' : 'dark',
        positions: isRecord(input.settings.positions) ? input.settings.positions : {},
      };
    }
    return result;
  }

  async function loadState() {
    const store = await localStore();
    return normalizeState(await store.getItem(await storageKey()));
  }

  async function persistState() {
    const store = await localStore();
    await store.setItem(await storageKey(), clone(state.serverState));
  }

  function queueServerStateSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(async () => {
      try {
        await persistState();
      } catch (error) {
        setStatus(error.message, 'error');
        notify(error.message, 'error');
      }
    }, 220);
  }

  function defaultServerState() {
    return {
      schemaVersion: 1,
      modules: {},
      groups: {},
      presets: {},
      backups: [],
      settings: {
        autoBackup: true,
        backupRetention: 50,
        theme: 'dark',
        positions: {},
      },
    };
  }

  function presetMeta(name) {
    if (!state.serverState.presets[name]) {
      state.serverState.presets[name] = { tags: [], lastUsed: 0 };
    }
    return state.serverState.presets[name];
  }

  function presetTags(name) {
    const extensionTags = extensionData(getPreset(name)).tags;
    return Array.isArray(extensionTags) ? extensionTags : presetMeta(name).tags || [];
  }

  function allPresetNames() {
    return chatCompletionManager()?.getAllPresets() || [];
  }

  function getPreset(name) {
    return chatCompletionManager()?.getCompletionPresetByName(name) || null;
  }

  function promptOrder(preset) {
    const lists = Array.isArray(preset?.prompt_order) ? preset.prompt_order : [];
    return lists.find(list => String(list.character_id) === PROMPT_ORDER_ID)?.order
      || lists[0]?.order
      || [];
  }

  function promptByIdentifier(preset, identifier) {
    return preset?.prompts?.find(prompt => prompt?.identifier === identifier) || null;
  }

  function promptEnabled(preset, identifier) {
    const entry = promptOrder(preset).find(item => item?.identifier === identifier);
    return entry ? entry.enabled !== false : true;
  }

  function setPromptEnabled(preset, identifier, enabled) {
    const order = promptOrder(preset);
    let entry = order.find(item => item?.identifier === identifier);
    if (!entry) {
      entry = { identifier, enabled };
      order.push(entry);
    }
    entry.enabled = enabled;
  }

  function extensionData(preset) {
    const value = preset?.extensions?.[EXTENSION_KEY];
    return value && typeof value === 'object' ? value : { schemaVersion: 1, modules: {} };
  }

  function boundIdentifier(preset, moduleId) {
    const modules = extensionData(preset).modules || {};
    return Object.entries(modules).find(([, value]) => value?.moduleId === moduleId)?.[0] || null;
  }

  function boundIdentifiers(preset, moduleId) {
    const modules = extensionData(preset).modules || {};
    return Object.entries(modules)
      .filter(([, value]) => value?.moduleId === moduleId)
      .map(([identifier]) => identifier);
  }

  function moduleEnabledState(preset, moduleId) {
    const identifiers = boundIdentifiers(preset, moduleId);
    if (!identifiers.length) return null;
    return identifiers.every(identifier => promptEnabled(preset, identifier));
  }

  function commonTagChips(kind) {
    return `<div class="pw-chip-row">${COMMON_TAGS.map(tag => `
      <button class="pw-chip" data-tag-add="${kind}" data-tag="${escapeHtml(tag)}" type="button">${escapeHtml(tag)}</button>
    `).join('')}</div>`;
  }

  function moduleReferences(moduleId) {
    return allPresetNames().filter(name => Boolean(boundIdentifier(getPreset(name), moduleId)));
  }

  function allTags(kind) {
    if (kind === 'presets') {
      return [...new Set(allPresetNames().flatMap(name => presetTags(name)))].sort();
    }
    return [...new Set(Object.values(state.serverState.modules).flatMap(item => item.tags || []))].sort();
  }

  function relativeTime(timestamp) {
    if (!timestamp) return '未使用';
    const diff = Date.now() - timestamp;
    const minute = 60 * 1000;
    if (diff < minute) return '刚刚';
    if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
    if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`;
    return new Date(timestamp).toLocaleDateString();
  }

  function injectShell() {
    document.body.insertAdjacentHTML('beforeend', `
      <button id="pwFab" class="pw-fab" type="button" title="Preset Weaver"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg></button>
      <div id="pwOverlay" class="pw-overlay">
        <div id="pwWindow" class="pw-window">
          <div class="pw-header">
            <div class="pw-title">Preset Weaver</div>
            <div id="pwCurrent" class="pw-current"></div>
            <button id="pwThemeButton" class="pw-icon-btn" type="button" title="切换主题">☀️</button>
            <button id="pwCloseButton" class="pw-icon-btn" type="button" title="关闭">✕</button>
          </div>
          <div class="pw-body">
            <section class="pw-pane">
              <div id="pwViewTabs" class="pw-toolbar"></div>
              <div class="pw-toolbar">
                <input id="pwSearch" class="pw-search" type="search" placeholder="搜索名称或内容...">
                <button id="pwCreateButton" class="pw-button primary small" type="button">新增</button>
              </div>
              <div id="pwTagRow" class="pw-chip-row"></div>
              <div id="pwList" class="pw-list"></div>
            </section>
            <section class="pw-pane">
              <div id="pwRight"></div>
            </section>
          </div>
          <div class="pw-footer">
            <div id="pwStatus" class="pw-status"></div>
            <button id="pwRefreshButton" class="pw-button small" type="button">刷新</button>
          </div>
        </div>
      </div>
      <div id="pwDialogOverlay" class="pw-overlay">
        <div class="pw-dialog">
          <h3 id="pwDialogTitle">确认</h3>
          <div id="pwDialogBody"></div>
          <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:18px;">
            <button id="pwDialogCancel" class="pw-button" type="button">取消</button>
            <button id="pwDialogAccept" class="pw-button primary" type="button">确认</button>
          </div>
        </div>
      </div>
    `);
  }

  function viewTabs() {
    return [
      ['presets', '预设'],
      ['modules', '模块'],
      ['groups', '分组'],
      ['backups', '备份'],
      ['settings', '设置'],
    ];
  }

  function filteredPresets() {
    const query = state.search.trim().toLowerCase();
    return allPresetNames().filter(name => {
      const meta = presetMeta(name);
      const tags = presetTags(name);
      const matchesTag = !state.presetTag || tags.includes(state.presetTag);
      const matchesQuery = !query || name.toLowerCase().includes(query);
      return matchesTag && matchesQuery;
    }).sort((leftName, rightName) => {
      const left = presetMeta(leftName).lastUsed || 0;
      const right = presetMeta(rightName).lastUsed || 0;
      return right - left || leftName.localeCompare(rightName);
    });
  }

  function filteredModules() {
    const query = state.search.trim().toLowerCase();
    return Object.values(state.serverState.modules).filter(module => {
      const matchesTag = !state.moduleTag || module.tags?.includes(state.moduleTag);
      const matchesQuery = !query
        || module.name?.toLowerCase().includes(query)
        || module.content?.toLowerCase().includes(query)
        || module.presetName?.toLowerCase().includes(query);
      return matchesTag && matchesQuery;
    }).sort((left, right) => (left.name || '').localeCompare(right.name || ''));
  }

  function renderTabs() {
    document.querySelector('#pwViewTabs').innerHTML = viewTabs().map(([id, label]) => `
      <button class="pw-button small ${state.view === id ? 'primary' : ''}" data-view="${id}" type="button">${label}</button>
    `).join('');
  }

  function renderTags() {
    const row = document.querySelector('#pwTagRow');
    if (!['presets', 'modules'].includes(state.view)) {
      row.innerHTML = '';
      return;
    }

    const activeTag = state.view === 'presets' ? state.presetTag : state.moduleTag;
    const tags = allTags(state.view);
    row.innerHTML = tags.map(tag => `
      <button class="pw-chip ${activeTag === tag ? 'active' : ''}" data-tag="${escapeHtml(tag)}" type="button">${escapeHtml(tag)}</button>
    `).join('');
  }

  function renderList() {
    const list = document.querySelector('#pwList');
    const createButton = document.querySelector('#pwCreateButton');
    createButton.classList.toggle('pw-hidden', !['groups', 'modules'].includes(state.view));

    if (state.view === 'presets') {
      const current = currentPresetName();
      const names = filteredPresets();
      list.innerHTML = names.length ? names.map(name => {
        const meta = presetMeta(name);
        const tags = presetTags(name);
        return `
          <div class="pw-card ${name === current ? 'active' : ''}" data-preset="${escapeHtml(name)}">
            <div class="pw-card-top">
              <div class="pw-name">${escapeHtml(name)}</div>
              <div class="pw-meta">${relativeTime(meta.lastUsed)}</div>
            </div>
            <div class="pw-tags">${tags.map(tag => `<span class="pw-tag">${escapeHtml(tag)}</span>`).join('')}</div>
          </div>
        `;
      }).join('') : '<div class="pw-empty">没有匹配的预设</div>';
      return;
    }

    if (state.view === 'modules') {
      const modules = filteredModules();
      const currentPreset = getPreset(currentPresetName());
     list.innerHTML = modules.length ? modules.map(module => {
        const enabled = moduleEnabledState(currentPreset, module.id);
        return `
          <div class="pw-card ${module.id === state.selectedModule ? 'active' : ''}" data-module="${module.id}">
            <div class="pw-card-top">
              <div class="pw-name">${escapeHtml(module.name || '未命名模块')}</div>
              <label class="pw-meta" onclick="event.stopPropagation()">
                ${enabled === null ? '未绑定' : `<input type="checkbox" data-module-toggle="${module.id}" ${enabled ? 'checked' : ''}>`}
              </label>
            </div>
            <div class="pw-tags">${
              [
                ...(module.presetName ? [`私有：${escapeHtml(module.presetName)}`] : []),
                ...(module.tags || []),
              ].map(tag => `<span class="pw-tag">${escapeHtml(tag)}</span>`).join('')
            }</div>
          </div>
        `;
      }).join('') : '<div class="pw-empty">还没有模块</div>';
      return;
    }

    if (state.view === 'groups') {
      const groups = Object.values(state.serverState.groups);
      list.innerHTML = groups.length ? groups.map(group => `
        <div class="pw-card ${group.id === state.selectedGroup ? 'active' : ''}" data-group="${group.id}">
          <div class="pw-card-top">
            <div class="pw-name">${escapeHtml(group.name)}</div>
            <label class="pw-meta" onclick="event.stopPropagation()">
              <input type="checkbox" data-group-toggle="${group.id}" ${group.enabled === true ? 'checked' : ''}>
            </label>
          </div>
          <div class="pw-tags"><span class="pw-tag">${group.moduleIds.length} 个模块</span></div>
        </div>
      `).join('') : '<div class="pw-empty">还没有分组</div>';
      return;
    }

    if (state.view === 'backups') {
      list.innerHTML = state.backups.length ? state.backups.map(backup => `
        <div class="pw-card ${backup.id === state.selectedBackup ? 'active' : ''}" data-backup="${backup.id}">
          <div class="pw-card-top">
            <div class="pw-name">${escapeHtml(backup.presetName || '未命名预设')}</div>
            <div class="pw-meta">${new Date(backup.createdAt).toLocaleString()}</div>
          </div>
          <div class="pw-tags"><span class="pw-tag">${escapeHtml(backup.kind)}</span></div>
        </div>
      `).join('') : '<div class="pw-empty">暂无备份</div>';
      return;
    }

    list.innerHTML = '<div class="pw-empty">插件设置在右侧</div>';
  }

  function renderPresetRight() {
    const name = state.selectedPreset || currentPresetName();
    const preset = getPreset(name);
    if (!preset) return '<div class="pw-empty">无法读取当前聊天补全预设。</div>';

    const prompts = preset.prompts || [];
    const nonMarkers = prompts.filter(prompt => !prompt.marker);
    const changed = changedIdentifiers(name);
    const metadata = presetMeta(name);
    return `
      <div class="pw-editor">
        <div class="pw-section-title">${escapeHtml(name)}</div>
        <div class="pw-field">
          <label>标签（逗号分隔）</label>
          <input class="pw-input" id="pwPresetTags" value="${escapeHtml(presetTags(name).join(', '))}">
          ${commonTagChips('preset')}
        </div>
        <div class="pw-field"><label>上次使用</label><div>${relativeTime(metadata.lastUsed)}</div></div>
        <div class="pw-field"><label>非 marker 提示词条目（${nonMarkers.length}）</label></div>
        <div class="pw-list">
          ${nonMarkers.map(prompt => {
            const enabled = promptEnabled(preset, prompt.identifier);
            const isChanged = changed.has(prompt.identifier);
            return `
              <div class="pw-switch-row ${isChanged ? 'pw-changed' : ''}">
                <input type="checkbox" data-prompt-toggle="${escapeHtml(prompt.identifier)}" ${enabled ? 'checked' : ''}>
                ${isChanged ? '<span class="pw-changed-mark" title="相比最近备份已修改">●</span>' : ''}
                <span>${escapeHtml(prompt.name || prompt.identifier)}</span>
              </div>
            `;
          }).join('')}
        </div>
        <div style="margin-top:12px;">
          <button class="pw-button primary" id="pwExtractAll" type="button">提取全部提示词为模块</button>
        </div>
      </div>
    `;
  }

  function renderModuleRight() {
    const module = state.serverState.modules[state.selectedModule];
    if (!module) return '<div class="pw-empty">选择或创建一个模块。</div>';
    const isPresetBundle = Array.isArray(module.prompts);
    return `
      <div class="pw-editor">
        <div class="pw-field"><label>模块名称</label><input class="pw-input" id="pwModuleName" value="${escapeHtml(module.name || '')}"></div>
        ${module.presetName ? `<div class="pw-field"><label>归属预设</label><div>${escapeHtml(module.presetName)}（私有，不可共享）</div></div>` : ''}
        <div class="pw-field"><label>模块标签（逗号分隔）</label><input class="pw-input" id="pwModuleTags" value="${escapeHtml((module.tags || []).join(', '))}">${commonTagChips('module')}</div>
        ${isPresetBundle ? '' : `<div class="pw-field"><label>角色</label>
          <select class="pw-input" id="pwModuleRole">
            ${['system', 'user', 'assistant'].map(role => `<option value="${role}" ${module.role === role ? 'selected' : ''}>${role}</option>`).join('')}
          </select>
        </div>`}
        ${isPresetBundle
          ? `<div class="pw-field"><label>提示词条目（${module.prompts.length}）</label></div>
            <div class="pw-list">
              ${module.prompts.map((prompt, index) => `
                <div class="pw-field">
                  <label>${escapeHtml(prompt.name || prompt.identifier)} · ${escapeHtml(prompt.identifier || '')}</label>
                  <select class="pw-input" data-module-prompt-role="${index}">
                    ${['system', 'user', 'assistant'].map(role => `<option value="${role}" ${prompt.role === role ? 'selected' : ''}>${role}</option>`).join('')}
                  </select>
                  <textarea class="pw-textarea" data-module-prompt-content="${index}">${escapeHtml(prompt.content || '')}</textarea>
                </div>
              `).join('')}
            </div>`
          : `<div class="pw-field"><label>内容</label><textarea class="pw-textarea" id="pwModuleContent">${escapeHtml(module.content || '')}</textarea></div>`}
        <div style="display:flex; gap:8px;">
          <button class="pw-button primary" id="pwSaveModule" type="button">保存模块</button>
          <button class="pw-button" id="pwCopyModule" type="button">复制副本到预设</button>
          <button class="pw-button" id="pwApplyModule" type="button">应用到当前预设</button>
          <button class="pw-button" id="pwDeleteModule" type="button">删除</button>
        </div>
      </div>
    `;
  }

  function renderGroupRight() {
    const group = state.serverState.groups[state.selectedGroup];
    if (!group) return '<div class="pw-empty">选择或创建一个分组。</div>';
    const modules = Object.values(state.serverState.modules);
    return `
      <div class="pw-editor">
        <div class="pw-field"><label>分组名称</label><input class="pw-input" id="pwGroupName" value="${escapeHtml(group.name || '')}"></div>
        <div class="pw-field"><label>组内模块（${group.moduleIds.length}）</label></div>
        <div class="pw-list">
          ${modules.map(module => `
            <label class="pw-checkbox"><input type="checkbox" data-group-module="${module.id}" ${group.moduleIds.includes(module.id) ? 'checked' : ''}><span>${escapeHtml(module.name || module.id)}</span></label>
          `).join('')}
        </div>
        <div style="display:flex; gap:8px; margin-top:12px;">
          <button class="pw-button primary" id="pwGroupOn" type="button">开启分组</button>
          <button class="pw-button" id="pwGroupOff" type="button">关闭分组</button>
          <button class="pw-button" id="pwDeleteGroup" type="button">删除</button>
        </div>
      </div>
    `;
  }

  function renderBackupRight() {
    const record = state.backups.find(item => item.id === state.selectedBackup);
    if (!record) {
      return `
        <div class="pw-editor">
          <div class="pw-section-title">备份</div>
          <button class="pw-button primary" id="pwManualBackup" type="button">手动备份当前预设</button>
        </div>
      `;
    }
    return `
      <div class="pw-editor">
        <div class="pw-section-title">${escapeHtml(record.presetName || '未命名预设')}</div>
        <div class="pw-field"><label>创建时间</label><div>${new Date(record.createdAt).toLocaleString()}</div></div>
        <div class="pw-field"><label>类型</label><div>${escapeHtml(record.kind)} / ${escapeHtml(record.source)}</div></div>
        <div style="display:flex; gap:8px;">
          <button class="pw-button primary" id="pwRestoreBackup" type="button">恢复备份</button>
          <button class="pw-button" id="pwDeleteBackup" type="button">删除备份</button>
        </div>
      </div>
    `;
  }

  function confirmAction(title, message, action, acceptLabel = '删除') {
    openDialog(title, `<p>${escapeHtml(message)}</p>`, acceptLabel);
    document.querySelector('#pwDialogAccept').onclick = async () => {
      closeDialog();
      try {
        await action();
      } catch (error) {
        setStatus(error.message, 'error');
        notify(error.message, 'error');
      }
    };
  }

  function renderSettingsRight() {
    const settings = state.serverState.settings;
    return `
      <div class="pw-editor">
        <div class="pw-section-title">插件设置</div>
        <label class="pw-switch-row"><input id="pwAutoBackup" type="checkbox" ${settings.autoBackup ? 'checked' : ''}><span>修改前自动备份并对比变化</span></label>
        <div class="pw-field" style="margin-top:12px;"><label>备份保留数量（1–500）</label><input class="pw-input" id="pwRetention" type="number" min="1" max="500" value="${settings.backupRetention}"></div>
        <div class="pw-field"><label>主题</label><div style="display:flex; gap:8px;">
          <button class="pw-button ${settings.theme === 'dark' ? 'primary' : ''}" data-theme="dark" type="button">夜间</button>
          <button class="pw-button ${settings.theme === 'light' ? 'primary' : ''}" data-theme="light" type="button">白天</button>
        </div></div>
        <div class="pw-field"><label>数据迁移</label><div style="display:flex; gap:8px;">
          <button class="pw-button" id="pwExportButton" type="button">导出全部数据</button>
          <label class="pw-button" style="display:flex; align-items:center;">导入<input id="pwImportInput" class="pw-hidden" type="file" accept="application/json"></label>
        </div></div>
       <div class="pw-field"><label>存储说明</label><div>数据保存在当前浏览器的 SillyTavern 本地存储中；跨设备迁移请使用导出/导入。</div></div>
        <div class="pw-field"><label>窗口位置</label><div style="display:flex; gap:8px;"><button class="pw-button" id="pwResetPositions" type="button">重置悬浮窗与按钮位置</button></div></div>
      </div>
    `;
  }

  function renderRight() {
    const right = document.querySelector('#pwRight');
    if (state.view === 'presets') right.innerHTML = renderPresetRight();
    else if (state.view === 'modules') right.innerHTML = renderModuleRight();
    else if (state.view === 'groups') right.innerHTML = renderGroupRight();
    else if (state.view === 'backups') right.innerHTML = renderBackupRight();
    else right.innerHTML = renderSettingsRight();
  }

  function applyPositions() {
    const positions = state.serverState?.settings?.positions || {};
    const windowEl = document.querySelector('#pwWindow');
    if (windowEl && positions.window) {
      windowEl.style.position = 'absolute';
      windowEl.style.left = `${positions.window.left}px`;
      windowEl.style.top = `${positions.window.top}px`;
      windowEl.style.margin = '0';
    }
    const fab = document.querySelector('#pwFab');
    if (fab && positions.fab) {
      fab.style.right = 'auto';
      fab.style.bottom = 'auto';
      fab.style.left = `${positions.fab.left}px`;
      fab.style.top = `${positions.fab.top}px`;
    }
  }

  function render() {
    if (!state.serverState) return;
    const windowElement = document.querySelector('#pwWindow');
    windowElement.classList.toggle('pw-light', state.serverState.settings.theme === 'light');
    applyPositions();
    document.querySelector('#pwThemeButton').textContent = state.serverState.settings.theme === 'light' ? '🌙' : '☀️';
    document.querySelector('#pwCurrent').textContent = `当前：${currentPresetName()}`;
    document.querySelector('#pwSearch').value = state.search;
    document.querySelector('#pwSearch').placeholder = state.view === 'modules' ? '搜索模块...' : '搜索...';
    if (!state.ready) {
      document.querySelector('#pwList').innerHTML = '<div class="pw-empty">正在加载本地数据...</div>';
      document.querySelector('#pwRight').innerHTML = `
        <div class="pw-empty">
          <strong>正在加载本地数据。</strong><br>
          如果长时间停留在这里，请检查浏览器是否允许 SillyTavern 使用 IndexedDB/localStorage。
        </div>
      `;
      setStatus(state.status, state.statusType);
      return;
    }
    renderTabs();
    renderTags();
    renderList();
    renderRight();
    setStatus(state.status, state.statusType);
  }

  function openDialog(title, bodyHtml, acceptLabel = '确认') {
    document.querySelector('#pwDialogTitle').textContent = title;
    document.querySelector('#pwDialogBody').innerHTML = bodyHtml;
    document.querySelector('#pwDialogAccept').textContent = acceptLabel;
    document.querySelector('#pwDialogOverlay').classList.add('is-open');
  }

  function closeDialog() {
    document.querySelector('#pwDialogOverlay').classList.remove('is-open');
    document.querySelector('#pwDialogAccept').onclick = null;
  }

  function openSyncDialog(moduleId) {
    const references = moduleReferences(moduleId);
    if (!references.length) {
      notify('该模块还没有被任何预设引用。');
      return;
    }

    const current = currentPresetName();
    openDialog('选择同步范围', `
      <p>模块已保存。请选择要同步内容修改的预设：</p>
      <div class="pw-sync-list">
        ${references.map(name => `
          <label class="pw-checkbox"><input type="checkbox" value="${escapeHtml(name)}" ${name === current ? 'checked' : ''}><span>${escapeHtml(name)}</span></label>
        `).join('')}
      </div>
    `, '同步');

    document.querySelector('#pwDialogAccept').onclick = async () => {
      const selected = [...document.querySelectorAll('#pwDialogBody input:checked')].map(item => item.value);
      closeDialog();
      await syncModule(moduleId, selected);
    };
  }

  async function backupPreset(name, kind = 'auto') {
    const preset = getPreset(name);
    if (!preset) throw new Error(`无法读取预设 ${name}`);
    const record = {
      kind,
      source: kind,
      presetName: name,
      preset: clone(preset),
      id: context().uuidv4(),
      createdAt: new Date().toISOString(),
    };
    state.serverState.backups.unshift(record);
    while (state.serverState.backups.length > state.serverState.settings.backupRetention) {
      state.serverState.backups.pop();
    }
    await persistState();
    state.backups = clone(state.serverState.backups);
    return clone(record);
  }

  async function savePresetObject(name, preset) {
    const manager = chatCompletionManager();
    if (!manager) throw new Error('聊天补全预设管理器不可用。');
    await manager.savePreset(name, preset, { skipUpdate: true });
    if (name === currentPresetName()) manager.updateList(name, preset);
  }

  async function syncModule(moduleId, presetNames) {
    const module = state.serverState.modules[moduleId];
    if (!module || !Array.isArray(presetNames)) return;
    let synced = 0;
    const errors = [];

    for (const name of presetNames) {
      try {
        const preset = getPreset(name);
        const identifiers = boundIdentifiers(preset, moduleId);
        if (!identifiers.length) {
          errors.push(`${name}: 找不到绑定条目`);
          continue;
        }

        if (state.serverState.settings.autoBackup) await backupPreset(name, 'auto');
        for (const identifier of identifiers) {
          const prompt = promptByIdentifier(preset, identifier);
          if (!prompt) {
            errors.push(`${name}: ${identifier} 不存在`);
            continue;
          }
          const source = Array.isArray(module.prompts)
            ? module.prompts.find(item => item?.identifier === identifier)
            : null;
          Object.assign(prompt, {
            name: source?.name ?? module.name ?? prompt.name,
            role: source?.role ?? module.role,
            content: source?.content ?? module.content,
            system_prompt: Boolean(source?.system_prompt ?? module.system_prompt),
            position: source?.position ?? module.position ?? prompt.position,
            injection_position: source?.injection_position ?? module.injection_position ?? prompt.injection_position,
            injection_depth: source?.injection_depth ?? module.injection_depth ?? prompt.injection_depth,
            injection_order: source?.injection_order ?? module.injection_order ?? prompt.injection_order,
            forbid_overrides: Boolean(source?.forbid_overrides ?? module.forbid_overrides),
            injection_trigger: clone(source?.injection_trigger ?? module.injection_trigger ?? []),
          });
        }
        await savePresetObject(name, preset);
        synced += 1;
      } catch (error) {
        errors.push(`${name}: ${error.message}`);
      }
    }

    await refreshBackups();
    render();
    setStatus(`已同步 ${synced} 个预设`, 'ok');
    if (errors.length) notify(errors.join('\n'), 'error');
    if (presetNames.includes(currentPresetName())) await showDiffDialog(currentPresetName());
  }

  async function createModuleFromPrompt(identifier) {
    const contextValue = context();
    const name = currentPresetName();
    const preset = getPreset(name);
    const prompt = promptByIdentifier(preset, identifier);
    if (!prompt) return;
    if (extensionData(preset).modules?.[identifier]) {
      notify('该条目已经绑定模块。');
      return;
    }

    const moduleId = contextValue.uuidv4();
    const now = Date.now();
    const module = {
      id: moduleId,
      name: prompt.name || identifier,
      tags: [],
      role: prompt.role || 'system',
      content: prompt.content || '',
      system_prompt: Boolean(prompt.system_prompt),
      sourceIdentifier: prompt.identifier,
      presetName: name,
      position: prompt.position,
      injection_position: prompt.injection_position,
      injection_depth: prompt.injection_depth,
      injection_order: prompt.injection_order,
      forbid_overrides: Boolean(prompt.forbid_overrides),
      injection_trigger: clone(prompt.injection_trigger || []),
      createdAt: now,
      updatedAt: now,
    };

    if (state.serverState.settings.autoBackup) await backupPreset(name, 'auto');
    state.serverState.modules[moduleId] = module;
    const extension = clone(extensionData(preset));
    extension.schemaVersion = 1;
    extension.modules = extension.modules || {};
    extension.modules[identifier] = { moduleId, boundAt: now };
    await contextValue.getPresetManager('openai').writePresetExtensionField({
      name,
      path: EXTENSION_KEY,
      value: extension,
    });
    await persistState();
    state.view = 'modules';
    state.selectedModule = moduleId;
    render();
    setStatus('模块已提取并绑定', 'ok');
  }

 async function extractAllPrompts(name) {
   const contextValue = context();
   const preset = getPreset(name);
   if (!preset) return;
   const nonMarkers = (preset.prompts || []).filter(prompt => !prompt?.marker);
   if (!nonMarkers.length) {
     notify('没有可提取的非 marker 提示词。');
     return;
   }

    if (state.serverState.settings.autoBackup) await backupPreset(name, 'auto');
    const extension = clone(extensionData(preset));
    extension.schemaVersion = 1;
    extension.modules = extension.modules || {};
    const now = Date.now();
    const createdIds = [];

    for (const prompt of nonMarkers) {
      if (extension.modules[prompt.identifier]) continue;
      const moduleId = contextValue.uuidv4();
      const module = {
        id: moduleId,
        name: prompt.name || prompt.identifier,
        tags: [],
        role: prompt.role || 'system',
        content: prompt.content || '',
        system_prompt: Boolean(prompt.system_prompt),
        position: prompt.position,
        sourceIdentifier: prompt.identifier,
        presetName: name,
        injection_position: prompt.injection_position,
        injection_depth: prompt.injection_depth,
        injection_order: prompt.injection_order,
        forbid_overrides: Boolean(prompt.forbid_overrides),
        injection_trigger: clone(prompt.injection_trigger || []),
        createdAt: now,
        updatedAt: now,
      };
      state.serverState.modules[moduleId] = module;
      extension.modules[prompt.identifier] = { moduleId, boundAt: now };
      createdIds.push(moduleId);
    }

    await contextValue.getPresetManager('openai').writePresetExtensionField({
      name,
      path: EXTENSION_KEY,
      value: extension,
    });
    await persistState();
    state.view = 'modules';
    state.selectedModule = createdIds[0] || '';
    render();
    setStatus(`已提取 ${createdIds.length} 个提示词模块`, 'ok');
    if (!createdIds.length) notify('该预设的提示词已全部提取。');
  }

  async function showDiffDialog(name) {
    const backup = latestBackupFor(name);
    const current = getPreset(name);
    if (!backup || !current) return;
    const changes = diffPreset(backup.preset, current);
    if (!changes.length) {
      setStatus('未检测到提示词内容变化', 'ok');
      return;
    }
    const fieldLabels = {
      name: '名称',
      role: '角色',
      content: '内容',
      enabled: '开关',
      system_prompt: '系统提示',
      injection_position: '注入位置',
      injection_depth: '注入深度',
      injection_order: '注入顺序',
      forbid_overrides: '禁止覆盖',
    };
    openDialog(`修改对比：${name}`, `
      <div class="pw-diff-list">
        ${changes.map(change => {
          const label = change.type === 'added' ? '新增' : change.type === 'removed' ? '删除' : '修改';
          const fields = (change.fields || []).map(field => fieldLabels[field] || field).join('、');
          return `
            <div class="pw-diff-item">
              <span class="pw-diff-badge pw-diff-${change.type}">${label}</span>
              <span class="pw-diff-name">${escapeHtml(change.name || change.identifier)}</span>
              ${fields ? `<span class="pw-diff-fields">${escapeHtml(fields)}</span>` : ''}
            </div>
          `;
        }).join('')}
      </div>
    `, '知道了');
    document.querySelector('#pwDialogAccept').onclick = closeDialog;
  }

  function latestBackupFor(name) {
    return (state.serverState.backups || []).find(record => record.presetName === name) || null;
  }

  function diffPreset(before, after) {
    const beforePrompts = before?.prompts || [];
    const afterPrompts = after?.prompts || [];
    const identifiers = [...new Set([
      ...beforePrompts.map(prompt => prompt?.identifier),
      ...afterPrompts.map(prompt => prompt?.identifier),
    ])].filter(Boolean);
    const changes = [];

    for (const identifier of identifiers) {
      const beforePrompt = beforePrompts.find(prompt => prompt?.identifier === identifier);
      const afterPrompt = afterPrompts.find(prompt => prompt?.identifier === identifier);
      if (!beforePrompt && afterPrompt) {
        changes.push({ identifier, type: 'added', name: afterPrompt.name });
      } else if (beforePrompt && !afterPrompt) {
        changes.push({ identifier, type: 'removed', name: beforePrompt.name });
      } else if (beforePrompt && afterPrompt) {
        const fields = [];
        for (const [field, isBoolean] of [['name', false], ['role', false], ['content', false], ['system_prompt', true], ['injection_position', false], ['injection_depth', false], ['injection_order', false], ['forbid_overrides', true]]) {
          const beforeValue = isBoolean ? Boolean(beforePrompt[field]) : String(beforePrompt[field] ?? '');
          const afterValue = isBoolean ? Boolean(afterPrompt[field]) : String(afterPrompt[field] ?? '');
          if (beforeValue !== afterValue) fields.push(field);
        }
        if (promptEnabled(before, identifier) !== promptEnabled(after, identifier)) fields.push('enabled');
        if (fields.length) changes.push({ identifier, type: 'changed', name: afterPrompt.name, fields });
      }
    }

    return changes;
  }

  function changedIdentifiers(name) {
    const backup = latestBackupFor(name);
    const current = getPreset(name);
    if (!backup || !current) return new Set();
    return new Set(diffPreset(backup.preset, current).map(change => change.identifier));
  }

  async function togglePrompt(identifier, enabled) {
    const name = currentPresetName();
    const preset = getPreset(name);
    if (!preset || !promptByIdentifier(preset, identifier)) return;
    if (state.serverState.settings.autoBackup) await backupPreset(name, 'auto');
    setPromptEnabled(preset, identifier, enabled);
    await savePresetObject(name, preset);
    render();
    setStatus(enabled ? '条目已开启' : '条目已关闭', 'ok');
    await showDiffDialog(name);
  }

  async function toggleModule(moduleId, enabled) {
    const name = currentPresetName();
    const preset = getPreset(name);
    const identifiers = boundIdentifiers(preset, moduleId);
    if (!preset || !identifiers.length) return;
    if (state.serverState.settings.autoBackup) await backupPreset(name, 'auto');
    let affected = 0;
    for (const identifier of identifiers) {
      if (promptByIdentifier(preset, identifier)) {
        setPromptEnabled(preset, identifier, enabled);
        affected += 1;
      }
    }
    await savePresetObject(name, preset);
    render();
    setStatus(`${enabled ? '开启' : '关闭'}了 ${affected} 个条目`, 'ok');
    await showDiffDialog(name);
  }

  async function createModuleBinding(name, moduleId) {
    const module = state.serverState.modules[moduleId];
    const preset = getPreset(name);
    if (!module || !preset) throw new Error('无法应用模块：预设或模块不存在。');

    const existing = boundIdentifiers(preset, moduleId);
    if (existing.length) return existing;

    const now = Date.now();
    const sources = Array.isArray(module.prompts) && module.prompts.length
      ? module.prompts
      : [module];
    preset.prompts = preset.prompts || [];
    const identifiers = [];
    const extension = clone(extensionData(preset));
    extension.schemaVersion = 1;
    extension.modules = extension.modules || {};

    for (const [index, source] of sources.entries()) {
      let identifier = source?.identifier || `pw_${moduleId}_${index}`;
      if (preset.prompts.some(prompt => prompt?.identifier === identifier)) {
        identifier = `${identifier}_${Date.now()}`;
      }
      const prompt = promptByIdentifier(preset, source?.identifier);
      if (prompt) {
        Object.assign(prompt, {
          name: source?.name ?? module.name ?? prompt.name,
          role: source?.role ?? module.role,
          content: source?.content ?? module.content,
          system_prompt: Boolean(source?.system_prompt ?? module.system_prompt),
          position: source?.position ?? module.position ?? prompt.position,
          injection_position: source?.injection_position ?? module.injection_position ?? prompt.injection_position,
          injection_depth: source?.injection_depth ?? module.injection_depth ?? prompt.injection_depth,
          injection_order: source?.injection_order ?? module.injection_order ?? prompt.injection_order,
          forbid_overrides: Boolean(source?.forbid_overrides ?? module.forbid_overrides),
          injection_trigger: clone(source?.injection_trigger ?? module.injection_trigger ?? []),
        });
      } else {
        preset.prompts.push({
          identifier,
          name: source?.name ?? module.name ?? '未命名模块',
          role: source?.role ?? module.role,
          content: source?.content ?? module.content,
          system_prompt: Boolean(source?.system_prompt ?? module.system_prompt),
          position: source?.position ?? module.position,
          injection_position: source?.injection_position ?? module.injection_position,
          injection_depth: source?.injection_depth ?? module.injection_depth,
          injection_order: source?.injection_order ?? module.injection_order,
          forbid_overrides: Boolean(source?.forbid_overrides ?? module.forbid_overrides),
          injection_trigger: clone(source?.injection_trigger ?? module.injection_trigger ?? []),
          marker: false,
        });
      }
      setPromptEnabled(preset, identifier, true);
      extension.modules[identifier] = { moduleId, boundAt: now };
      identifiers.push(identifier);
    }

    preset.extensions = { ...(preset.extensions || {}), [EXTENSION_KEY]: extension };
    await savePresetObject(name, preset);
    return identifiers;
  }

  async function copyModuleToPreset(moduleId, targetName) {
    const contextValue = context();
    const original = state.serverState.modules[moduleId];
    const preset = getPreset(targetName);
    if (!original || !preset) throw new Error('模块或目标预设不存在。');
    if (original.presetName && original.presetName === targetName) {
      notify('该模块已属于此预设。');
      return null;
    }

    if (state.serverState.settings.autoBackup) await backupPreset(targetName, 'auto');
    const newId = contextValue.uuidv4();
    const now = Date.now();
    const copy = { ...clone(original), id: newId, presetName: targetName, createdAt: now, updatedAt: now };
    state.serverState.modules[newId] = copy;

    const extension = clone(extensionData(preset));
    extension.schemaVersion = 1;
    extension.modules = extension.modules || {};
    let identifier = copy.sourceIdentifier || `pw_${newId}`;
    const promptFields = {
      name: copy.name || '未命名模块',
      role: copy.role,
      content: copy.content,
      system_prompt: Boolean(copy.system_prompt),
      position: copy.position,
      injection_position: copy.injection_position,
      injection_depth: copy.injection_depth,
      injection_order: copy.injection_order,
      forbid_overrides: Boolean(copy.forbid_overrides),
      injection_trigger: clone(copy.injection_trigger || []),
    };
    const existingPrompt = promptByIdentifier(preset, identifier);
    if (existingPrompt) {
      Object.assign(existingPrompt, promptFields);
    } else {
      if (preset.prompts.some(prompt => prompt?.identifier === identifier)) identifier = `${identifier}_${now}`;
      preset.prompts.push({ identifier, ...promptFields, marker: false });
    }
    setPromptEnabled(preset, identifier, true);
    extension.modules[identifier] = { moduleId: newId, boundAt: now };
    preset.extensions = { ...(preset.extensions || {}), [EXTENSION_KEY]: extension };
    await savePresetObject(targetName, preset);
    await persistState();
    return { newId, identifier };
  }

  function openCopyDialog(moduleId) {
    const original = state.serverState.modules[moduleId];
    if (!original) return;
    const targets = allPresetNames().filter(name => name !== original.presetName);
    if (!targets.length) {
      notify('没有可复制的目标预设。');
      return;
    }
    openDialog('复制模块副本到预设', `
      <p>将创建独立副本并绑定到选中的预设，原模块不受影响。</p>
      <div class="pw-sync-list">
        ${targets.map(name => `<label class="pw-checkbox"><input type="checkbox" value="${escapeHtml(name)}"><span>${escapeHtml(name)}</span></label>`).join('')}
      </div>
    `, '复制');
    document.querySelector('#pwDialogAccept').onclick = async () => {
      const selected = [...document.querySelectorAll('#pwDialogBody input:checked')].map(item => item.value);
      closeDialog();
      const newIds = [];
      for (const name of selected) {
        try {
          const result = await copyModuleToPreset(moduleId, name);
          if (result) newIds.push(result.newId);
        } catch (error) {
          notify(`${name}: ${error.message}`, 'error');
        }
      }
      if (newIds.length) {
        state.view = 'modules';
        state.selectedModule = newIds[0];
      }
      await refreshBackups();
      render();
      setStatus(`已复制 ${newIds.length} 个副本`, 'ok');
    };
  }

  async function toggleGroup(groupId, enabled) {
    const name = currentPresetName();
    const group = state.serverState.groups[groupId];
    const preset = getPreset(name);
    if (!group || !preset) return;
    if (state.serverState.settings.autoBackup) await backupPreset(name, 'auto');
    group.enabled = enabled;

    let affected = 0;
    for (const moduleId of group.moduleIds) {
      const identifier = boundIdentifier(preset, moduleId);
      if (identifier && promptByIdentifier(preset, identifier)) {
        setPromptEnabled(preset, identifier, enabled);
        affected += 1;
      }
    }

    await savePresetObject(name, preset);
    render();
    setStatus(`${enabled ? '开启' : '关闭'}了 ${affected} 个模块`, 'ok');
    await showDiffDialog(name);
  }

  async function switchPreset(name) {
    const manager = chatCompletionManager();
    const value = manager.findPreset(name);
    if (!value) return;
    manager.selectPreset(value);
    state.selectedPreset = name;
    presetMeta(name).lastUsed = Date.now();
    await persistState();
    render();
    setStatus(`已切换到 ${name}`, 'ok');
  }

  async function restoreBackup() {
    const record = state.backups.find(item => item.id === state.selectedBackup);
    if (!record) return;
    const backup = clone(state.serverState.backups.find(item => item.id === record.id));
    if (!backup) throw new Error('备份不存在。');
    const targetName = record.presetName || currentPresetName();
    const target = getPreset(targetName);
    if (!target) throw new Error(`无法读取预设 ${targetName}`);
    if (state.serverState.settings.autoBackup) await backupPreset(targetName, 'auto');
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, clone(backup.preset));
    await savePresetObject(targetName, target);
    await refreshBackups();
    render();
    setStatus(`已恢复 ${targetName}`, 'ok');
    await showDiffDialog(targetName);
  }

  async function refreshBackups() {
    state.backups = clone(state.serverState.backups || []);
  }

  async function savePresetTags(name, tags) {
    const preset = getPreset(name);
    if (!preset) return;
    const extension = clone(extensionData(preset));
    extension.schemaVersion = 1;
    extension.tags = tags;
    await chatCompletionManager().writePresetExtensionField({
      name,
      path: EXTENSION_KEY,
      value: extension,
    });
    presetMeta(name).tags = tags;
  }

  async function removeModuleBindings(moduleId) {
    const manager = chatCompletionManager();
    for (const name of allPresetNames()) {
      const preset = getPreset(name);
      const extension = clone(extensionData(preset));
      const identifiers = Object.entries(extension.modules || {})
        .filter(([, value]) => value?.moduleId === moduleId)
        .map(([identifier]) => identifier);
     if (!identifiers.length) continue;
      if (state.serverState.settings.autoBackup) await backupPreset(name, 'auto');
     for (const identifier of identifiers) delete extension.modules[identifier];
     await manager.writePresetExtensionField({ name, path: EXTENSION_KEY, value: extension });
    }
  }

  function createNewGroup() {
    const contextValue = context();
    const id = contextValue.uuidv4();
    state.serverState.groups[id] = { id, name: '新分组', moduleIds: [] };
    state.view = 'groups';
    state.selectedGroup = id;
    queueServerStateSave();
    render();
  }

  function createNewModule() {
    const contextValue = context();
    const id = contextValue.uuidv4();
    const now = Date.now();
    state.serverState.modules[id] = {
      id,
      name: '新模块',
      tags: [],
      role: 'system',
      content: '',
      system_prompt: false,
      injection_trigger: [],
      createdAt: now,
      updatedAt: now,
    };
    state.view = 'modules';
    state.selectedModule = id;
    queueServerStateSave();
    render();
  }

  function downloadExport(payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `preset-weaver-export-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function bindShellEvents() {
    document.querySelector('#pwFab').addEventListener('click', () => {
      if (state.fabDragged) {
        state.fabDragged = false;
        return;
      }
      state.open = !state.open;
      document.querySelector('#pwOverlay').classList.toggle('is-open', state.open);
      if (state.open) render();
    });
    document.querySelector('#pwCloseButton').addEventListener('click', () => {
      state.open = false;
      document.querySelector('#pwOverlay').classList.remove('is-open');
    });
    document.querySelector('#pwOverlay').addEventListener('click', event => {
      if (event.target.id === 'pwOverlay') {
        state.open = false;
        event.currentTarget.classList.remove('is-open');
      }
    });
    document.querySelector('#pwThemeButton').addEventListener('click', async () => {
      state.serverState.settings.theme = state.serverState.settings.theme === 'light' ? 'dark' : 'light';
      queueServerStateSave();
      render();
    });
    document.querySelector('#pwRefreshButton').addEventListener('click', async () => {
      state.serverState = await loadState();
      await refreshBackups();
      render();
    });
    document.querySelector('#pwSearch').addEventListener('input', event => {
      state.search = event.target.value;
      renderList();
    });
    document.querySelector('#pwViewTabs').addEventListener('click', event => {
      const button = event.target.closest('[data-view]');
      if (!button) return;
      state.view = button.dataset.view;
      state.search = '';
      render();
    });
    document.querySelector('#pwTagRow').addEventListener('click', event => {
      const chip = event.target.closest('[data-tag]');
      if (!chip) return;
      if (state.view === 'presets') state.presetTag = state.presetTag === chip.dataset.tag ? '' : chip.dataset.tag;
      else state.moduleTag = state.moduleTag === chip.dataset.tag ? '' : chip.dataset.tag;
      renderTags();
      renderList();
    });
    document.querySelector('#pwCreateButton').addEventListener('click', () => {
      if (state.view === 'groups') createNewGroup();
      if (state.view === 'modules') createNewModule();
    });
    document.querySelector('#pwList').addEventListener('click', async event => {
      const card = event.target.closest('[data-preset],[data-module],[data-group],[data-backup]');
      if (!card) return;
      if (card.dataset.preset) {
        await switchPreset(card.dataset.preset);
      } else if (card.dataset.module) {
        state.selectedModule = card.dataset.module;
        renderList();
        renderRight();
      } else if (card.dataset.group) {
        state.selectedGroup = card.dataset.group;
        renderList();
        renderRight();
      } else if (card.dataset.backup) {
        state.selectedBackup = card.dataset.backup;
        renderList();
        renderRight();
      }
    });
    document.querySelector('#pwList').addEventListener('change', event => {
      const toggle = event.target.closest('[data-module-toggle]');
      if (toggle) toggleModule(toggle.dataset.moduleToggle, toggle.checked);

      const groupToggle = event.target.closest('[data-group-toggle]');
      if (groupToggle) toggleGroup(groupToggle.dataset.groupToggle, groupToggle.checked);
    });
    document.querySelector('#pwRight').addEventListener('click', async event => {
      const tagAdd = event.target.closest('[data-tag-add]');
      if (tagAdd) {
        const kind = tagAdd.dataset.tagAdd;
        const tag = tagAdd.dataset.tag;
        const input = document.querySelector(kind === 'preset' ? '#pwPresetTags' : '#pwModuleTags');
        if (input) {
          const values = input.value.split(',').map(value => value.trim()).filter(Boolean);
          if (!values.includes(tag)) values.push(tag);
          input.value = values.join(', ');
          if (kind === 'preset') {
            const name = state.selectedPreset || currentPresetName();
            await savePresetTags(name, values);
            queueServerStateSave();
            renderTags();
            renderList();
          } else {
            const module = state.serverState.modules[state.selectedModule];
            if (module) {
              module.tags = values;
              queueServerStateSave();
              renderList();
            }
          }
        }
        return;
      }

      const actions = {
        pwExtractAll: async () => {
          const name = state.selectedPreset || currentPresetName();
          await extractAllPrompts(name);
        },
        pwSaveModule: async () => {
          const module = state.serverState.modules[state.selectedModule];
          module.name = document.querySelector('#pwModuleName').value.trim() || '未命名模块';
          module.tags = document.querySelector('#pwModuleTags').value.split(',').map(value => value.trim()).filter(Boolean);
          if (Array.isArray(module.prompts)) {
            module.prompts = module.prompts.map((prompt, index) => ({
              ...prompt,
              role: document.querySelector(`[data-module-prompt-role="${index}"]`)?.value || prompt.role,
              content: document.querySelector(`[data-module-prompt-content="${index}"]`)?.value ?? prompt.content,
            }));
            module.content = module.prompts.map(prompt => `### ${prompt.identifier || prompt.name}\n${prompt.content || ''}`).join('\n\n');
          } else {
            module.role = document.querySelector('#pwModuleRole')?.value || module.role;
            module.content = document.querySelector('#pwModuleContent')?.value ?? module.content;
          }
          module.updatedAt = Date.now();
          await persistState();
          renderList();
          setStatus('模块已保存，请确认同步范围', 'ok');
          openSyncDialog(module.id);
        },
       pwApplyModule: async () => {
         const name = currentPresetName();
         const preset = getPreset(name);
         const module = state.serverState.modules[state.selectedModule];
         if (!name || !preset || !module) return;
         if (module.presetName && module.presetName !== name) {
           notify('该模块为预设私有，不能应用到其他预设。', 'warning');
           return;
         }
         if (state.serverState.settings.autoBackup) await backupPreset(name, 'auto');
         if (boundIdentifiers(preset, state.selectedModule).length) {
           await syncModule(state.selectedModule, [name]);
         } else {
           await createModuleBinding(name, state.selectedModule);
           await refreshBackups();
           render();
           setStatus('模块已应用并绑定到当前预设', 'ok');
           await showDiffDialog(name);
         }
       },
        pwCopyModule: () => openCopyDialog(state.selectedModule),
       pwDeleteModule: async () => {
          const moduleId = state.selectedModule;
          confirmAction('删除模块', '模块会从模块库删除，并解除所有预设绑定；预设中的原提示词内容不会被删除。', async () => {
            await removeModuleBindings(moduleId);
            delete state.serverState.modules[moduleId];
            state.selectedModule = '';
            await persistState();
            render();
            setStatus('模块已删除并解除绑定', 'ok');
          });
        },
        pwGroupOn: () => toggleGroup(state.selectedGroup, true),
        pwGroupOff: () => toggleGroup(state.selectedGroup, false),
        pwDeleteGroup: async () => {
          const groupId = state.selectedGroup;
          confirmAction('删除分组', '只删除分组，不会修改组内模块或预设。', async () => {
            delete state.serverState.groups[groupId];
            state.selectedGroup = '';
            await persistState();
            render();
          });
        },
        pwRestoreBackup: () => confirmAction('恢复备份', '恢复前会自动备份当前预设；确认后当前同名预设会被备份内容覆盖。', restoreBackup, '恢复'),
        pwDeleteBackup: async () => {
          const backupId = state.selectedBackup;
          confirmAction('删除备份', '备份删除后不可恢复。', async () => {
            state.serverState.backups = state.serverState.backups.filter(item => item.id !== backupId);
            await persistState();
            state.selectedBackup = '';
            await refreshBackups();
            render();
          });
        },
        pwManualBackup: async () => {
          const record = await backupPreset(currentPresetName(), 'manual');
          await refreshBackups();
          state.selectedBackup = record.id;
          render();
          setStatus('已创建手动备份', 'ok');
        },
       pwExportButton: async () => downloadExport({
         schemaVersion: 1,
         exportedAt: new Date().toISOString(),
         state: clone(state.serverState),
         backups: clone(state.serverState.backups || []),
       }),
        pwResetPositions: () => {
          state.serverState.settings.positions = {};
          ['left', 'top', 'right', 'bottom', 'margin', 'position'].forEach(prop => {
            document.querySelector('#pwWindow')?.style.removeProperty(prop);
            document.querySelector('#pwFab')?.style.removeProperty(prop);
          });
          queueServerStateSave();
          render();
          setStatus('已重置窗口与按钮位置', 'ok');
        },
      };

      if (actions[event.target.id]) await actions[event.target.id]();
      if (event.target.dataset.theme) {
        state.serverState.settings.theme = event.target.dataset.theme;
        queueServerStateSave();
        render();
      }
    });
    document.querySelector('#pwRight').addEventListener('input', event => {
      if (event.target.id === 'pwGroupName') {
        state.serverState.groups[state.selectedGroup].name = event.target.value;
        queueServerStateSave();
      }
      if (event.target.id === 'pwRetention') {
        state.serverState.settings.backupRetention = Math.max(1, Math.min(500, Number(event.target.value) || 50));
        queueServerStateSave();
      }
    });
    document.querySelector('#pwRight').addEventListener('change', async event => {
      if (event.target.id === 'pwPresetTags') {
        const name = state.selectedPreset || currentPresetName();
        const tags = event.target.value.split(',').map(value => value.trim()).filter(Boolean);
        await savePresetTags(name, tags);
        queueServerStateSave();
        renderTags();
        renderList();
      }
      if (event.target.id === 'pwAutoBackup') {
        state.serverState.settings.autoBackup = event.target.checked;
        queueServerStateSave();
      }
      if (event.target.dataset.groupModule) {
        const group = state.serverState.groups[state.selectedGroup];
        const moduleId = event.target.dataset.groupModule;
        group.moduleIds = event.target.checked
          ? [...new Set([...group.moduleIds, moduleId])]
          : group.moduleIds.filter(id => id !== moduleId);
        queueServerStateSave();
        renderList();
      }
      if (event.target.dataset.promptToggle) {
        await togglePrompt(event.target.dataset.promptToggle, event.target.checked);
      }
      if (event.target.id === 'pwImportInput' && event.target.files?.[0]) {
        const file = event.target.files[0];
        try {
          const payload = JSON.parse(await file.text());
          confirmAction('导入数据', '导入会替换当前用户的模块库、分组、使用记录和备份清单。', async () => {
            const imported = normalizeState(payload.state);
            imported.backups = Array.isArray(payload.backups) ? payload.backups : imported.backups;
            state.serverState = imported;
            await persistState();
            await refreshBackups();
            render();
            notify(`导入完成，备份 ${imported.backups.length} 份。`, 'success');
          }, '导入');
        } catch {
          notify('导入文件不是有效的 JSON。', 'error');
        }
      }
    });
    document.querySelector('#pwDialogCancel').addEventListener('click', closeDialog);
    document.querySelector('#pwDialogOverlay').addEventListener('click', event => {
      if (event.target.id === 'pwDialogOverlay') closeDialog();
    });
  }

  function bindPresetEvents() {
    const contextValue = context();
    if (!contextValue?.eventSource) return;
    const handler = () => {
      state.selectedPreset = currentPresetName();
      if (state.selectedPreset) {
        presetMeta(state.selectedPreset).lastUsed = Date.now();
        queueServerStateSave();
      }
      if (state.open) render();
    };
    contextValue.eventSource.on(contextValue.event_types.OAI_PRESET_CHANGED_AFTER, handler);
    contextValue.eventSource.on(contextValue.event_types.PRESET_CHANGED, handler);
  }

  function bindDrag() {
    const header = document.querySelector('.pw-header');
    const windowEl = document.querySelector('#pwWindow');
    if (!header || !windowEl) return;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let rect = null;

    header.addEventListener('pointerdown', event => {
      if (event.target.closest('.pw-icon-btn')) return;
      dragging = true;
      rect = windowEl.getBoundingClientRect();
      startX = event.clientX;
      startY = event.clientY;
      windowEl.style.position = 'absolute';
      windowEl.style.left = `${rect.left}px`;
      windowEl.style.top = `${rect.top}px`;
      windowEl.style.margin = '0';
      header.setPointerCapture(event.pointerId);
    });

    header.addEventListener('pointermove', event => {
      if (!dragging) return;
      const left = Math.max(0, Math.min(window.innerWidth - windowEl.offsetWidth, rect.left + event.clientX - startX));
      const top = Math.max(0, Math.min(window.innerHeight - windowEl.offsetHeight, rect.top + event.clientY - startY));
      windowEl.style.left = `${left}px`;
      windowEl.style.top = `${top}px`;
    });

    const stop = event => {
      if (!dragging) return;
      dragging = false;
      state.serverState.settings.positions = state.serverState.settings.positions || {};
      state.serverState.settings.positions.window = {
        left: Number(windowEl.style.left?.replace('px', '') || 0),
        top: Number(windowEl.style.top?.replace('px', '') || 0),
      };
      queueServerStateSave();
      try { header.releasePointerCapture(event.pointerId); } catch { /* pointer already released */ }
    };
    header.addEventListener('pointerup', stop);
    header.addEventListener('pointercancel', stop);
  }

  function bindFabDrag() {
    const fab = document.querySelector('#pwFab');
    if (!fab) return;
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let rect = null;

    fab.addEventListener('pointerdown', event => {
      dragging = true;
      moved = false;
      startX = event.clientX;
      startY = event.clientY;
      rect = fab.getBoundingClientRect();
      fab.setPointerCapture(event.pointerId);
    });

    fab.addEventListener('pointermove', event => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      moved = true;
      fab.style.right = 'auto';
      fab.style.bottom = 'auto';
      const left = Math.max(0, Math.min(window.innerWidth - fab.offsetWidth, rect.left + dx));
      const top = Math.max(0, Math.min(window.innerHeight - fab.offsetHeight, rect.top + dy));
      fab.style.left = `${left}px`;
      fab.style.top = `${top}px`;
    });

    const stop = event => {
      if (!dragging) return;
      dragging = false;
      if (moved) state.fabDragged = true;
      if (moved) {
        state.serverState.settings.positions = state.serverState.settings.positions || {};
        state.serverState.settings.positions.fab = {
          left: Number(fab.style.left?.replace('px', '') || 0),
          top: Number(fab.style.top?.replace('px', '') || 0),
        };
        queueServerStateSave();
      }
      try { fab.releasePointerCapture(event.pointerId); } catch { /* pointer already released */ }
    };
    fab.addEventListener('pointerup', stop);
    fab.addEventListener('pointercancel', stop);
  }

  async function init() {
    const contextValue = context();
    if (!contextValue) {
      console.error('[Preset Weaver] SillyTavern context unavailable.');
      return;
    }
    if (document.querySelector('#pwFab')) return;

    injectShell();
    state.serverState = defaultServerState();
    render();
    bindShellEvents();
    bindDrag();
    bindFabDrag();
    bindPresetEvents();
    state.selectedPreset = currentPresetName();
    render();

    try {
      state.serverState = await loadState();
      await refreshBackups();
      state.ready = true;
      setStatus('本地数据已加载', 'ok');
      render();
    } catch (error) {
      setStatus('本地数据加载失败', 'error');
      notify(error.message || '浏览器本地存储不可用。', 'error');
      render();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
