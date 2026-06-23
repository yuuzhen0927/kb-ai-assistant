'use strict';
var obsidian = require('obsidian');
var VT = 'kb-ai-view';
var DS = {
  apiKey: '', baseUrl: 'https://api.deepseek.com/v1',
  models: ['deepseek-chat', 'deepseek-reasoner'],
  activeModel: 'deepseek-chat',
  temperature: 0.7, maxContextTokens: 60000,
  contextMode: 'all', customPrompts: [], sessions: [],
  systemPrompt: '你是一个个人知识库助手。用户使用 Obsidian 管理知识。\n\n你的职责：\n1. 根据笔记内容给出个性化建议\n2. 帮助整理思路、制定计划、分析差距\n3. 给出具体可执行的建议\n4. 语气温暖务实\n5. 超出笔记范围时标注"（通用建议）"\n6. 如果内容涉及具体笔记，直接引用笔记名'
};

var noteCache = {};
var cacheTime = 0;

function getNoteCache(app, force) {
  var now = Date.now();
  if (!force && cacheTime && now - cacheTime < 30000 && Object.keys(noteCache).length > 0) return Promise.resolve(noteCache);
  return new Promise(function(resolve) {
    var files = app.vault.getMarkdownFiles();
    noteCache = {};
    var pending = files.length;
    if (pending === 0) { cacheTime = now; resolve(noteCache); return; }
    files.forEach(function(f) {
      app.vault.cachedRead(f).then(function(c) {
        noteCache[f.basename] = { file: f, content: c, len: c.length };
        pending--;
        if (pending === 0) { cacheTime = now; resolve(noteCache); }
      });
    });
  });
}

function estimateTokens(text) {
  var cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  return Math.ceil(cjk * 1.5 + (text.length - cjk) / 3.5);
}

function renderMd(s) {
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="lang-$1">$2</code></pre>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  s = s.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  s = s.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
  s = s.replace(/^---$/gm, '<hr>');
  s = s.replace(/^\- (.+)$/gm, '<li>$1</li>');
  s = s.replace(/(<li>.*<\/li>\n?)+/g, function(m) { return '<ul>' + m + '</ul>'; });
  s = s.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  s = s.replace(/\n{2,}/g, '</p><p>');
  s = '<p>' + s + '</p>';
  s = s.replace(/<p><\/p>/g, '');
  s = s.replace(/<p>(<h[123]>)/g, '$1');
  s = s.replace(/(<\/h[123]>)<\/p>/g, '$1');
  s = s.replace(/<p>(<pre>)/g, '$1');
  s = s.replace(/(<\/pre>)<\/p>/g, '$1');
  s = s.replace(/<p>(<ul>)/g, '$1');
  s = s.replace(/(<\/ul>)<\/p>/g, '$1');
  s = s.replace(/<p>(<blockquote>)/g, '$1');
  s = s.replace(/(<\/blockquote>)<\/p>/g, '$1');
  s = s.replace(/<p>(<hr>)/g, '$1');
  return s;
}

function linkifyNotes(html) {
  Object.keys(noteCache).forEach(function(name) {
    var escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var re = new RegExp('([^a-zA-Z0-9\\/])(' + escaped + ')([^a-zA-Z0-9])', 'g');
    html = html.replace(re, function(m, pre, n, post) {
      return pre + '<a class="kb-note-link" data-note="' + n + '">' + n + '</a>' + post;
    });
  });
  return html;
}

// ── Find related notes ──
function findRelated(text, cache, limit) {
  var keywords = text.replace(/[^\u4e00-\u9fff\w\s]/g, '').split(/\s+/).filter(function(w) { return w.length > 1; });
  var scores = [];
  Object.keys(cache).forEach(function(name) {
    var score = 0;
    keywords.forEach(function(kw) {
      var lc = cache[name].content.toLowerCase();
      var idx = lc.indexOf(kw.toLowerCase());
      if (idx >= 0) score += 10 - Math.min(idx / 100, 5);
    });
    if (score > 0) scores.push({ name: name, score: score });
  });
  scores.sort(function(a, b) { return b.score - a.score; });
  return scores.slice(0, limit || 3);
}

// ── View ──
function AiView(leaf, plugin) {
  obsidian.ItemView.call(this, leaf);
  this.plugin = plugin;
  this.currentSession = 0;
  this.loading = false;
}
AiView.prototype = Object.create(obsidian.ItemView.prototype);
AiView.prototype.constructor = AiView;
AiView.prototype.getViewType = function() { return VT; };
AiView.prototype.getDisplayText = function() { return 'AI 助手'; };
AiView.prototype.getIcon = function() { return 'brain'; };

