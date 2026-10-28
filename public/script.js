/* cards — flip-card grid app (drives public/index.html) */
(function () {
  'use strict';

  const ENDPOINT = 'https://cods.ai-n.workers.dev/chat';
  const LS_KEY = 'ai_ncards';

  const ge = (id) => document.getElementById(id);
  const el = (sel) => document.querySelector(sel);
  const clone = (v) => JSON.parse(JSON.stringify(v));

  const DEFAULT_THEME = {
    name: 'cards',
    primary: '#c41e3a',
    bg: '#0d0d0d',
    cardBg: '#1a1a2e',
    text: '#e8e8e8',
    border: '#2a2a3e',
    locked: false,
  };
  const VIEWS = ['list', 'grid', 'full'];
  const THEME_KEYS = ['primary', 'bg', 'cardBg', 'text', 'border'];

  function toast(msg) {
    const t = ge('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 1800);
  }

  const app = {
    cards: [],
    hist: [],
    sel: new Set(),
    ctxId: null,
    fsId: null,
    stId: null,
    pCtx: null,
    theme: Object.assign({}, DEFAULT_THEME),
    view: 'list',

    /* ─── persistence ─── */
    load() {
      try {
        const d = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
        if (!d) return;
        this.cards = Array.isArray(d.cards) ? d.cards : [];
        this.theme = Object.assign({}, DEFAULT_THEME, d.theme || {});
        this.view = VIEWS.indexOf(d.view) >= 0 ? d.view : 'list';
      } catch (e) {}
    },
    save() {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify({ cards: this.cards, theme: this.theme, view: this.view }));
      } catch (e) {}
    },

    /* ─── theme / view ─── */
    applyTheme() {
      const s = document.documentElement.style;
      s.setProperty('--p', this.theme.primary);
      s.setProperty('--p2', this.theme.primary);
      s.setProperty('--bg', this.theme.bg);
      s.setProperty('--cb', this.theme.cardBg);
      s.setProperty('--t', this.theme.text);
      s.setProperty('--b', this.theme.border);

      const inputs = { setPrimary: 'primary', setBg: 'bg', setCardBg: 'cardBg', setText: 'text', setBorder: 'border' };
      Object.keys(inputs).forEach((id) => {
        const i = ge(id);
        if (i && this.theme[inputs[id]]) i.value = this.theme[inputs[id]];
      });
      const lock = ge('lockTheme');
      if (lock) lock.checked = !!this.theme.locked;
      const name = ge('themeName');
      if (name && !name.value) name.value = this.theme.name;
      this.save();
    },
    applyView() {
      document.body.className = 'view-' + this.view;
      document.querySelectorAll('.tgl[data-view]').forEach((b) => {
        b.classList.toggle('on', b.getAttribute('data-view') === this.view);
      });
      this.save();
    },
    setView(v) {
      if (VIEWS.indexOf(v) < 0) return;
      this.view = v;
      this.applyView();
    },
    cycleView() {
      this.setView(VIEWS[(VIEWS.indexOf(this.view) + 1) % VIEWS.length]);
    },
    parseTheme(str) {
      if (!str) return;
      if (this.theme.locked) return toast('Theme is locked');
      const p = str.split(',').map((s) => s.trim());
      if (p[0]) this.theme.name = p[0];
      THEME_KEYS.forEach((k, i) => {
        if (p[i + 1]) this.theme[k] = p[i + 1];
      });
      this.applyTheme();
      toast('Theme: ' + this.theme.name);
    },

    /* ─── undo history ─── */
    pushHist(action) {
      if (this.hist.length > 10) this.hist.shift();
      this.hist.push({ cards: clone(this.cards), theme: Object.assign({}, this.theme), action: action, ts: Date.now() });
    },
    undo() {
      const s = this.hist.pop();
      if (!s) return toast('Nothing to undo');
      this.cards = s.cards;
      if (!this.theme.locked) this.theme = Object.assign({}, this.theme, s.theme);
      this.save();
      this.render();
      this.applyTheme();
      toast('Undid: ' + s.action);
    },

    /* ─── rendering ─── */
    updCount() {
      const n = ge('count');
      if (n) n.textContent = String(this.cards.length);
    },
    render() {
      const grid = ge('grid');
      if (!grid) return;
      grid.innerHTML = '';
      this.cards.forEach((c) => grid.appendChild(this.cardEl(c, false)));
      this.updCount();
      this.save();
    },
    cardEl(card, isNew) {
      const div = document.createElement('div');
      div.className =
        'card' + (isNew ? ' new' : '') + (this.sel.has(card.id) ? ' sel' : '') + (card.locked ? ' locked' : '');
      div.setAttribute('data-id', card.id);
      div.tabIndex = 0;

      const pending = card.r === '...' || card.r == null;
      const backHtml = pending ? '<div class="thinking"><span>Thinking</span></div>' : this.md(card.r);

      div.innerHTML =
        '<div class="card-body">' +
        '<div class="face"><div class="face-h"><span>Request</span><div class="actions">' +
        '<button type="button" onclick="app.openCtx(\'' + card.id + '\', event)" title="More"><i class="fas fa-ellipsis-v"></i></button>' +
        '<button type="button" onclick="app.toggleSel(\'' + card.id + '\', event)" title="Select"><i class="fas fa-check-circle"></i></button>' +
        '</div></div><div class="face-c">' + this.md(card.q) + '</div></div>' +
        '<div class="face back"><div class="face-h"><span>Response</span><div class="actions">' +
        '<button type="button" onclick="app.readTTS(\'' + card.id + '\', event)" title="Play"><i class="fas fa-volume-up"></i></button>' +
        '<button type="button" onclick="app.openCtx(\'' + card.id + '\', event)" title="More"><i class="fas fa-ellipsis-v"></i></button>' +
        '</div></div><div class="face-c">' + backHtml + '</div></div>' +
        '</div>';

      this.attach(div, card.id);
      return div;
    },
    attach(div, id) {
      let longPress = null;
      let lastTap = 0;

      div.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        if (this.sel.size) {
          e.stopPropagation();
          this.toggleSel(id, e);
          return;
        }
        div.classList.toggle('flip');
      });

      div.addEventListener('dblclick', (e) => {
        if (e.target.closest('button')) return;
        this.openFs(id);
      });

      div.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.openCtx(id, e);
      });

      div.addEventListener(
        'touchstart',
        (e) => {
          const t = e.touches && e.touches[0] ? e.touches[0] : e;
          longPress = setTimeout(() => {
            if (navigator.vibrate) navigator.vibrate(40);
            this.openCtx(id, t);
          }, 450);
          const now = Date.now();
          if (now - lastTap < 300) this.openFs(id);
          lastTap = now;
        },
        { passive: true }
      );
      ['touchend', 'touchmove', 'touchcancel'].forEach((ev) =>
        div.addEventListener(ev, () => clearTimeout(longPress), { passive: true })
      );
    },

    /* ─── card CRUD ─── */
    newId() {
      return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    },
    addCard(q, r) {
      const card = { id: this.newId(), q: q, r: r };
      this.cards.push(card);
      this.pushHist('Add');
      const grid = ge('grid');
      if (grid) grid.appendChild(this.cardEl(card, true));
      this.updCount();
      this.save();
      return card.id;
    },
    delCard(id) {
      this.cards = this.cards.filter((c) => c.id !== id);
      this.sel.delete(id);
      const node = document.querySelector('.card[data-id="' + id + '"]');
      if (node) node.remove();
      if (this.fsId === id) this.closeFs();
      this.updCount();
      this.updSelBar();
      this.save();
    },
    updCard(id, q, r) {
      const c = this.cards.find((x) => x.id === id);
      if (!c) return;
      if (q != null) c.q = q;
      if (r != null) c.r = r;

      const node = document.querySelector('.card[data-id="' + id + '"]');
      if (node) {
        const faces = node.querySelectorAll('.face-c');
        if (q != null && faces[0]) faces[0].innerHTML = this.md(q);
        if (r != null && faces[1]) faces[1].innerHTML = this.md(r);
      }
      if (this.fsId === id && r != null) {
        const body = ge('fsBody');
        if (body) body.innerHTML = this.md(r);
      }
      this.save();
    },

    /* ─── sending ─── */
    async ask(q, skipId) {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: q,
          cards: this.cards.filter((c) => c.id !== skipId).map((c) => ({ q: c.q, r: c.r })),
        }),
      });
      const body = await res.text();
      let data = null;
      try {
        data = JSON.parse(body);
      } catch (e) {}
      const answer = data && (data.response || data.answer);
      if (!answer) {
        const detail =
          (data && data.error) || String(body || '').trim().slice(0, 160) || 'no body';
        throw new Error('HTTP ' + res.status + ' from ' + ENDPOINT + ': ' + detail);
      }
      return answer;
    },
    async send(text) {
      const input = ge('input');
      const q = (text != null ? text : input ? input.value : '').trim();
      if (!q) return;
      if (input) input.value = '';

      const button = ge('sendBtn');
      if (button) button.disabled = true;

      const id = this.addCard(q, '...');
      try {
        const answer = await this.ask(q, id);
        this.updCard(id, null, answer);
        this.checkActions(answer);
      } catch (e) {
        const msg = e && e.message ? e.message : 'unknown error';
        this.updCard(id, null, 'Error: ' + msg);
        toast('Error: ' + msg);
      } finally {
        if (button) button.disabled = false;
      }
    },
    async editCard(id, prompt) {
      const card = this.cards.find((c) => c.id === id);
      if (!card) return this.send(prompt);
      this.updCard(id, null, '...');
      try {
        const answer = await this.ask(prompt, id);
        this.updCard(id, null, answer);
        this.checkActions(answer);
        toast('Card updated');
      } catch (e) {
        const msg = e && e.message ? e.message : 'unknown error';
        this.updCard(id, null, 'Error: ' + msg);
        toast('Error: ' + msg);
      }
    },
    checkActions(text) {
      if (!text) return;
      if (text.indexOf('!action:clear!') >= 0) {
        this.pushHist('Clear');
        this.cards = [];
        this.render();
      }
      if (text.indexOf('!action:view:grid!') >= 0) this.setView('grid');
      const m = text.match(/!theme:([^!]+)!/);
      if (m) this.parseTheme(m[1]);
    },

    /* ─── selection ─── */
    toggleSel(id, e) {
      if (e && e.stopPropagation) e.stopPropagation();
      const node = document.querySelector('.card[data-id="' + id + '"]');
      if (this.sel.has(id)) {
        this.sel.delete(id);
        if (node) node.classList.remove('sel');
      } else {
        this.sel.add(id);
        if (node) node.classList.add('sel');
      }
      this.updSelBar();
    },
    clearSel() {
      this.sel.clear();
      document.querySelectorAll('.card.sel').forEach((c) => c.classList.remove('sel'));
      this.updSelBar();
    },
    updSelBar() {
      const bar = ge('selectionBar');
      const count = ge('selCount');
      if (count) count.textContent = String(this.sel.size);
      if (!bar) return;
      bar.classList.toggle('show', this.sel.size > 0);
    },
    bulkDel() {
      if (!this.sel.size) return;
      const n = this.sel.size;
      this.pushHist('Delete');
      Array.from(this.sel).forEach((id) => this.delCard(id));
      this.clearSel();
      toast('Deleted ' + n + ' card(s)');
    },

    /* ─── context menu ─── */
    openCtx(id, e) {
      const menu = ge('ctxMenu');
      if (!menu) return;
      if (e && e.preventDefault) e.preventDefault();
      this.ctxId = id;
      const x = e && e.clientX != null ? e.clientX : window.innerWidth / 2;
      const y = e && e.clientY != null ? e.clientY : window.innerHeight / 2;
      menu.classList.add('show');
      menu.style.left = Math.max(8, Math.min(x, window.innerWidth - 200)) + 'px';
      menu.style.top = Math.max(8, Math.min(y, window.innerHeight - 320)) + 'px';
    },
    closeCtx() {
      const menu = ge('ctxMenu');
      if (menu) menu.classList.remove('show');
      this.ctxId = null;
    },
    handleAction(act, id) {
      if (act === 'delete') return this.delCard(id);
      if (act === 'view') return this.openFs(id);
      if (act === 'undo') return this.undo();
      if (act === 'edit' || act === 'magic' || act === 'continue' || act === 'split' || act === 'merge') {
        return this.prompt(act, id);
      }
    },

    /* ─── prompt modal ─── */
    openModal(id) {
      const m = ge(id);
      if (m) m.classList.add('show');
    },
    closeModal(id) {
      const m = ge(id);
      if (m) m.classList.remove('show');
    },
    prompt(act, id) {
      this.pCtx = act;
      this.stId = id || null;

      const card = this.cards.find((c) => c.id === id);
      const titles = {
        edit: 'Edit Card',
        magic: 'Magic Rewrite',
        continue: 'Continue',
        split: 'Split Card',
        merge: 'Merge Selected',
      };
      const descs = {
        edit: 'Change this card, then send it back to the model.',
        magic: 'The model rewrites this card in place.',
        continue: 'Extend the response of this card.',
        split: 'Break this card into separate cards.',
        merge: 'Combine the selected cards into one.',
      };

      const title = ge('promptTitle');
      const desc = ge('promptDesc');
      const input = ge('promptInput');
      const rad = ge('promptRad');
      if (title) title.textContent = titles[act] || act;
      if (desc) desc.textContent = descs[act] || '';
      if (input) input.value = '';
      if (rad) rad.value = '';

      if (card) {
        if (act === 'edit' && input) input.value = card.q + '\n\n' + (card.r || '');
        if (act === 'magic' && input) input.value = 'Rewrite this card:\nRequest: ' + card.q + '\nResponse: ' + (card.r || '');
        if (act === 'continue' && input) input.value = 'Continue from:\n' + (card.r || '');
        if (act === 'split' && input) input.value = 'Split this card into separate cards:\n' + card.q + '\n' + (card.r || '');
      }
      if (act === 'merge') {
        const picked = this.cards.filter((c) => this.sel.has(c.id));
        if (!picked.length) return toast('Select cards to merge first');
        if (input) {
          input.value =
            'Merge these cards into a single card.\n\n' +
            picked.map((c) => 'Request: ' + c.q + '\nResponse: ' + (c.r || '')).join('\n---\n');
        }
      }
      this.openModal('modalPrompt');
      if (input) setTimeout(() => input.focus(), 50);
    },
    execPrompt() {
      const input = ge('promptInput');
      const rad = ge('promptRad');
      const base = (input ? input.value : '').trim();
      const extra = (rad ? rad.value : '').trim();
      if (!base && !extra) return toast('Enter a prompt');

      const act = this.pCtx;
      const id = this.stId;
      const body = extra ? base + '\n\nAdditional context: ' + extra : base;

      this.closeModal('modalPrompt');

      if (act === 'merge') {
        this.pushHist('Merge');
        Array.from(this.sel).forEach((cid) => this.delCard(cid));
        this.clearSel();
        this.send(body);
      } else if (act === 'edit') {
        this.pushHist('Edit');
        this.closeFs();
        this.editCard(id, body);
      } else if (act === 'split') {
        this.pushHist('Split');
        this.closeFs();
        this.send(body);
      } else if (act === 'magic' || act === 'continue') {
        this.pushHist(act);
        this.closeFs();
        this.send(body);
      } else {
        this.send(body);
      }

      this.stId = null;
      this.pCtx = null;
    },
    /* ─── fullscreen ─── */
    openFs(id) {
      const card = this.cards.find((c) => c.id === id);
      if (!card) return;
      this.fsId = id;
      const body = ge('fsBody');
      if (body) body.innerHTML = this.md(card.r);
      this.openModal('fullscreen');
    },
    closeFs() {
      this.closeModal('fullscreen');
      this.fsId = null;
    },

    /* ─── TTS ─── */
    readTTS(id, e) {
      if (e && e.stopPropagation) e.stopPropagation();
      const card = this.cards.find((c) => c.id === id);
      if (!card) return;
      if (!('speechSynthesis' in window)) return toast('TTS not supported');
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(card.r || ''));
    },

    /* ─── data import / export ─── */
    exportCards() {
      const payload = JSON.stringify({ cards: this.cards, theme: this.theme, view: this.view }, null, 2);
      const blob = new Blob([payload], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'cards.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast('Exported ' + this.cards.length + ' card(s)');
    },
    importCards() {
      const picker = document.createElement('input');
      picker.type = 'file';
      picker.accept = '.json,application/json';
      picker.onchange = () => {
        const file = picker.files && picker.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const d = JSON.parse(String(reader.result));
            const incoming = Array.isArray(d) ? d : d.cards;
            if (!Array.isArray(incoming)) throw new Error('no cards array');
            this.pushHist('Import');
            this.cards = incoming.map((c) => ({
              id: c.id || this.newId(),
              q: c.q != null ? c.q : c.question || '',
              r: c.r != null ? c.r : c.response || '',
            }));
            if (!Array.isArray(d) && d.theme && !this.theme.locked) {
              this.theme = Object.assign({}, DEFAULT_THEME, d.theme);
            }
            this.render();
            this.applyTheme();
            toast('Imported ' + this.cards.length + ' card(s)');
          } catch (err) {
            toast('Invalid JSON');
          }
        };
        reader.readAsText(file);
      };
      picker.click();
    },
    clearAll() {
      if (!this.cards.length) return toast('No cards');
      if (!window.confirm('Clear all cards?')) return;
      this.pushHist('Clear all');
      this.cards = [];
      this.sel.clear();
      this.render();
      this.updSelBar();
      toast('All cards cleared');
    },

    /* ─── markdown ─── */
    md(text) {
      if (text == null) return '';
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/^### (.*)$/gm, '<h3>$1</h3>')
        .replace(/^## (.*)$/gm, '<h2>$1</h2>')
        .replace(/^# (.*)$/gm, '<h1>$1</h1>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
        .replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>')
        .replace(/^- (.*)$/gm, '<li>$1</li>')
        .replace(/^(\d+)\. (.*)$/gm, '<li>$2</li>')
        .replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        .replace(/\n/g, '<br>');
    },
  };

  /* ─── wiring ─── */
  function bind() {
    const input = ge('input');
    const sendBtn = ge('sendBtn');
    if (sendBtn) sendBtn.onclick = () => app.send();
    if (input) {
      input.onkeydown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          app.send();
        }
      };
    }

    const on = (id, fn) => {
      const node = ge(id);
      if (node) node.onclick = fn;
    };

    on('settingsBtn', () => app.openModal('modalSettings'));
    on('undoBtn', () => app.undo());
    on('viewFab', () => app.cycleView());
    on('viewFab2', () => app.cycleView());
    on('promptGo', () => app.execPrompt());
    on('cancelSel', () => app.clearSel());
    on('mergeSel', () => app.prompt('merge', null));
    on('splitSel', () => {
      const first = Array.from(app.sel)[0];
      app.prompt('split', first);
    });
    on('deleteSel', () => app.bulkDel());

    on('applyThemeBtn', () => {
      const map = { setPrimary: 'primary', setBg: 'bg', setCardBg: 'cardBg', setText: 'text', setBorder: 'border' };
      Object.keys(map).forEach((id) => {
        const i = ge(id);
        if (i) app.theme[map[id]] = i.value;
      });
      const name = ge('themeName');
      if (name && name.value.trim()) app.theme.name = name.value.trim();
      const lock = ge('lockTheme');
      if (lock) app.theme.locked = lock.checked;
      app.applyTheme();
      toast('Theme applied');
    });

    on('exportThemeBtn', () => {
      const t = app.theme;
      const cmd = '!theme:' + [t.name, t.primary, t.bg, t.cardBg, t.text, t.border].join(',') + '!';
      const box = ge('promptInput');
      if (box) box.value = cmd;
      app.openModal('modalPrompt');
      const title = ge('promptTitle');
      if (title) title.textContent = 'Theme command';
      const desc = ge('promptDesc');
      if (desc) desc.textContent = cmd;
      if (navigator.clipboard) navigator.clipboard.writeText(cmd).catch(() => {});
      toast('Theme command ready');
    });

    on('clearAllBtn', () => app.clearAll());
    on('exportBtn', () => app.exportCards());
    on('importBtn', () => app.importCards());

    const lock = ge('lockTheme');
    if (lock) {
      lock.onchange = () => {
        app.theme.locked = lock.checked;
        app.save();
        toast(lock.checked ? 'Theme locked' : 'Theme unlocked');
      };
    }

    document.querySelectorAll('.tgl[data-view]').forEach((btn) => {
      btn.onclick = () => app.setView(btn.getAttribute('data-view'));
    });

    const menu = ge('ctxMenu');
    if (menu) {
      menu.onclick = (e) => {
        const btn = e.target.closest('button[data-act]');
        if (!btn || !app.ctxId) return;
        const id = app.ctxId;
        const act = btn.getAttribute('data-act');
        app.handleAction(act, id);
        app.closeCtx();
      };
    }

    document.addEventListener('click', (e) => {
      const menu = ge('ctxMenu');
      if (menu && menu.classList.contains('show') && !e.target.closest('#ctxMenu') && !e.target.closest('.card')) {
        app.closeCtx();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        app.closeCtx();
        app.closeFs();
        app.closeModal('modalPrompt');
        app.closeModal('modalSettings');
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        app.undo();
      }
    });

    document.querySelectorAll('.overlay').forEach((o) => {
      o.addEventListener('click', (e) => {
        if (e.target === o) o.classList.remove('show');
      });
    });
  }

  app.load();
  app.applyTheme();
  app.applyView();
  app.render();
  app.updSelBar();
  bind();

  window.app = app;
})();
