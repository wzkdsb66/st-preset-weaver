(() => {
  'use strict';

  const PLUGIN_ID = 'st-preset-weaver';
  const EXTENSION_KEY = 'stPresetWeaver';
  const PROMPT_ORDER_ID = '100001';

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

  async function api(path, method = 'GET', body) {
    const contextValue = context();
    if (!contextValue) throw new Error('SillyTavern context is unavailable.');

    const response = await fetch(`/api/plugins/${PLUGIN_ID}${path}`, {
      method,
      credentials: 'same-origin',
      headers: contextValue.getRequestHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Request failed: ${response.status}`);
    return payload;
  }

  function queueServerStateSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(async () => {
      try {
        await api('/state', 'PUT', state.serverState);
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
      settings: {
        autoBackup: true,
        backupRetention: 50,
        theme: 'dark',
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
      <button id="pwFab" class="pw-fab" type="button" title="Preset Weaver">🧵</button>
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
        || module.content?.toLowerCase().includes(query);
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
        const identifier = boundIdentifier(currentPreset, module.id);
        const enabled = identifier ? promptEnabled(currentPreset, identifier) : null;
        return `
          <div class="pw-card ${module.id === state.selectedModule ? 'active' : ''}" data-module="${module.id}">
            <div class="pw-card-top">
              <div class="pw-name">${escapeHtml(module.name || '未命名模块')}</div>
              <label class="pw-meta" onclick="event.stopPropagation()">
                ${enabled === null ? '未绑定' : `<input type="checkbox" data-module-toggle="${module.id}" ${enabled ? 'checked' : ''}>`}
              </label>
            </div>
            <div class="pw-tags">${(module.tags || []).map(tag => `<span class="pw-tag">${escapeHtml(tag)}</span>`).join('')}</div>
          </div>
        `;
      }).join('') : '<div class="pw-empty">还没有模块</div>';
      return;
    }

    if (state.view === 'groups') {
      const groups = Object.values(state.serverState.groups);
      list.innerHTML = groups.length ? groups.map(group => `
        <div class="pw-card ${group.id === state.selectedGroup ? 'active' : ''}" data-group="${group.id}">
          <div class="pw-card-top"><div class="pw-name">${escapeHtml(group.name)}</div></div>
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
    const metadata = presetMeta(name);
    return `
      <div class="pw-editor">
        <div class="pw-section-title">${escapeHtml(name)}</div>
        <div class="pw-field">
          <label>标签（逗号分隔）</label>
          <input class="pw-input" id="pwPresetTags" value="${escapeHtml(presetTags(name).join(', '))}">
        </div>
        <div class="pw-field"><label>上次使用</label><div>${relativeTime(metadata.lastUsed)}</div></div>
        <div class="pw-field"><label>非 marker 提示词条目（${nonMarkers.length}）</label></div>
        <div class="pw-list">
          ${nonMarkers.map(prompt => {
            const enabled = promptEnabled(preset, prompt.identifier);
            const link = extensionData(preset).modules?.[prompt.identifier];
            return `
              <div class="pw-switch-row">
                <input type="checkbox" data-prompt-toggle="${escapeHtml(prompt.identifier)}" ${enabled ? 'checked' : ''}>
                <span>${escapeHtml(prompt.name || prompt.identifier)}</span>
                <button class="pw-button small" style="margin-left:auto" data-extract="${escapeHtml(prompt.identifier)}" type="button">
                  ${link ? '已绑定' : '提取'}
                </button>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  function renderModuleRight() {
    const module = state.serverState.modules[state.selectedModule];
    if (!module) return '<div class="pw-empty">选择或创建一个模块。</div>';
    return `
      <div class="pw-editor">
        <div class="pw-field"><label>模块名称</label><input class="pw-input" id="pwModuleName" value="${escapeHtml(module.name || '')}"></div>
        <div class="pw-field"><label>模块标签（逗号分隔）</label><input class="pw-input" id="pwModuleTags" value="${escapeHtml((module.tags || []).join(', '))}"></div>
        <div class="pw-field"><label>角色</label>
          <select class="pw-input" id="pwModuleRole">
            ${['system', 'user', 'assistant'].map(role => `<option value="${role}" ${module.role === role ? 'selected' : ''}>${role}</option>`).join('')}
          </select>
        </div>
        <div class="pw-field"><label>内容</label><textarea class="pw-textarea" id="pwModuleContent">${escapeHtml(module.content || '')}</textarea></div>
        <div style="display:flex; gap:8px;">
          <button class="pw-button primary" id="pwSaveModule" type="button">保存模块</button>
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
        <label class="pw-switch-row"><input id="pwAutoBackup" type="checkbox" ${settings.autoBackup ? 'checked' : ''}><span>覆盖、切换、恢复前自动备份</span></label>
        <div class="pw-field" style="margin-top:12px;"><label>备份保留数量（1–500）</label><input class="pw-input" id="pwRetention" type="number" min="1" max="500" value="${settings.backupRetention}"></div>
        <div class="pw-field"><label>主题</label><div style="display:flex; gap:8px;">
          <button class="pw-button ${settings.theme === 'dark' ? 'primary' : ''}" data-theme="dark" type="button">夜间</button>
          <button class="pw-button ${settings.theme === 'light' ? 'primary' : ''}" data-theme="light" type="button">白天</button>
        </div></div>
        <div class="pw-field"><label>数据迁移</label><div style="display:flex; gap:8px;">
          <button class="pw-button" id="pwExportButton" type="button">导出全部数据</button>
          <label class="pw-button" style="display:flex; align-items:center;">导入<input id="pwImportInput" class="pw-hidden" type="file" accept="application/json"></label>
        </div></div>
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

  function render() {
    if (!state.serverState) return;
    const windowElement = document.querySelector('#pwWindow');
    windowElement.classList.toggle('pw-light', state.serverState.settings.theme === 'light');
    document.querySelector('#pwThemeButton').textContent = state.serverState.settings.theme === 'light' ? '🌙' : '☀️';
    document.querySelector('#pwCurrent').textContent = `当前：${currentPresetName()}`;
    document.querySelector('#pwSearch').value = state.search;
    document.querySelector('#pwSearch').placeholder = state.view === 'modules' ? '搜索模块...' : '搜索...';
    if (!state.ready) {
      document.querySelector('#pwList').innerHTML = '<div class="pw-empty">正在连接 Server Plugin...</div>';
      document.querySelector('#pwRight').innerHTML = `
        <div class="pw-empty">
          <strong>Preset Weaver 需要 Server Plugin。</strong><br>
          请安装 <code>server-plugin/index.cjs</code> 到
          <code>plugins/st-preset-weaver/</code>，并在 <code>config.yaml</code> 中启用
          <code>enableServerPlugins: true</code>。
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
    return await api('/backups', 'POST', {
      kind,
      source: kind,
      presetName: name,
      preset: clone(preset),
      retention: state.serverState.settings.backupRetention,
    });
  }

  async function savePresetObject(name, preset) {
    const manager = chatCompletionManager();
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
        const identifier = boundIdentifier(preset, moduleId);
        const prompt = promptByIdentifier(preset, identifier);
        if (!prompt) {
          errors.push(`${name}: 找不到绑定条目`);
          continue;
        }

        if (state.serverState.settings.autoBackup) await backupPreset(name, 'auto');
        Object.assign(prompt, {
          name: module.name || prompt.name,
          role: module.role,
          content: module.content,
          system_prompt: Boolean(module.system_prompt),
          injection_position: module.injection_position ?? prompt.injection_position,
          injection_depth: module.injection_depth ?? prompt.injection_depth,
          injection_order: module.injection_order ?? prompt.injection_order,
          forbid_overrides: Boolean(module.forbid_overrides),
        });
        await savePresetObject(name, preset);
        synced += 1;
      } catch (error) {
        errors.push(`${name}: ${error.message}`);
      }
    }

    state.backups = await api('/backups');
    render();
    setStatus(`已同步 ${synced} 个预设`, 'ok');
    if (errors.length) notify(errors.join('\n'), 'error');
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
    await api('/state', 'PUT', state.serverState);
    state.view = 'modules';
    state.selectedModule = moduleId;
    render();
    setStatus('模块已提取并绑定', 'ok');
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
  }

  async function toggleModule(moduleId, enabled) {
    const name = currentPresetName();
    const preset = getPreset(name);
    const identifier = boundIdentifier(preset, moduleId);
    if (!preset || !identifier) return;
    await togglePrompt(identifier, enabled);
  }

  async function toggleGroup(groupId, enabled) {
    const name = currentPresetName();
    const group = state.serverState.groups[groupId];
    const preset = getPreset(name);
    if (!group || !preset) return;
    if (state.serverState.settings.autoBackup) await backupPreset(name, 'auto');

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
  }

  async function switchPreset(name) {
    const manager = chatCompletionManager();
    const value = manager.findPreset(name);
    if (!value) return;
    if (state.serverState.settings.autoBackup) await backupPreset(currentPresetName(), 'auto');
    manager.selectPreset(value);
    state.selectedPreset = name;
    presetMeta(name).lastUsed = Date.now();
    await api('/state', 'PUT', state.serverState);
    render();
    setStatus(`已切换到 ${name}`, 'ok');
  }

  async function restoreBackup() {
    const record = state.backups.find(item => item.id === state.selectedBackup);
    if (!record) return;
    const backup = await api(`/backups/${record.id}`);
    const targetName = record.presetName || currentPresetName();
    if (state.serverState.settings.autoBackup) await backupPreset(currentPresetName(), 'auto');
    await savePresetObject(targetName, clone(backup.preset));
    state.backups = await api('/backups');
    render();
    setStatus(`已恢复 ${targetName}`, 'ok');
  }

  async function refreshBackups() {
    state.backups = await api('/backups');
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
      const identifier = Object.entries(extension.modules || {})
        .find(([, value]) => value?.moduleId === moduleId)?.[0];
      if (!identifier) continue;
      delete extension.modules[identifier];
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
      state.serverState = await api('/state');
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
      const moduleToggle = event.target.closest('[data-module-toggle]');
      const card = event.target.closest('[data-preset],[data-module],[data-group],[data-backup]');
      if (moduleToggle) {
        await toggleModule(moduleToggle.dataset.moduleToggle, moduleToggle.checked);
        return;
      }
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
    });
    document.querySelector('#pwRight').addEventListener('click', async event => {
      const extract = event.target.closest('[data-extract]');
      if (extract) {
        await createModuleFromPrompt(extract.dataset.extract);
        return;
      }

      const actions = {
        pwSaveModule: async () => {
          const module = state.serverState.modules[state.selectedModule];
          module.name = document.querySelector('#pwModuleName').value.trim() || '未命名模块';
          module.tags = document.querySelector('#pwModuleTags').value.split(',').map(value => value.trim()).filter(Boolean);
          module.role = document.querySelector('#pwModuleRole').value;
          module.content = document.querySelector('#pwModuleContent').value;
          module.updatedAt = Date.now();
          await api('/state', 'PUT', state.serverState);
          renderList();
          setStatus('模块已保存，请确认同步范围', 'ok');
          openSyncDialog(module.id);
        },
        pwApplyModule: () => syncModule(state.selectedModule, [currentPresetName()]),
        pwDeleteModule: async () => {
          const moduleId = state.selectedModule;
          confirmAction('删除模块', '模块会从模块库删除，并解除所有预设绑定；预设中的原提示词内容不会被删除。', async () => {
            await removeModuleBindings(moduleId);
            delete state.serverState.modules[moduleId];
            state.selectedModule = '';
            await api('/state', 'PUT', state.serverState);
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
            await api('/state', 'PUT', state.serverState);
            render();
          });
        },
        pwRestoreBackup: () => confirmAction('恢复备份', '恢复前会自动备份当前预设；确认后当前同名预设会被备份内容覆盖。', restoreBackup, '恢复'),
        pwDeleteBackup: async () => {
          const backupId = state.selectedBackup;
          confirmAction('删除备份', '备份删除后不可恢复。', async () => {
            await api(`/backups/${backupId}`, 'DELETE');
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
        pwExportButton: async () => downloadExport(await api('/export')),
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
        const payload = JSON.parse(await file.text());
        confirmAction('导入数据', '导入会替换当前用户的模块库、分组、使用记录和备份清单。', async () => {
          const result = await api('/import', 'POST', payload);
          state.serverState = result.state;
          await refreshBackups();
          render();
          notify(`导入完成，备份 ${result.importedBackups} 份。`, 'success');
        }, '导入');
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
    bindPresetEvents();
    state.selectedPreset = currentPresetName();
    render();

    try {
      state.serverState = await api('/state');
      await refreshBackups();
      state.ready = true;
      setStatus('已连接 Server Plugin', 'ok');
      render();
    } catch (error) {
      setStatus('Server Plugin 未连接', 'error');
      notify('Preset Weaver 需要 Server Plugin。请将 server-plugin/index.cjs 安装到 plugins/st-preset-weaver/，并启用 enableServerPlugins。', 'error');
      render();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