AiView.prototype.getSessions = function() {
  if (!this.plugin.settings.sessions || this.plugin.settings.sessions.length === 0)
    this.plugin.settings.sessions = [{ name: '对话 1', messages: [] }];
  return this.plugin.settings.sessions;
};

AiView.prototype.saveSessions = function() { this.plugin.saveSettings(); };

AiView.prototype.onOpen = function() {
  var self = this;
  this.contentEl.empty();
  this.contentEl.addClass('kb-ai-container');

  if (!this.plugin.settings.apiKey) {
    var warn = this.contentEl.createDiv({ cls: 'kb-ai-warn' });
    warn.createEl('div', { text: '未配置 API Key', cls: 'kb-ai-warn-title' });
    warn.createEl('a', { text: '前往设置 > KB AI 助手', cls: 'kb-ai-warn-link' })
      .addEventListener('click', function() { self.app.setting.open(); self.app.setting.openTabById('kb-ai-assistant'); });
    return Promise.resolve();
  }

  // Header
  var header = this.contentEl.createDiv({ cls: 'kb-ai-header' });
  header.createEl('span', { text: 'AI 助手', cls: 'kb-ai-title' });
  // Model selector
  self.modelSel = header.createEl('select', { cls: 'kb-model-select' });
  var models = this.plugin.settings.models || ['deepseek-chat'];
  models.forEach(function(m) {
    var opt = self.modelSel.createEl('option', { text: m, value: m });
    if (m === self.plugin.settings.activeModel) opt.selected = true;
  });
  self.modelSel.addEventListener('change', function() {
    self.plugin.settings.activeModel = self.modelSel.value;
    self.plugin.saveSettings();
  });
  // Export button
  var exportBtn = header.createEl('button', { cls: 'kb-ai-header-btn', attr: { 'aria-label': '导出对话' } });
  obsidian.setIcon(exportBtn, 'file-down');
  exportBtn.addEventListener('click', function() { self.exportToNote(); });

  // Session tabs
  self.sessionBar = self.contentEl.createDiv({ cls: 'kb-session-bar' });
  self.renderSessionTabs();

  // Context mode + token count
  var modeBar = self.contentEl.createDiv({ cls: 'kb-mode-bar' });
  self.modeBtn = modeBar.createEl('button', { cls: 'kb-mode-btn active', text: '全部笔记' });
  self.modeBtn2 = modeBar.createEl('button', { cls: 'kb-mode-btn', text: '当前笔记' });
  self.tokenEl = modeBar.createEl('span', { cls: 'kb-token-count', text: '' });
  self.modeBtn.addEventListener('click', function() {
    self.plugin.settings.contextMode = 'all'; self.plugin.saveSettings();
    self.modeBtn.addClass('active'); self.modeBtn2.removeClass('active');
    self.updateContext();
  });
  self.modeBtn2.addEventListener('click', function() {
    self.plugin.settings.contextMode = 'current'; self.plugin.saveSettings();
    self.modeBtn2.addClass('active'); self.modeBtn.removeClass('active');
    self.updateContext();
  });
  if (self.plugin.settings.contextMode === 'current') {
    self.modeBtn.removeClass('active'); self.modeBtn2.addClass('active');
  }

  // Context indicator
  self.contextEl = self.contentEl.createDiv({ cls: 'kb-context-bar' });

  // Messages
  self.chatEl = self.contentEl.createDiv({ cls: 'kb-ai-chat' });

  // Drag-drop support
  self.chatEl.addEventListener('dragover', function(e) { e.preventDefault(); self.chatEl.addClass('kb-drag-over'); });
  self.chatEl.addEventListener('dragleave', function() { self.chatEl.removeClass('kb-drag-over'); });
  self.chatEl.addEventListener('drop', function(e) {
    e.preventDefault(); self.chatEl.removeClass('kb-drag-over');
    var data = e.dataTransfer.getData('text/plain');
    if (data) {
      try {
        var parsed = JSON.parse(data);
        if (parsed.file) {
          self.sendMessage('请帮我分析这篇笔记：' + parsed.file);
          return;
        }
      } catch (ex) {}
      self.sendMessage('请帮我分析：\n\n' + data.slice(0, 2000));
    }
  });

  // Quick buttons
  

  // Input area
  var inputArea = self.contentEl.createDiv({ cls: 'kb-ai-input-area' });
  self.inputEl = inputArea.createEl('textarea', { cls: 'kb-ai-input', attr: { placeholder: '输入问题... (Enter 发送)', rows: '1' } });
  self.inputEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); self.sendMessage(); }
  });
  self.inputEl.addEventListener('input', function() {
    self.inputEl.style.height = 'auto';
    self.inputEl.style.height = Math.min(self.inputEl.scrollHeight, 100) + 'px';
  });
  self.sendBtn = inputArea.createEl('button', { cls: 'kb-ai-send-btn' });
  obsidian.setIcon(self.sendBtn, 'send');
  self.sendBtn.addEventListener('click', function() { self.sendMessage(); });

  self.renderMessages();
  self.updateContext();
  return Promise.resolve();
};

AiView.prototype.updateContext = function() {
  var self = this;
  if (!self.contextEl) return;
  self.contextEl.empty();
  getNoteCache(self.app).then(function(cache) {
    var names = [];
    if (self.plugin.settings.contextMode === 'current') {
      var file = self.app.workspace.getActiveFile();
      names = file && cache[file.basename] ? [file.basename] : [];
    } else {
      names = Object.keys(cache);
    }
    var total = 0;
    names.forEach(function(n) { if (cache[n]) total += estimateTokens(cache[n].content); });
    self.tokenEl.textContent = '~' + (total / 1000).toFixed(1) + 'k';
    // Show note names
    if (names.length <= 6) {
      names.forEach(function(n) {
        self.contextEl.createEl('span', { cls: 'kb-context-tag', text: n });
      });
    } else {
      self.contextEl.createEl('span', { cls: 'kb-context-tag', text: names.length + ' 篇笔记' });
    }
  });
};

AiView.prototype.renderSessionTabs = function() {
  var self = this;
  self.sessionBar.empty();
  var sessions = self.getSessions();
  sessions.forEach(function(s, i) {
    var tab = self.sessionBar.createEl('button', { cls: 'kb-session-tab' + (i === self.currentSession ? ' active' : ''), text: s.name });
    tab.addEventListener('click', function() { self.currentSession = i; self.renderSessionTabs(); self.renderMessages(); });
    tab.addEventListener('dblclick', function() {
      var n = prompt('重命名会话', s.name);
      if (n) { sessions[i].name = n; self.saveSessions(); self.renderSessionTabs(); }
    });
  });
  var addBtn = self.sessionBar.createEl('button', { cls: 'kb-session-tab kb-session-add', text: '+' });
  addBtn.addEventListener('click', function() {
    sessions.push({ name: '对话 ' + (sessions.length + 1), messages: [] });
    self.currentSession = sessions.length - 1;
    self.saveSessions(); self.renderSessionTabs(); self.renderMessages();
  });
  if (sessions.length > 1) {
    var delBtn = self.sessionBar.createEl('button', { cls: 'kb-session-tab kb-session-add', text: '−' });
    delBtn.addEventListener('click', function() {
      if (confirm('删除当前会话？')) {
        sessions.splice(self.currentSession, 1);
        self.currentSession = Math.max(0, self.currentSession - 1);
        self.saveSessions(); self.renderSessionTabs(); self.renderMessages();
      }
    });
  }
};



AiView.prototype.getMessages = function() {
  var s = this.getSessions();
  return s[this.currentSession] ? s[this.currentSession].messages : [];
};

AiView.prototype.renderMessages = function() {
  if (!this.chatEl) return;
  this.chatEl.empty();
  var self = this;
  var msgs = self.getMessages();
  if (msgs.length === 0) {
    msgs = [{ role: 'assistant', content: '你好！有什么可以帮你的？\n点击快捷按钮或直接输入问题。' }];
  }
  msgs.forEach(function(msg, idx) {
    var wrapper = self.chatEl.createDiv({ cls: 'kb-ai-msg kb-ai-' + msg.role });
    var bubble = wrapper.createDiv({ cls: 'kb-ai-bubble' });
    if (msg.role === 'assistant') {
      var html = renderMd(msg.content);
      html = linkifyNotes(html);
      bubble.innerHTML = html;
      bubble.querySelectorAll('.kb-note-link').forEach(function(a) {
        a.addEventListener('click', function() {
          var name = a.getAttribute('data-note');
          var file = noteCache[name] ? noteCache[name].file : null;
          if (file) self.app.workspace.openLinkText(file.path, '', true);
        });
      });
      // Streaming cursor
      if (self.loading && idx === msgs.length - 1) {
        bubble.createSpan({ cls: 'kb-cursor', text: '\u258D' });
      }
      // Related notes after last AI message
      if (idx === msgs.length - 1 && idx > 0 && !self.loading) {
        var related = findRelated(msg.content, noteCache, 3);
        if (related.length > 0) {
          var relBar = wrapper.createDiv({ cls: 'kb-related' });
          relBar.createEl('span', { cls: 'kb-related-label', text: '相关笔记:' });
          related.forEach(function(r) {
            var tag = relBar.createEl('a', { cls: 'kb-related-tag', text: r.name });
            tag.addEventListener('click', function() {
              var file = noteCache[r.name] ? noteCache[r.name].file : null;
              if (file) self.app.workspace.openLinkText(file.path, '', true);
            });
          });
        }
        // Action buttons
        var actions = wrapper.createDiv({ cls: 'kb-actions' });
        // Copy
        var copyBtn = actions.createEl('button', { cls: 'kb-action-btn', text: '复制' });
        obsidian.setIcon(copyBtn, 'copy');
        copyBtn.addEventListener('click', function() { navigator.clipboard.writeText(msg.content); new obsidian.Notice('已复制'); });
        // Regenerate
        if (idx > 0) {
          var regenBtn = actions.createEl('button', { cls: 'kb-action-btn', text: '重新生成' });
          obsidian.setIcon(regenBtn, 'refresh-cw');
          regenBtn.addEventListener('click', function() { self.regenerate(); });
        }
        // Save as note
        var saveBtn = actions.createEl('button', { cls: 'kb-action-btn', text: '存为笔记' });
        obsidian.setIcon(saveBtn, 'file-plus');
        saveBtn.addEventListener('click', function() { self.createNoteFromLast(); });
      }
      // Follow-up suggestions after last AI message (only when not loading)
      if (idx === msgs.length - 1 && idx > 0 && !self.loading) {
        var followUp = wrapper.createDiv({ cls: 'kb-followup' });
        var suggestions = self.getSuggestions(msgs);
        suggestions.forEach(function(sug) {
          var btn = followUp.createEl('button', { cls: 'kb-followup-btn', text: sug });
          btn.addEventListener('click', function() { self.sendMessage(sug); });
        });
      }
    } else {
      bubble.textContent = msg.content;
      // Edit button for user messages
      if (idx === msgs.length - 2 && !self.loading) {
        var editBtn = wrapper.createEl('button', { cls: 'kb-edit-btn', attr: { 'aria-label': '编辑重发' } });
        obsidian.setIcon(editBtn, 'pencil');
        editBtn.addEventListener('click', function() { self.editAndResend(idx); });
      }
    }
  });
  this.chatEl.scrollTop = this.chatEl.scrollHeight;
};

AiView.prototype.getSuggestions = function(msgs) {
  var last = msgs[msgs.length - 1];
  var content = last.content || '';
  if (content.includes('计划') || content.includes('行动')) return ['具体怎么做？', '有什么风险？', '帮我写个模板'];
  if (content.includes('技能') || content.includes('技术')) return ['怎么快速补齐？', '推荐学习资源', '帮我写简历'];
  if (content.includes('建议') || content.includes('总结')) return ['展开说说', '有什么补充？', '帮我存为笔记'];
  return ['继续', '换个角度分析', '帮我总结'];
};

AiView.prototype.regenerate = function() {
  var sessions = this.getSessions();
  var msgs = sessions[this.currentSession].messages;
  // Find last user message
  var lastUserIdx = -1;
  for (var i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') { lastUserIdx = i; break; }
  }
  if (lastUserIdx < 0) return;
  var lastUserMsg = msgs[lastUserIdx].content;
  // Remove last assistant message
  if (msgs[msgs.length - 1].role === 'assistant') msgs.pop();
  this.saveSessions();
  this.renderMessages();
  this.sendMessage(lastUserMsg);
};

AiView.prototype.editAndResend = function(idx) {
  var sessions = this.getSessions();
  var msgs = sessions[this.currentSession].messages;
  var msg = msgs[idx];
  if (!msg || msg.role !== 'user') return;
  var newText = prompt('编辑消息', msg.content);
  if (newText === null || newText === msg.content) return;
  // Remove this user msg and all after it
  sessions[this.currentSession].messages = msgs.slice(0, idx);
  this.saveSessions();
  this.renderMessages();
  this.sendMessage(newText);
};

AiView.prototype.addMessage = function(role, content) {
  var s = this.getSessions();
  if (!s[this.currentSession]) return;
  s[this.currentSession].messages.push({ role: role, content: content });
  this.saveSessions();
};

AiView.prototype.buildContext = function() {
  var self = this;
  return getNoteCache(self.app).then(function(cache) {
    var maxTokens = self.plugin.settings.maxContextTokens || 60000;
    if (self.plugin.settings.contextMode === 'current') {
      var file = self.app.workspace.getActiveFile();
      if (file && cache[file.basename]) return '# ' + file.basename + '\n\n' + cache[file.basename].content.slice(0, 8000);
      return '(没有打开的笔记)';
    }
    var contexts = [];
    var total = 0;
    Object.keys(cache).forEach(function(name) {
      var slice = Math.min(cache[name].content.length, 3000);
      var chunk = '# ' + name + '\n\n' + cache[name].content.slice(0, slice);
      var tokens = estimateTokens(chunk);
      if (total + tokens < maxTokens) {
        contexts.push(chunk);
        total += tokens;
      }
    });
    return contexts.length > 0 ? contexts.join('\n\n---\n\n') : '(知识库为空)';
  });
};

AiView.prototype.exportToNote = function() {
  var msgs = this.getMessages();
  if (msgs.length === 0) { new obsidian.Notice('没有可导出的对话'); return; }
  var md = '# AI 对话记录\n\n> 导出时间: ' + new Date().toLocaleString() + '\n\n---\n\n';
  msgs.forEach(function(m) { md += (m.role === 'user' ? '## 问题\n\n' : '## AI 回答\n\n') + m.content + '\n\n---\n\n'; });
  var name = 'AI对话-' + new Date().toISOString().slice(0, 10) + '.md';
  this.app.vault.create(name, md);
  new obsidian.Notice('已创建: ' + name);
};

AiView.prototype.createNoteFromLast = function() {
  var msgs = this.getMessages();
  if (msgs.length === 0) return;
  var title = prompt('笔记标题', 'AI生成-' + new Date().toISOString().slice(0, 10));
  if (!title) return;
  var last = msgs[msgs.length - 1];
  this.app.vault.create(title + '.md', '# ' + title + '\n\n> 由 AI 助手生成\n\n' + last.content);
  new obsidian.Notice('已创建: ' + title);
};

AiView.prototype.sendMessage = async function(text) {
  var msg = text || (this.inputEl ? this.inputEl.value.trim() : '');
  if (!msg || this.loading) return;
  if (this.inputEl) this.inputEl.value = '';
  this.addMessage('user', msg);
  this.loading = true;
  if (this.sendBtn) this.sendBtn.disabled = true;
  this.renderMessages();
  this.addMessage('assistant', '');
  this.renderMessages();

  try {
    var notesContext = await this.buildContext();
    var sys = this.plugin.settings.systemPrompt + '\n\n笔记内容：\n\n' + notesContext;
    var s = this.plugin.settings;
    var res = await fetch(s.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.apiKey },
      body: JSON.stringify({
        model: s.activeModel || s.model || 'deepseek-chat',
        messages: [{ role: 'system', content: sys }, { role: 'user', content: msg }],
        stream: true, temperature: s.temperature || 0.7, max_tokens: 4096
      })
    });

    if (!res.ok) {
      var errMsg = 'HTTP ' + res.status;
      if (res.status === 401) errMsg = 'API Key 无效';
      else if (res.status === 402) errMsg = 'API 额度已用尽';
      else if (res.status === 429) errMsg = '请求太频繁，请稍后重试';
      else if (res.status >= 500) errMsg = 'DeepSeek 服务异常';
      else if (!navigator.onLine) errMsg = '网络连接断开';
      throw new Error(errMsg);
    }

    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var full = '';
    var self = this;
    var sessions = self.getSessions();
    var lastIdx = sessions[self.currentSession].messages.length - 1;

    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      var txt = decoder.decode(chunk.value, { stream: true });
      txt.split('\n').forEach(function(line) {
        line = line.trim();
        if (!line || !line.startsWith('data: ')) return;
        var d = line.slice(6);
        if (d === '[DONE]') return;
        try {
          var delta = JSON.parse(d).choices[0].delta.content;
          if (delta) { full += delta; sessions[self.currentSession].messages[lastIdx].content = full; self.renderMessages(); }
        } catch (e) {}
      });
    }
    if (!full) sessions[self.currentSession].messages[lastIdx].content = '(空响应)';
    self.saveSessions();
    self.updateContext();
  } catch (e) {
    var sessions = this.getSessions();
    sessions[this.currentSession].messages[sessions[this.currentSession].messages.length - 1].content = '错误: ' + e.message;
    this.saveSessions();
  } finally {
    this.loading = false;
    if (this.sendBtn) this.sendBtn.disabled = false;
    this.renderMessages();
  }
};

// ── Settings ──
function AiSettingTab(app, plugin) {
  obsidian.PluginSettingTab.call(this, app, plugin);
  this.app = app;
  this.plugin = plugin;
}
AiSettingTab.prototype = Object.create(obsidian.PluginSettingTab.prototype);
AiSettingTab.prototype.constructor = AiSettingTab;

AiSettingTab.prototype.display = function() {
  var c = this.containerEl;
  c.empty();
  c.createEl('h2', { text: '知识库 AI 助手' });
  var plugin = this.plugin;

  // API
  c.createEl('h3', { text: 'API 设置' });
  new obsidian.Setting(c).setName('API Key').setDesc('platform.deepseek.com')
    .addText(function(t) { t.setPlaceholder('sk-...').setValue(plugin.settings.apiKey).onChange(async function(v) { plugin.settings.apiKey = v; await plugin.saveSettings(); }); });
  new obsidian.Setting(c).setName('API 地址')
    .addText(function(t) { t.setValue(plugin.settings.baseUrl).onChange(async function(v) { plugin.settings.baseUrl = v; await plugin.saveSettings(); }); });
  new obsidian.Setting(c).setName('模型列表').setDesc('逗号分隔')
    .addText(function(t) { t.setValue((plugin.settings.models || []).join(',')).onChange(async function(v) { plugin.settings.models = v.split(',').map(function(s){return s.trim()}).filter(Boolean); await plugin.saveSettings(); }); });

  // Temperature
  new obsidian.Setting(c).setName('Temperature').setDesc('创造性 (0-1)，越高越随机')
    .addSlider(function(sl) {
      sl.setLimits(0, 1, 0.1).setValue(plugin.settings.temperature || 0.7).setDynamicTooltip();
      sl.onChange(async function(v) { plugin.settings.temperature = v; await plugin.saveSettings(); });
    });

  // Context
  c.createEl('h3', { text: '上下文' });
  new obsidian.Setting(c).setName('最大上下文 Tokens').setDesc('超过自动截断笔记')
    .addText(function(t) { t.setValue(String(plugin.settings.maxContextTokens || 60000)).onChange(async function(v) { plugin.settings.maxContextTokens = parseInt(v) || 60000; await plugin.saveSettings(); }); });
  new obsidian.Setting(c).setName('清空笔记缓存').setDesc('强制重新读取所有笔记')
    .addButton(function(btn) { btn.setButtonText('清空').onClick(function() { cacheTime = 0; noteCache = {}; new obsidian.Notice('缓存已清空'); }); });

  // System prompt
  c.createEl('h3', { text: '系统提示词' });
  var ta = c.createEl('textarea', { cls: 'kb-setting-textarea', attr: { rows: '6' } });
  ta.value = plugin.settings.systemPrompt || DS.systemPrompt;
  ta.addEventListener('change', async function() { plugin.settings.systemPrompt = ta.value; await plugin.saveSettings(); });

  // Test
  new obsidian.Setting(c).setName('测试连接')
    .addButton(function(btn) {
      btn.setButtonText('测试').setCta();
      btn.onClick(async function() {
        btn.setButtonText('测试中...'); btn.setDisabled(true);
        try {
          var s = plugin.settings;
          var res = await fetch(s.baseUrl + '/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.apiKey },
            body: JSON.stringify({ model: s.activeModel || 'deepseek-chat', messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 20 })
          });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          await res.json(); btn.setButtonText('成功');
        } catch (e) { btn.setButtonText('失败'); }
        finally { btn.setDisabled(false); setTimeout(function() { btn.setButtonText('测试'); }, 3000); }
      });
    });

  // Custom prompts
  c.createEl('h3', { text: '自定义快捷提示' });
  var prompts = plugin.settings.customPrompts || [];
  prompts.forEach(function(p, i) {
    new obsidian.Setting(c)
      .addText(function(t) { t.setPlaceholder('按钮名称').setValue(p.label).onChange(function(v) { plugin.settings.customPrompts[i].label = v; plugin.saveSettings(); }); })
      .addText(function(t) { t.setPlaceholder('提示内容').setValue(p.prompt).onChange(function(v) { plugin.settings.customPrompts[i].prompt = v; plugin.saveSettings(); }); })
      .addButton(function(btn) { btn.setIcon('trash'); btn.onClick(async function() { plugin.settings.customPrompts.splice(i, 1); await plugin.saveSettings(); plugin.display(); }); });
  });
  new obsidian.Setting(c).addButton(function(btn) {
    btn.setButtonText('+ 添加').setCta();
    btn.onClick(async function() {
      if (!plugin.settings.customPrompts) plugin.settings.customPrompts = [];
      plugin.settings.customPrompts.push({ label: '', prompt: '' });
      await plugin.saveSettings(); plugin.display();
    });
  });
};

// ── Plugin ──
function KbAiPlugin() { return obsidian.Plugin.apply(this, arguments); }
KbAiPlugin.prototype = Object.create(obsidian.Plugin.prototype);
KbAiPlugin.prototype.constructor = KbAiPlugin;

KbAiPlugin.prototype.onload = async function() {
  this.settings = Object.assign({}, DS, await this.loadData());
  if (!this.settings.sessions) this.settings.sessions = [{ name: '对话 1', messages: [] }];
  if (!this.settings.customPrompts) this.settings.customPrompts = [];
  if (!this.settings.models) this.settings.models = ['deepseek-chat'];
  var self = this;
  this.registerView(VT, function(leaf) { return new AiView(leaf, self); });
  this.addRibbonIcon('brain', 'AI 助手', function() { self.activateView(); });
  this.addRibbonIcon('scan-text', 'AI 总结', function() { self.summarizeFromRibbon(); });
  this.addCommand({ id: 'open-ai', name: '打开 AI 助手', callback: function() { self.activateView(); } });
  this.addCommand({ id: 'ai-summarize', name: 'AI 总结当前笔记', callback: function() { self.summarizeFromRibbon(); } });
  this.addCommand({ id: 'ai-ask', name: 'AI 分析选中文本', callback: function() { self.askSelection(); } });
  this.addCommand({ id: 'open-ai-hotkey', name: '打开 AI (快捷键)', hotkeys: [{ modifiers: ['Ctrl', 'Shift'], key: 'a' }], callback: function() { self.activateView(); } });
  this.addSettingTab(new AiSettingTab(this.app, this));
};

KbAiPlugin.prototype.activateView = async function() {
  var leaves = this.app.workspace.getLeavesOfType(VT);
  if (leaves.length > 0) { this.app.workspace.revealLeaf(leaves[0]); return; }
  var leaf = this.app.workspace.getRightLeaf(false);
  await leaf.setViewState({ type: VT, active: true });
  this.app.workspace.revealLeaf(leaf);
};

KbAiPlugin.prototype.summarizeFromRibbon = async function() {
  var file = this.app.workspace.getActiveFile();
  if (!file) { new obsidian.Notice('请先打开一篇笔记'); return; }
  await this.activateView();
  var content = await this.app.vault.cachedRead(file);
  var leaves = this.app.workspace.getLeavesOfType(VT);
  if (leaves.length > 0 && leaves[0].view.sendMessage) {
    leaves[0].view.sendMessage('请帮我总结笔记《' + file.basename + '》的核心要点和行动项：\n\n' + content.slice(0, 3000));
  }
};

KbAiPlugin.prototype.askSelection = async function() {
  var editor = this.app.workspace.activeEditor && this.app.workspace.activeEditor.editor;
  if (!editor) { new obsidian.Notice('请先打开一篇笔记'); return; }
  var selected = editor.getSelection();
  if (!selected) { new obsidian.Notice('请先选中文字'); return; }
  await this.activateView();
  var leaves = this.app.workspace.getLeavesOfType(VT);
  if (leaves.length > 0 && leaves[0].view.sendMessage) {
    leaves[0].view.sendMessage('请分析以下内容：\n\n' + selected);
  }
};

KbAiPlugin.prototype.saveSettings = async function() { await this.saveData(this.settings); };

module.exports = KbAiPlugin;