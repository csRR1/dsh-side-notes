window.__ModuleLoader__.load({
  id: 'dsh-side-notes',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React;
    const h = React.createElement;

    // ---- 常量 ----
    const STORE_PREFIX = 'dsh.side-notes.v1.session.';
    const WORKSPACE_PREFIX = 'dsh.side-notes.v1.workspace.';
    const TAB_KIND = 'side-notes';
    const TAB_ID = 'dsh-side-notes/notes';
    const FLUSH_COOLDOWN_MS = 30000;
    const COUNTDOWN_START = 10;
    const DELETED_MAX = 20;
    const DELETED_TTL_MS = 7 * 24 * 3600 * 1000;
    const IDB_NAME = 'dsh-side-notes';
    const IDB_STORE = 'images';
    const EMPTY_WS = { items: [], deleted: [] };

    // ---- 工具 ----
    function uid(prefix) {
      return (prefix || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    // 消息锚点短标签（L3：assistant-actions 槽位只给 messageId，正文摘要留给 L4）
    function anchorLabel(messageId) {
      if (messageId == null) return '';
      const s = String(messageId);
      return s.length > 8 ? s.slice(-8) : s;
    }

    // ---- L4 档 1：本地规则回答（0 token，基于快照；答不了返回 null → 档 2/3） ----
    function answerTier1(q, snap) {
      const s = String(q || '').trim();
      if (!s) return null;
      const has = (kw) => s.indexOf(kw) !== -1;

      if (has('卡') || has('停') || has('等') || has('阻塞') || has('拦住')) {
        if (snap.blockedOn) return '卡住了：在等你的回答 —— ' + snap.blockedOn;
        return '没卡住。' + (snap.recentSteps ? '最近在弄：' + snap.recentSteps : '当前空闲，没有进行中的步骤。');
      }

      if (has('文件') || has('改了哪些') || has('改了什么') || has('碰了哪些') || has('动了哪些')) {
        return '文件清单暂不支持（留到后续版本）。';
      }

      if (has('下一步') || has('接下来') || has('接着') || has('然后')) {
        const inProg = snap.plan.find((t) => t.status === 'in_progress');
        if (inProg) return '下一步（进行中）：' + inProg.content;
        const pend = snap.plan.find((t) => t.status === 'pending');
        if (pend) return '下一步：' + pend.content;
        return '计划里没有待办了。';
      }

      if (has('计划') || has('方案') || has('清单') || has('有哪些') || has('哪些')) {
        if (!snap.plan.length) return '没有计划清单（agent 还没写 todo）。';
        return '计划：\n' + snap.plan.map((t, i) => (i + 1) + '. ' + t.content
          + (t.status === 'completed' ? ' ✓' : t.status === 'in_progress' ? ' ⟳' : '')).join('\n');
      }

      if (has('做到哪') || has('到哪') || has('进度') || has('状态') || has('怎么样') || has('完成多少')) {
        const total = snap.plan.length;
        const done = snap.plan.filter((t) => t.status === 'completed').length;
        const inProgN = snap.plan.filter((t) => t.status === 'in_progress').length;
        let a = '已到第 ' + snap.turn + ' 轮';
        if (total > 0) a += '；计划 ' + done + '/' + total + ' 完成' + (inProgN ? '，进行中 ' + inProgN : '');
        if (snap.recentSteps) a += '\n最近：' + snap.recentSteps;
        return a;
      }

      return null;
    }

    // ---- 全局视图（会话 / 项目），放 React 之外（无 keepMounted，组件会卸载） ----
    const viewStore = (() => {
      let view = 'session';
      const listeners = new Set();
      return {
        getSnapshot: () => view,
        subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
        set(v) { if (view !== v) { view = v; listeners.forEach((fn) => fn()); } },
      };
    })();

    // ---- 插件设置（localStorage 级，模块级 store；改完立即生效） ----
    const SETTINGS_KEY = 'dsh.side-notes.v1.settings';
    const DEFAULT_SETTINGS = { defaultMode: 'queue', autoFlush: true, maxMerge: 3, allowTier3: true };
    const settingsStore = (() => {
      function read() {
        try {
          const raw = localStorage.getItem(SETTINGS_KEY);
          if (!raw) return { ...DEFAULT_SETTINGS };
          const p = JSON.parse(raw);
          return { ...DEFAULT_SETTINGS, ...(p && typeof p === 'object' ? p : {}) };
        } catch (err) { return { ...DEFAULT_SETTINGS }; }
      }
      let state = read();
      const listeners = new Set();
      const persist = () => {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ v: 1, ...state })); } catch (err) { console.error('[side-notes] settings persist failed', err); }
      };
      const emit = () => listeners.forEach((fn) => fn());
      return {
        getSnapshot: () => state,
        subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
        set(patch) { state = { ...state, ...patch }; persist(); emit(); },
        reset() { state = { ...DEFAULT_SETTINGS }; persist(); emit(); },
      };
    })();

    // ---- 收件箱 store（内存 + localStorage，按 sessionId 隔离；L1 已有，保持不动） ----
    const storeCache = new Map();

    function loadItems(sessionId) {
      try {
        const raw = localStorage.getItem(STORE_PREFIX + sessionId);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed.items) ? parsed.items : [];
      } catch (err) {
        console.error('[side-notes] load failed', err);
        return [];
      }
    }

    function getStore(sessionId) {
      let store = storeCache.get(sessionId);
      if (!store) {
        let items = loadItems(sessionId);
        const listeners = new Set();
        const emit = () => listeners.forEach((fn) => fn());
        const persist = () => {
          try {
            localStorage.setItem(STORE_PREFIX + sessionId, JSON.stringify({ v: 1, items }));
          } catch (err) {
            console.error('[side-notes] persist failed', err);
          }
        };
        store = {
          getSnapshot: () => items,
          subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
          add(text) {
            const t = String(text || '').trim();
            if (!t) return;
            items = items.concat([{
              id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              text: t, status: 'queued', createdAt: Date.now(),
            }]);
            persist(); emit();
          },
          addAnnotation(text, messageId) {
            const t = String(text || '').trim();
            if (!t) return null;
            const item = {
              id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              text: t, kind: 'annotate', messageId: messageId || null, status: 'queued', createdAt: Date.now(),
            };
            items = items.concat([item]);
            persist(); emit();
            return item;
          },
          remove(id) { items = items.filter((it) => it.id !== id); persist(); emit(); },
          toggleHold(id) {
            items = items.map((it) => it.id === id
              ? { ...it, status: it.status === 'held' ? 'queued' : 'held' } : it);
            persist(); emit();
          },
          markDelivered(ids) {
            const set = new Set(ids);
            items = items.map((it) => set.has(it.id) ? { ...it, status: 'delivered' } : it);
            persist(); emit();
          },
        };
        storeCache.set(sessionId, store);
      }
      return store;
    }

    // ---- 图片 store（IndexedDB，键 = imageId，值 = { blob, thumb }） ----
    let idbPromise = null;
    function openDb() {
      if (!idbPromise) {
        idbPromise = new Promise((resolve, reject) => {
          const req = indexedDB.open(IDB_NAME, 1);
          req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(IDB_STORE)) {
              req.result.createObjectStore(IDB_STORE);
            }
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      }
      return idbPromise;
    }

    function idbPut(key, value) {
      return openDb().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }));
    }

    function idbGet(key) {
      return openDb().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }));
    }

    function idbDelete(key) {
      return openDb().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }));
    }

    const imageStore = {
      putImage(id, blob, thumb) { return idbPut(id, { blob, thumb }); },
      getImage(id) { return idbGet(id).then((rec) => (rec ? rec.blob : null)); },
      getThumb(id) { return idbGet(id).then((rec) => (rec ? (rec.thumb || rec.blob) : null)); },
      deleteImage(id) { return idbDelete(id); },
    };

    // ---- 图片压缩（长边 ≤ maxEdge，WebP，quality；失败回退 PNG/原文件） ----
    function loadImageEl(src) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('image load failed'));
        img.src = src;
      });
    }

    function drawScaled(file, maxEdge, quality) {
      const src = URL.createObjectURL(file);
      return loadImageEl(src).then((img) => {
        URL.revokeObjectURL(src);
        const nw = img.naturalWidth || 1;
        const nh = img.naturalHeight || 1;
        const scale = Math.min(1, maxEdge / Math.max(nw, nh));
        const w = Math.max(1, Math.round(nw * scale));
        const h2 = Math.max(1, Math.round(nh * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h2;
        const cx = canvas.getContext('2d');
        cx.drawImage(img, 0, 0, w, h2);
        return new Promise((resolve) => {
          canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else canvas.toBlob((png) => resolve(png || file), 'image/png');
          }, 'image/webp', quality);
        });
      }).catch((err) => {
        URL.revokeObjectURL(src);
        console.error('[side-notes] image scale failed', err);
        return file; // 兜底：原样存储
      });
    }

    async function ingestImage(file) {
      const id = uid('img');
      const original = await drawScaled(file, 1600, 0.82);
      const thumb = await drawScaled(file, 320, 0.82);
      await imageStore.putImage(id, original, thumb);
      return id;
    }

    // ---- 项目备忘 store（localStorage 按 workspaceId；storage 事件跨标签同步） ----
    const wsStoreCache = new Map();

    function loadWsData(workspaceId) {
      try {
        const raw = localStorage.getItem(WORKSPACE_PREFIX + workspaceId);
        if (!raw) return { items: [], deleted: [] };
        const parsed = JSON.parse(raw);
        return {
          items: Array.isArray(parsed.items) ? parsed.items : [],
          deleted: Array.isArray(parsed.deleted) ? parsed.deleted : [],
        };
      } catch (err) {
        console.error('[side-notes] workspace load failed', err);
        return { items: [], deleted: [] };
      }
    }

    function pruneDeleted(deleted) {
      const now = Date.now();
      return deleted.filter((d) => now - (d.deletedAt || 0) < DELETED_TTL_MS).slice(0, DELETED_MAX);
    }

    function getWorkspaceStore(workspaceId) {
      if (!workspaceId) return null;
      let store = wsStoreCache.get(workspaceId);
      if (!store) {
        let state = loadWsData(workspaceId);
        const listeners = new Set();
        const emit = () => listeners.forEach((fn) => fn());
        const persist = () => {
          try {
            localStorage.setItem(WORKSPACE_PREFIX + workspaceId,
              JSON.stringify({ v: 1, items: state.items, deleted: state.deleted }));
          } catch (err) {
            console.error('[side-notes] workspace persist failed', err);
          }
        };
        const commit = (next) => { state = next; persist(); emit(); };
        store = {
          getSnapshot: () => state,
          subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
          reload() { state = loadWsData(workspaceId); emit(); },
          add(text, images) {
            const t = String(text || '').trim();
            const imgs = Array.isArray(images) ? images : [];
            if (!t && imgs.length === 0) return null;
            const item = {
              id: uid('m'), text: t, done: false,
              createdAt: Date.now(), updatedAt: Date.now(), images: imgs,
            };
            commit({ ...state, items: state.items.concat([item]) });
            return item;
          },
          toggleDone(id) {
            commit({
              ...state,
              items: state.items.map((it) => it.id === id
                ? { ...it, done: !it.done, updatedAt: Date.now() } : it),
            });
          },
          editText(id, text) {
            const t = String(text == null ? '' : text).trim();
            const it = state.items.find((x) => x.id === id);
            if (!it || it.text === t) return;
            commit({
              ...state,
              items: state.items.map((x) => x.id === id
                ? { ...x, text: t, updatedAt: Date.now() } : x),
            });
          },
          addImages(id, imageIds) {
            const ids = Array.isArray(imageIds) ? imageIds.filter((x) => !!x) : [];
            if (!ids.length) return;
            const it = state.items.find((x) => x.id === id);
            if (!it) return;
            const existing = Array.isArray(it.images) ? it.images : [];
            commit({
              ...state,
              items: state.items.map((x) => x.id === id
                ? { ...x, images: existing.concat(ids), updatedAt: Date.now() } : x),
            });
          },
          remove(id) {
            const it = state.items.find((x) => x.id === id);
            if (!it) return;
            commit({
              items: state.items.filter((x) => x.id !== id),
              deleted: pruneDeleted([{ ...it, deletedAt: Date.now() }].concat(state.deleted)),
            });
          },
          restore(id) {
            const d = state.deleted.find((x) => x.id === id);
            if (!d) return;
            const rest = { id: d.id, text: d.text, done: d.done, createdAt: d.createdAt, updatedAt: Date.now(), images: d.images || [] };
            commit({
              items: state.items.concat([rest]),
              deleted: state.deleted.filter((x) => x.id !== id),
            });
          },
          purge(id) {
            const d = state.deleted.find((x) => x.id === id);
            commit({ items: state.items, deleted: state.deleted.filter((x) => x.id !== id) });
            if (d && d.images) d.images.forEach((imgId) => { imageStore.deleteImage(imgId).catch(() => {}); });
          },
          clearDeleted() {
            const all = state.deleted;
            commit({ items: state.items, deleted: [] });
            all.forEach((d) => d.images && d.images.forEach((imgId) => { imageStore.deleteImage(imgId).catch(() => {}); }));
          },
        };
        wsStoreCache.set(workspaceId, store);
      }
      return store;
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => {
        if (e.key && e.key.indexOf(WORKSPACE_PREFIX) === 0) {
          const wsId = e.key.slice(WORKSPACE_PREFIX.length);
          const store = wsStoreCache.get(wsId);
          if (store) store.reload();
        }
      });
    }

    // ---- 内联样式（颜色/字号取 DSH 主题 token，与左侧边栏一致、随主题联动） ----
    const panelStyle = { padding: 12, display: 'flex', flexDirection: 'column', gap: 8, fontFamily: 'inherit', flex: 1, minHeight: 0, overflow: 'hidden', boxSizing: 'border-box' };
    const scrollStyle = { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 };
    const rowStyle = { display: 'flex', gap: 8 };
    const inputStyle = { flex: 1, minWidth: 0, padding: '6px 8px', borderRadius: 'var(--dsw-radius-sm)', border: '1px solid var(--dsw-alias-border-l3)', background: 'transparent', color: 'var(--dsw-alias-label-primary)', fontSize: 14, outline: 'none', fontFamily: 'inherit' };
    const primaryBtnStyle = { padding: '6px 12px', borderRadius: 'var(--dsw-radius-sm)', border: 'none', background: 'var(--dsw-alias-state-business-primary)', color: '#fff', fontSize: 14, cursor: 'pointer', fontFamily: 'inherit' };
    const smallBtnStyle = { padding: '4px 8px', borderRadius: 'var(--dsw-radius-sm)', border: 'none', background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-primary)', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' };
    const interceptorStyle = { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 'var(--dsw-radius-sm)', background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-primary)', fontSize: 12, fontFamily: 'inherit' };
    const emptyStyle = { color: 'var(--dsw-alias-label-secondary)', fontSize: 13, padding: '12px 4px', lineHeight: 1.6, fontFamily: 'inherit' };
    const itemStyle = { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 'var(--dsw-radius-sm)', background: 'transparent', fontFamily: 'inherit' };
    const dotStyle = { width: 8, height: 8, borderRadius: 4, flexShrink: 0 };
    const itemTextStyle = { flex: 1, minWidth: 0, color: 'var(--dsw-alias-label-primary)', fontSize: 14, wordBreak: 'break-word', fontFamily: 'inherit' };
    const metaStyle = { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, flexShrink: 0, fontFamily: 'inherit' };
    const iconBtnStyle = { border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', fontSize: 14, cursor: 'pointer', padding: '2px 4px', lineHeight: 1, fontFamily: 'inherit' };
    const segmentStyle = { display: 'flex', gap: 4, padding: 2, borderRadius: 'var(--dsw-radius-sm)', background: 'var(--dsw-alias-interactive-bg-hover)' };
    const segBtn = (active) => ({
      flex: 1, padding: '5px 0', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 14, fontFamily: 'inherit',
      background: active ? 'var(--dsw-alias-state-business-primary)' : 'transparent',
      color: active ? '#fff' : 'var(--dsw-alias-label-secondary)',
    });
    const memoItemBodyStyle = { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 };
    const thumbRowStyle = { display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' };
    const checkboxStyle = { width: 14, height: 14, flexShrink: 0, cursor: 'pointer', accentColor: 'var(--dsw-alias-state-business-primary)' };
    const textBtnStyle = { border: 'none', background: 'transparent', color: 'var(--dsw-alias-state-business-primary)', fontSize: 12, cursor: 'pointer', padding: '2px 3px', lineHeight: 1, flexShrink: 0, fontFamily: 'inherit' };
    // 左栏底部「设置」按钮的样式（SettingsRoot.module.css .trigger），保持一致
    const footerActionStyle = {
      display: 'flex', alignItems: 'center', gap: 'var(--dsh-sidebar-label-gap)', width: '100%', height: 42,
      padding: '0 9px', borderRadius: 'var(--dsw-radius-md)', border: 'none', cursor: 'pointer',
      background: 'transparent', color: 'var(--dsw-alias-label-primary)', fontSize: 14, lineHeight: '22px',
      textAlign: 'left', boxSizing: 'border-box', fontFamily: 'inherit',
    };
    const footerActionRailStyle = {
      display: 'flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36,
      borderRadius: 'var(--dsw-radius-md)', border: 'none', cursor: 'pointer', background: 'transparent',
      color: 'var(--dsw-alias-label-primary)', fontSize: 18, boxSizing: 'border-box', fontFamily: 'inherit',
    };
    const footerHoverStyle = { background: 'var(--dsw-alias-interactive-bg-hover)' };
    // ---- L3 批注：助手消息 action 行内的 ✎ 按钮 + 悬浮输入框（token 随主题联动） ----
    const annotateBtnStyle = {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 28, height: 28, padding: 6, border: 'none', borderRadius: 'var(--dsw-radius-sm)',
      background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer',
      boxSizing: 'border-box',
    };
    const annotateBtnHoverStyle = { background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-secondary)' };
    const annotatePopoverStyle = {
      position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 1000, minWidth: 260,
      display: 'flex', alignItems: 'center', gap: 6, padding: 6,
      borderRadius: 'var(--dsw-radius-md)', background: 'var(--dsw-alias-bg-overlay)',
      border: '1px solid var(--dsw-alias-border-l3)', boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
      boxSizing: 'border-box',
    };
    const annotateInputStyle = {
      flex: 1, minWidth: 0, padding: '6px 8px', border: 'none', outline: 'none', background: 'transparent',
      color: 'var(--dsw-alias-label-primary)', fontSize: 14, fontFamily: 'inherit',
    };
    const annotateGoStyle = {
      padding: '5px 10px', border: 'none', borderRadius: 'var(--dsw-radius-sm)',
      background: 'var(--dsw-alias-state-business-primary)', color: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
    };
    const annotateUndoTextStyle = { color: 'var(--dsw-alias-label-primary)', fontSize: 13, whiteSpace: 'nowrap', fontFamily: 'inherit' };
    const annotateUndoBtnStyle = {
      padding: '5px 8px', border: 'none', borderRadius: 'var(--dsw-radius-sm)', background: 'transparent',
      color: 'var(--dsw-alias-state-business-primary)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
    };

    return {
      inject: ['slots', 'sessions', 'sidebarRightTabs', 'sidebarRight', 'conversation', 'workspaces'],
      apply(ctx) {
        console.info('[side-notes] L6 apply ok; services:', {
          sessions: typeof ctx.sessions,
          sidebarRightTabs: typeof ctx.sidebarRightTabs,
          sidebarRight: typeof ctx.sidebarRight,
          conversation: typeof ctx.conversation,
        });

        // ---- 投递：默认 steer，可传 mode；草稿为兜底（L1 已有） ----
        async function deliver(sessionId, text, mode) {
          const binding = ctx.sessions && ctx.sessions.binding(sessionId);
          const session = binding && binding.session;
          if (!session) return { ok: false, reason: 'no-session' };
          const res = await session.prompt([{ type: 'text', text }], mode || 'steer');
          const failed = res && (res.ok === false || res.error);
          console.info('[side-notes] deliver ' + (mode || 'steer'), failed ? 'FAILED' : 'OK', res);
          return { ok: !failed, res };
        }

        // ---- 图片拖出到 composer：createDrafts + addAttachments ----
        async function sendImageToInput(sessionId, imageId, inputActions) {
          const blob = await imageStore.getImage(imageId);
          if (!blob) return false;
          const file = new File([blob], 'memo-' + imageId + '.webp', { type: blob.type || 'image/webp' });
          let ordinary = false;
          try {
            const binding = ctx.sessions && ctx.sessions.binding(sessionId);
            ordinary = !!(binding && binding.session && binding.session.getSnapshot().subagent === null);
          } catch (err) { /* 保持 false */ }
          let drafts;
          try {
            drafts = ctx.conversation.createDrafts(sessionId, [file], ordinary);
          } catch (err) {
            console.error('[side-notes] createDrafts failed', err);
            return false;
          }
          const ids = drafts.map((d) => d.id);
          if (inputActions && typeof inputActions.addAttachments === 'function') {
            return !!inputActions.addAttachments(ids);
          }
          return true;
        }

        // ---- 图片缩略图（异步加载 IndexedDB，objectURL；双击放大灯箱） ----
        function ImageThumb(props) {
          const { imageId, size, onSend, onRemove } = props;
          const [url, setUrl] = useState(null);
          const [zoom, setZoom] = useState(false);
          const [zoomUrl, setZoomUrl] = useState(null);
          useEffect(() => {
            let alive = true;
            let created = null;
            imageStore.getThumb(imageId).then((blob) => {
              if (alive && blob) { created = URL.createObjectURL(blob); setUrl(created); }
            }).catch(() => {});
            return () => { alive = false; if (created) URL.revokeObjectURL(created); };
          }, [imageId]);
          const openZoom = () => {
            imageStore.getImage(imageId).then((blob) => {
              if (blob) { setZoomUrl(URL.createObjectURL(blob)); setZoom(true); }
            }).catch(() => {});
          };
          const closeZoom = () => {
            if (zoomUrl) URL.revokeObjectURL(zoomUrl);
            setZoomUrl(null);
            setZoom(false);
          };
          useEffect(() => {
            if (!zoom) return;
            const onKey = (e) => { if (e.key === 'Escape') closeZoom(); };
            document.addEventListener('keydown', onKey);
            return () => document.removeEventListener('keydown', onKey);
          }, [zoom, zoomUrl]);
          const sz = size || 44;
          return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
            url
              ? h('img', {
                src: url, alt: '', draggable: true, title: '双击放大',
                onDoubleClick: openZoom,
                onDragStart: (e) => {
                  try {
                    e.dataTransfer.setData('text/x-dsh-side-notes-image', imageId);
                    e.dataTransfer.effectAllowed = 'copy';
                  } catch (err) { /* 部分浏览器禁止 setData */ }
                },
                style: { width: sz, height: sz, objectFit: 'cover', borderRadius: 6, display: 'block', border: '1px solid rgba(255,255,255,0.12)', cursor: 'zoom-in' },
              })
              : h('span', { style: { width: sz, height: sz, borderRadius: 6, background: 'rgba(255,255,255,0.06)', display: 'inline-block' } }),
            onSend && h('button', { onClick: () => onSend(imageId), title: '发送到输入框', style: textBtnStyle }, '发送'),
            onRemove && h('button', { onClick: () => onRemove(imageId), title: '移除图片', style: iconBtnStyle }, '\u00D7'),
            zoom && h('div', {
              style: { position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, zIndex: 2000, background: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.72))', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out', padding: 24, boxSizing: 'border-box' },
              onClick: closeZoom,
            },
              zoomUrl && h('img', {
                src: zoomUrl, alt: '', onClick: (e) => e.stopPropagation(),
                style: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 6, boxShadow: '0 12px 48px rgba(0,0,0,0.5)' },
              }),
              h('button', {
                onClick: (e) => { e.stopPropagation(); closeZoom(); },
                title: '关闭', style: { position: 'absolute', top: 16, right: 16, width: 32, height: 32, border: 'none', borderRadius: 16, background: 'rgba(0,0,0,0.4)', color: '#fff', fontSize: 20, cursor: 'pointer', lineHeight: 1 },
              }, '\u00D7'),
            ),
          );
        }

        // ---- 旁注面板（右侧栏 tab body；L1 收件箱 + L2 项目备忘） ----
        function Panel(props) {
          const sessionId = props.sessionId;
          const useSession = props.useSession;
          const useInput = props.useInput;
          const inputActions = props.inputActions;
          const useWorkspaces = props.useWorkspaces;
          const useSessions = typeof props.useSessions === 'function' ? props.useSessions : (() => undefined);
          const mainCwd = useSessions((s) => (s && s.byId && s.byId[sessionId] ? s.byId[sessionId].cwd : undefined));

          // ---- L4 快照数据源：从 session projection 读（useProjection 是 session 标准 prop） ----
          const useProjection = typeof props.useProjection === 'function' ? props.useProjection : (() => undefined);
          const turnOutline = useProjection('turnOutline');
          const todosProj = useProjection('todos');
          const sessionStats = useProjection('sessionStats');
          const userQuestions = useProjection('userQuestions');

          const running = useSession((s) => s.running);
          const mainDraft = useInput((s) => s.draft);

          const store = getStore(sessionId);
          const items = useSyncExternalStore(store.subscribe, store.getSnapshot);

          const workspaceId = useWorkspaces((s) => {
            const found = s && s.items && s.items.find((w) => (w.sessionIds || []).indexOf(sessionId) !== -1);
            return found ? found.workspaceId : undefined;
          });
          const wsStore = workspaceId ? getWorkspaceStore(workspaceId) : null;
          const wsState = useSyncExternalStore(
            wsStore ? wsStore.subscribe : (() => () => {}),
            wsStore ? wsStore.getSnapshot : (() => EMPTY_WS),
          );

          const view = useSyncExternalStore(viewStore.subscribe, viewStore.getSnapshot);

          // 收件箱（会话）状态
          const [draft, setDraft] = useState('');
          const [countdown, setCountdown] = useState(null); // null | number

          // 旁问（L4 档 1 本地回答 / L5 档 3 子会话）状态
          const [askText, setAskText] = useState('');
          const [askAnswer, setAskAnswer] = useState(null);
          const [askBusy, setAskBusy] = useState(false);

          // 项目备忘状态
          const [memoDraft, setMemoDraft] = useState('');
          const [pendingImages, setPendingImages] = useState([]); // imageId[]
          const [showDeleted, setShowDeleted] = useState(false);
          const [editingMemoId, setEditingMemoId] = useState(null);
          const [editingMemoText, setEditingMemoText] = useState('');
          const editingCancelRef = useRef(false);
          const editRef = useRef(null);
          useEffect(() => {
            const el = editRef.current;
            if (!el) return;
            el.style.height = 'auto';
            el.style.height = el.scrollHeight + 'px';
          }, [editingMemoId, editingMemoText]);
          const fileRef = useRef(null);
          const attachFileRef = useRef(null);
          const attachingMemoIdRef = useRef(null);

          const itemsRef = useRef(items);
          itemsRef.current = items;
          const runningRef = useRef(running);
          const lastFlushRef = useRef(0);

          const pending = items.filter((it) => it.status === 'queued');

          // ---- L4 快照：0 token，本地从投影拼（文件清单留空，逐工具步骤用最近回复近似） ----
          const outline = Array.isArray(turnOutline) ? turnOutline : [];
          const lastOutline = outline.length ? outline[outline.length - 1] : null;
          const todoList = Array.isArray(todosProj) ? todosProj : [];
          const activeQ = (userQuestions && Array.isArray(userQuestions.active)) ? userQuestions.active : [];
          const snapshot = {
            turn: lastOutline ? lastOutline.turn : (sessionStats && typeof sessionStats.turns === 'number' ? sessionStats.turns : 0),
            lastUserAsk: lastOutline ? lastOutline.prompt : '',
            plan: todoList.map((t) => ({ content: t.content, status: t.status })),
            recentSteps: lastOutline ? lastOutline.response : '',
            filesTouched: null,
            blockedOn: activeQ.length ? activeQ[0].questions.map((qq) => qq.question).join('；') : null,
            pendingNotes: pending.map((it) => it.text),
          };
          const doneCount = snapshot.plan.filter((t) => t.status === 'completed').length;
          const inProgCount = snapshot.plan.filter((t) => t.status === 'in_progress').length;

          // ---- L5 档 3：新建独立子会话去查（读代码/查资料），读回结果 ----
          function waitForAnswer(child) {
            return new Promise((resolve) => {
              let done = false, started = false, polls = 0, timer = null;
              let unsub = () => {};
              const finish = (v) => {
                if (done) return;
                done = true;
                if (timer) clearInterval(timer);
                try { unsub(); } catch (e) { /* noop */ }
                resolve(v);
              };
              const read = () => {
                try {
                  const face = child.projections && child.projections.faceOf ? child.projections.faceOf('turnOutline') : null;
                  const val = face ? face.getSnapshot() : null;
                  if (Array.isArray(val) && val.length) {
                    const last = val[val.length - 1];
                    if (last && typeof last.response === 'string' && last.response.trim()) return last.response.trim();
                  }
                } catch (e) { /* noop */ }
                return '';
              };
              const tick = () => {
                polls++;
                let snap = null;
                try { snap = child.getSnapshot(); } catch (e) { return; }
                if (!snap) return;
                if (snap.running || snap.awaitingFirstTurn) started = true;
                if (!started && polls < 3) return; // 给它几秒启动
                if (!snap.running && !snap.awaitingFirstTurn) {
                  finish(read() || '（子会话结束，但没有文本回答）');
                }
              };
              timer = setInterval(tick, 1000);
              tick();
              setTimeout(() => finish('（子会话超时，未拿到回答）'), 180000);
            });
          }

          const runSideAsk = async (q) => {
            const question = String(q || '').trim();
            if (!question || askBusy) return;
            setAskBusy(true);
            setAskAnswer('档 3：正在开一个独立子会话去查…');
            let ref = null;
            try {
              // A′：优先独立「旁问」工作区（文件夹需已存在；失败回退主项目）
              let target = { cwd: mainCwd || undefined };
              const askDir = mainCwd ? String(mainCwd).replace(/[\\/]+$/, '') + '\\.side-notes-ask' : null;
              if (askDir && ctx.workspaces) {
                try {
                  const ws = await ctx.workspaces.create({ path: askDir });
                  if (ws && ws.workspaceId) target = { workspaceId: ws.workspaceId, cwd: askDir };
                } catch (e) {
                  console.warn('[side-notes] 旁问工作区不可用，回退主项目', e);
                }
              }
              const childId = await ctx.sessions.create(target);
              ref = ctx.sessions.retain(childId, { source: 'gateway' });
              const binding = await ref.ready;
              const child = binding.session;
              const text = '这是一个独立子会话，只做只读查证（读文件/搜索，不改文件）。'
                + '主项目目录：' + (mainCwd || '（未知）') + '。问题：' + question;
              await child.prompt([{ type: 'text', text }], 'queue');
              try { await ctx.sessions.refreshProjections(childId); } catch (e) { /* noop */ }
              const answer = await waitForAnswer(child);
              setAskAnswer(answer);
            } catch (err) {
              console.error('[side-notes] 档3 failed', err);
              setAskAnswer('档 3 失败：' + (err && err.message ? err.message : String(err)));
            } finally {
              if (ref) { try { ref.release(); } catch (e) { /* noop */ } }
              setAskBusy(false);
            }
          };

          const onAsk = () => {
            if (askBusy) return;
            const a = answerTier1(askText, snapshot);
            if (a != null) { setAskAnswer(a); return; }
            const s = String(askText || '').trim();
            if (settingsStore.getSnapshot().allowTier3 && /(查|找|搜|看|哪|位置|定义|调用|文件|代码|函数|方法|引用|实现|目录|类)/.test(s)) {
              runSideAsk(s);
            } else if (!settingsStore.getSnapshot().allowTier3) {
              setAskAnswer('旁问档 3 已在「设置」里关闭（当前只答本地问题）。');
            } else {
              setAskAnswer('本地答不了。要查代码/资料的话，输入里带上「查 / 找 / 在哪」等词，我会开一个子会话去查。');
            }
          };

          const steerBack = () => {
            if (!askAnswer || askBusy) return;
            deliver(sessionId, '【旁问】' + askAnswer, 'queue').then(() => { /* noop */ });
          };

          const doFlush = useCallback(() => {
            const cfg = settingsStore.getSnapshot();
            const queue = itemsRef.current.filter((it) => it.status === 'queued').slice(0, cfg.maxMerge || 3);
            if (queue.length === 0) return;
            const text = '【旁注】以下 ' + queue.length + ' 条请一并处理，不必逐条回复：\n'
              + queue.map((it, i) => (i + 1) + '. '
                + (it.kind === 'annotate' && it.messageId ? '[↳' + anchorLabel(it.messageId) + '] ' : '')
                + it.text).join('\n');
            lastFlushRef.current = Date.now();
            deliver(sessionId, text, cfg.defaultMode).then((res) => {
              if (res.ok) {
                store.markDelivered(queue.map((it) => it.id));
              } else if (inputActions) {
                inputActions.setDraft(text); // 降级：写进 composer 草稿
              }
            });
          }, [sessionId, store, inputActions]);

          // 停顿点检测：running true -> false，且主输入框无草稿，且冷却已过（L1 已有）
          useEffect(() => {
            const was = runningRef.current;
            runningRef.current = running;
            if (was && !running) {
              const hasQueue = itemsRef.current.some((it) => it.status === 'queued');
              const cooled = Date.now() - lastFlushRef.current >= FLUSH_COOLDOWN_MS;
              if (hasQueue && cooled && !mainDraft && settingsStore.getSnapshot().autoFlush) {
                setCountdown(COUNTDOWN_START);
              }
            }
          }, [running, mainDraft]);

          // 倒计时（L1 已有）
          useEffect(() => {
            if (countdown == null) return;
            if (countdown <= 0) { setCountdown(null); doFlush(); return; }
            const t = setTimeout(() => setCountdown((c) => (c == null ? null : c - 1)), 1000);
            return () => clearTimeout(t);
          }, [countdown, doFlush]);

          // ---- 收件箱动作 ----
          const onAdd = () => { store.add(draft); setDraft(''); };
          const onKeyDown = (e) => { if (e.key === 'Enter') { e.preventDefault(); onAdd(); } };

          // 提升为备忘（会话收件箱 → 项目备忘，移动）
          const promoteToMemo = (it) => {
            if (!wsStore) return;
            wsStore.add(it.text, []);
            store.remove(it.id);
          };

          // ---- 项目备忘动作 ----
          const onAddMemo = () => {
            if (!wsStore) return;
            const t = String(memoDraft || '').trim();
            const imgs = pendingImages;
            if (!t && imgs.length === 0) return;
            wsStore.add(t, imgs);
            setMemoDraft('');
            setPendingImages([]);
          };
          const onMemoKeyDown = (e) => { if (e.key === 'Enter') { e.preventDefault(); onAddMemo(); } };

          const addFiles = async (fileList) => {
            const imgs = Array.from(fileList || []).filter((f) => (f.type || '').indexOf('image/') === 0);
            for (const f of imgs) {
              try {
                const id = await ingestImage(f);
                setPendingImages((prev) => prev.concat([id]));
              } catch (err) {
                console.error('[side-notes] ingest failed', err);
              }
            }
          };
          const onPickFiles = (e) => { addFiles(e.target.files); if (fileRef.current) fileRef.current.value = ''; };
          const onAttachFiles = async (e) => {
            const files = Array.from(e.target.files || []).filter((f) => (f.type || '').indexOf('image/') === 0);
            if (attachFileRef.current) attachFileRef.current.value = '';
            const targetId = attachingMemoIdRef.current;
            attachingMemoIdRef.current = null;
            if (!targetId || !wsStore) return;
            const ids = [];
            for (const f of files) {
              try { ids.push(await ingestImage(f)); } catch (err) { console.error('[side-notes] attach image failed', err); }
            }
            if (ids.length) wsStore.addImages(targetId, ids);
          };
          const onPasteImages = (e) => {
            const items2 = e.clipboardData && e.clipboardData.items;
            if (!items2) return;
            const files = [];
            for (const it of items2) {
              if (it.kind === 'file' && (it.type || '').indexOf('image/') === 0) files.push(it.getAsFile());
            }
            if (files.length) { e.preventDefault(); addFiles(files); }
          };
          const onDropImages = (e) => {
            // 阻止冒泡到 document 级拖放监听（dsh-client-ui-attachment 会把文件投给主输入框）
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
          };
          const removePendingImage = (imgId) => {
            setPendingImages((prev) => prev.filter((x) => x !== imgId));
            imageStore.deleteImage(imgId).catch(() => {});
          };

          // 插入当前会话（项目备忘 → 会话收件箱，复制；备忘保留）
          const insertToSession = (it) => {
            if (it.text) store.add(it.text);
            else if (it.images && it.images.length) store.add('（含 ' + it.images.length + ' 张图片，请在项目视图点“发送”拖入输入框）');
          };

          const statusMeta = {
            queued: { color: '#9a9a9a', label: '排队' },
            held: { color: '#f0883e', label: '暂缓' },
            delivered: { color: '#3fb950', label: '已投递' },
          };

          // 排序：未完成在前，已完成下沉
          const activeMemos = wsState.items.filter((it) => !it.done).slice().sort((a, b) => b.createdAt - a.createdAt);
          const doneMemos = wsState.items.filter((it) => it.done).slice().sort((a, b) => b.updatedAt - a.updatedAt);
          const memoList = activeMemos.concat(doneMemos);
          const deletedList = wsState.deleted.slice().sort((a, b) => b.deletedAt - a.deletedAt);

          // 分段开关 + 正文
          return h('div', { style: panelStyle },
            h('div', { style: segmentStyle },
              h('button', { onClick: () => viewStore.set('session'), style: segBtn(view === 'session') }, '会话'),
              h('button', { onClick: () => viewStore.set('project'), style: segBtn(view === 'project') }, '项目备忘'),
              h('button', { onClick: () => viewStore.set('settings'), style: segBtn(view === 'settings') }, '设置'),
            ),

            view === 'session'
              // ===== 会话视图：上 1/3 旁问 + 下 2/3 收件箱 =====
              ? h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 } },
                // ---- 旁问区（上 1/3，可独立滚动） ----
                h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto', borderBottom: '1px solid var(--dsw-alias-border-l3)', paddingBottom: 8 } },
                  snapshot.plan.length > 0 && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                    h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', fontFamily: 'inherit' } },
                      h('span', null, '进度 ' + doneCount + '/' + snapshot.plan.length),
                      h('span', null, inProgCount ? '正在做 ' + inProgCount + ' 项' : ''),
                    ),
                    h('div', { style: { height: 6, borderRadius: 3, background: 'var(--dsw-alias-interactive-bg-hover)', overflow: 'hidden' } },
                      h('div', { style: { width: Math.round(doneCount / snapshot.plan.length * 100) + '%', height: '100%', background: 'var(--dsw-alias-state-business-primary)' } }),
                    ),
                  ),
                  h('div', { style: rowStyle },
                    h('input', {
                      value: askText, onChange: (e) => setAskText(e.target.value),
                      onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); onAsk(); } },
                      placeholder: '旁问（不打断）… 如：做到哪了 / 下一步 / 卡在哪 / 查 X 在哪',
                      disabled: askBusy, style: { ...inputStyle, fontFamily: 'var(--dsw-font-family)', opacity: askBusy ? 0.6 : 1 },
                    }),
                    h('button', {
                      onClick: onAsk, disabled: askBusy,
                      style: { ...primaryBtnStyle, opacity: askBusy ? 0.6 : 1, cursor: askBusy ? 'default' : 'pointer' },
                    }, askBusy ? '查…' : '问'),
                  ),
                  askAnswer != null && h('div', {
                    style: { whiteSpace: 'pre-wrap', color: 'var(--dsw-alias-label-primary)', fontSize: 14, lineHeight: 1.6, fontFamily: 'var(--dsw-font-family)', background: 'var(--dsw-alias-interactive-bg-hover)', borderRadius: 'var(--dsw-radius-sm)', padding: '8px 10px', wordBreak: 'break-word' },
                  }, askAnswer),
                  askAnswer != null && !askBusy && h('button', {
                    onClick: steerBack, style: { ...smallBtnStyle, alignSelf: 'flex-start' },
                  }, '→ 插回主线'),
                ),

                // ---- 收件箱区（下 2/3，可独立滚动） ----
                h('div', { style: { flex: 2, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto' } },
                  h('div', { style: rowStyle },
                    h('input', {
                      value: draft, onChange: (e) => setDraft(e.target.value), onKeyDown,
                      placeholder: '记一条…（Enter 进收件箱）', style: inputStyle,
                    }),
                    h('button', { onClick: onAdd, style: primaryBtnStyle }, '记下'),
                  ),

                  countdown != null && h('div', { style: interceptorStyle },
                    h('span', null, pending.length + ' 条旁注 ' + countdown + ' 秒后自动发送'),
                    h('button', { onClick: () => { setCountdown(null); doFlush(); }, style: smallBtnStyle }, '立即'),
                    h('button', { onClick: () => setCountdown(null), style: smallBtnStyle }, '取消'),
                  ),

                  items.length === 0
                    ? h('div', { style: emptyStyle }, '还没有旁注。agent 干活时按 Alt+Enter 或点输入框旁的便签图标。')
                    : items.map((it) => h('div', { key: it.id, style: itemStyle },
                      h('span', { style: { ...dotStyle, background: statusMeta[it.status].color } }),
                      h('span', { style: itemTextStyle },
                        it.kind === 'annotate' && it.messageId
                          ? h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, marginRight: 4, fontFamily: 'inherit' } }, '[↳' + anchorLabel(it.messageId) + '] ')
                          : null,
                        it.text,
                      ),
                      h('span', { style: metaStyle }, statusMeta[it.status].label),
                      it.status !== 'delivered' && wsStore && h('button', {
                        onClick: () => promoteToMemo(it), title: '提升为备忘', style: textBtnStyle,
                      }, '备忘'),
                      it.status !== 'delivered' && h('button', {
                        onClick: () => store.toggleHold(it.id), title: it.status === 'held' ? '恢复' : '暂缓',
                        style: iconBtnStyle,
                      }, it.status === 'held' ? '\u25B6' : '\u23F8'),
                      h('button', { onClick: () => store.remove(it.id), title: '删除', style: iconBtnStyle }, '\u00D7'),
                    )),

                  pending.length > 0 && h('button', {
                    onClick: doFlush, style: { ...primaryBtnStyle, width: '100%', marginTop: 10 },
                  }, '发送到主线（' + pending.length + '）'),
                ),
              )
              // ===== 项目视图（备忘） =====
              : view === 'project' ? h('div', {
                style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 },
                onDragEnter: (e) => { e.preventDefault(); e.stopPropagation(); },
                onDragOver: (e) => { e.preventDefault(); e.stopPropagation(); },
                onDrop: onDropImages,
              },
                !workspaceId && h('div', { style: emptyStyle }, '当前会话未关联工作区，无法保存项目备忘。'),

                workspaceId && h(React.Fragment, null,
                  h('div', { style: rowStyle },
                    h('input', {
                      value: memoDraft, onChange: (e) => setMemoDraft(e.target.value), onKeyDown: onMemoKeyDown,
                      onPaste: onPasteImages,
                      placeholder: '记一条项目备忘…（Enter 保存，可粘贴/拖入图片）', style: inputStyle,
                    }),
                    h('input', { ref: fileRef, type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' }, onChange: onPickFiles }),
                    h('input', { ref: attachFileRef, type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' }, onChange: onAttachFiles }),
                    h('button', { onClick: () => fileRef.current && fileRef.current.click(), title: '选择图片', style: iconBtnStyle, 'aria-label': '选择图片' }, '\uD83D\uDCF7'),
                    h('button', { onClick: onAddMemo, style: primaryBtnStyle }, '记下'),
                  ),

                  pendingImages.length > 0 && h('div', { style: thumbRowStyle },
                    pendingImages.map((imgId) => h(ImageThumb, { key: imgId, imageId: imgId, size: 48, onRemove: removePendingImage })),
                  ),

                  // 备忘列表（可滚动，占满剩余空间）
                  h('div', { style: scrollStyle },
                    memoList.length === 0 && deletedList.length === 0
                      ? h('div', { style: emptyStyle }, '还没有项目备忘。这里跨会话、跨标签页保存，写两条试试。')
                      : null,

                    memoList.map((it) => h('div', { key: it.id, style: { ...itemStyle, opacity: it.done ? 0.5 : 1, alignItems: 'flex-start', marginBottom: 3 } },
                      h('input', { type: 'checkbox', checked: !!it.done, onChange: () => wsStore.toggleDone(it.id), style: checkboxStyle, title: it.done ? '标记未完成' : '标记完成' }),
                      h('div', { style: memoItemBodyStyle },
                        editingMemoId === it.id
                          ? h('textarea', {
                            ref: editRef,
                            value: editingMemoText,
                            onChange: (e) => setEditingMemoText(e.target.value),
                            onKeyDown: (e) => {
                              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); editingCancelRef.current = false; wsStore.editText(it.id, editingMemoText); setEditingMemoId(null); }
                              else if (e.key === 'Escape') { editingCancelRef.current = true; setEditingMemoId(null); }
                            },
                            onBlur: () => {
                              if (editingCancelRef.current) { editingCancelRef.current = false; return; }
                              wsStore.editText(it.id, editingMemoText);
                              setEditingMemoId(null);
                            },
                            autoFocus: true,
                            rows: 1,
                            style: { width: '100%', boxSizing: 'border-box', padding: '4px 6px', borderRadius: 'var(--dsw-radius-sm)', border: '1px solid var(--dsw-alias-border-l3)', background: 'transparent', color: 'var(--dsw-alias-label-primary)', fontSize: 14, outline: 'none', fontFamily: 'var(--dsw-font-family)', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', resize: 'none', minHeight: 28, overflow: 'hidden' },
                          })
                          : h('div', {
                            style: { ...itemTextStyle, textDecoration: it.done ? 'line-through' : 'none', cursor: 'text' },
                            title: '双击编辑',
                            onDoubleClick: () => { setEditingMemoId(it.id); setEditingMemoText(it.text || ''); editingCancelRef.current = false; },
                          }, it.text || '（仅图片）'),
                        it.images && it.images.length > 0 && h('div', { style: thumbRowStyle },
                          it.images.map((imgId) => h(ImageThumb, { key: imgId, imageId: imgId, size: 44, onSend: (id) => { sendImageToInput(sessionId, id, inputActions).catch((e) => console.error('[side-notes] send image failed', e)); } })),
                        ),
                      ),
                      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0, alignItems: 'stretch' } },
                        h('button', { onClick: () => { attachingMemoIdRef.current = it.id; if (attachFileRef.current) attachFileRef.current.click(); }, title: '给这条备忘添加图片', style: { ...textBtnStyle, textAlign: 'center' } }, '加图'),
                        h('button', { onClick: () => insertToSession(it), title: '插入当前会话', style: { ...textBtnStyle, textAlign: 'center' } }, '插入'),
                        h('button', { onClick: () => wsStore.remove(it.id), title: '删除', style: { ...iconBtnStyle, textAlign: 'center', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 'var(--dsw-radius-sm)', width: 20, height: 20, boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0, alignSelf: 'center' } }, '\u00D7'),
                      ),
                    )),
                  ),

                  // 最近删除（固定在底部）
                  h('div', { style: { flexShrink: 0, paddingTop: 8, borderTop: '1px solid var(--dsw-alias-border-l3)' } },
                    h('button', { onClick: () => setShowDeleted((v) => !v), style: { ...smallBtnStyle, width: '100%', display: 'flex', justifyContent: 'space-between' } },
                      h('span', null, '最近删除（' + deletedList.length + '）'),
                      h('span', null, showDeleted ? '\u25B2' : '\u25BC'),
                    ),
                    showDeleted && (deletedList.length === 0
                      ? h('div', { style: emptyStyle }, '暂无已删除条目（7 天自动清理，最多保留 20 条）。')
                      : h('div', { style: { maxHeight: 160, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 } },
                        deletedList.map((d) => h('div', { key: d.id, style: { ...itemStyle, opacity: 0.6 } },
                          h('span', { style: itemTextStyle }, d.text || '（仅图片）'),
                          h('button', { onClick: () => wsStore.restore(d.id), title: '恢复', style: textBtnStyle }, '恢复'),
                          h('button', { onClick: () => wsStore.purge(d.id), title: '彻底删除', style: iconBtnStyle }, '\u00D7'),
                        )),
                        h('button', { onClick: () => wsStore.clearDeleted(), style: { ...smallBtnStyle, width: '100%' } }, '清空最近删除'),
                      )),
                  ),
                ),
              )
              : h(SettingsView, { sessionId: sessionId }),
          );
        }

        // ---- composer dock 便签按钮（带未读数，点击开 tab；L1 已有，保持不动） ----
        function DockBadge(props) {
          const sessionId = props.sessionId;
          const store = getStore(sessionId);
          const items = useSyncExternalStore(store.subscribe, store.getSnapshot);
          const count = items.filter((it) => it.status === 'queued').length;
          return h('button', {
            type: 'button',
            title: count ? count + ' 条待投递旁注' : '旁注',
            onClick: () => { try { ctx.sidebarRight.openTab(TAB_KIND); } catch (err) { console.error('[side-notes] openTab failed', err); } },
            'aria-label': '旁注',
            style: {
              position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 26, height: 26, borderRadius: 6, border: 'none', cursor: 'pointer',
              background: 'rgba(77,141,254,0.12)', color: '#4d8dfe', fontSize: 15, lineHeight: 1,
              userSelect: 'none', boxSizing: 'border-box', padding: 0,
            },
          },
            h('span', { 'aria-hidden': true }, '\u270E'),
            count > 0 && h('span', {
              style: {
                position: 'absolute', top: -4, right: -4, minWidth: 14, height: 14,
                borderRadius: 7, background: '#f85149', color: '#fff', fontSize: 10,
                display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px',
                boxSizing: 'border-box',
              },
            }, count > 99 ? '99+' : String(count)),
          );
        }

        // ---- 左栏底部「备忘」按钮（sidebar.footer.action；样式对齐左栏「设置」按钮） ----
        function FooterAction(props) {
          const wide = props.wide;
          const [hover, setHover] = useState(false);
          const base = wide ? footerActionStyle : footerActionRailStyle;
          return h('button', {
            type: 'button',
            title: '项目备忘',
            'aria-label': '项目备忘',
            onClick: () => {
              viewStore.set('project');
              try { ctx.sidebarRight.openTab(TAB_KIND); } catch (err) { console.error('[side-notes] openTab failed', err); }
            },
            onMouseEnter: () => setHover(true),
            onMouseLeave: () => setHover(false),
            style: hover ? { ...base, ...footerHoverStyle } : base,
          },
            h('svg', {
              viewBox: '0 0 16 16', width: wide ? 16 : 18, height: wide ? 16 : 18,
              'aria-hidden': true, style: { flexShrink: 0, display: 'block' },
            },
              h('rect', { x: 2, y: 2, width: 12, height: 12, rx: 2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 }),
              h('circle', { cx: 8, cy: 8, r: 3, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 }),
            ),
            wide && h('span', null, '项目备忘'),
          );
        }

        // ---- L3 助手消息批注：assistant-actions 槽位 ✎ + 悬浮输入 + 5 秒撤回 ----
        function AnnotateAction(props) {
          const sessionId = props.sessionId;
          const messageId = props.messageId;
          const store = getStore(sessionId);
          const [open, setOpen] = useState(false);
          const [text, setText] = useState('');
          const [undo, setUndo] = useState(null); // { id, left }
          const [hover, setHover] = useState(false);
          const rootRef = useRef(null);
          const inputRef = useRef(null);

          useEffect(() => {
            if (open && inputRef.current) { try { inputRef.current.focus(); } catch (err) { /* noop */ } }
          }, [open]);

          // 5 秒撤回倒计时
          useEffect(() => {
            if (!undo) return;
            if (undo.left <= 0) { setUndo(null); return; }
            const t = setTimeout(() => setUndo((u) => (u ? { ...u, left: u.left - 1 } : null)), 1000);
            return () => clearTimeout(t);
          }, [undo]);

          // 点击外部关闭
          useEffect(() => {
            if (!open) return;
            const onDown = (e) => {
              if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
            };
            document.addEventListener('pointerdown', onDown);
            return () => document.removeEventListener('pointerdown', onDown);
          }, [open]);

          const submit = () => {
            const t = String(text).trim();
            setText('');
            setOpen(false);
            if (!t) return;
            const item = store.addAnnotation(t, messageId);
            if (item) setUndo({ id: item.id, left: 5 });
          };
          const retract = () => {
            if (undo) { store.remove(undo.id); setUndo(null); }
          };

          return h('span', { ref: rootRef, style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
            h('button', {
              type: 'button',
              'aria-label': '批注',
              title: '批注这条助手消息',
              onClick: () => setOpen((v) => !v),
              onMouseEnter: () => setHover(true),
              onMouseLeave: () => setHover(false),
              style: hover ? { ...annotateBtnStyle, ...annotateBtnHoverStyle } : annotateBtnStyle,
            },
              h('svg', { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true },
                h('path', { d: 'M12 20h9', strokeLinecap: 'round' }),
                h('path', { d: 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z', strokeLinejoin: 'round' }),
              ),
            ),

            (open || undo) && h('span', { style: annotatePopoverStyle },
              open
                ? h(React.Fragment, null,
                  h('input', {
                    ref: inputRef, value: text, onChange: (e) => setText(e.target.value),
                    onKeyDown: (e) => {
                      if (e.key === 'Enter') { e.preventDefault(); submit(); }
                      else if (e.key === 'Escape') setOpen(false);
                    },
                    placeholder: '批注这条消息…', style: annotateInputStyle,
                  }),
                  h('button', { onClick: submit, style: annotateGoStyle }, '记下'),
                )
                : h(React.Fragment, null,
                  h('span', { style: annotateUndoTextStyle }, '已批注 · ' + undo.left + 's'),
                  h('button', { onClick: retract, style: annotateUndoBtnStyle }, '撤回'),
                ),
            ),
          );
        }

        // ---- L6 错误边界：面板崩溃不拖垮主对话 ----
        class PanelErrorBoundary extends React.Component {
          constructor(props) {
            super(props);
            this.state = { error: null };
          }

          static getDerivedStateFromError(error) {
            return { error };
          }

          componentDidCatch(error) {
            console.error('[side-notes] panel crashed', error);
          }

          render() {
            if (this.state.error) {
              return h('div', { style: { padding: 12, color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: 1.6, fontFamily: 'inherit' } },
                '旁注面板出错了：'
                + (this.state.error && this.state.error.message ? this.state.error.message : '未知错误')
                + '（刷新页面可恢复）');
            }
            return this.props.children;
          }
        }

        function SafePanel(props) {
          return h(PanelErrorBoundary, null, h(Panel, props));
        }

        // ---- L6 设置视图（localStorage 级，改完立即生效） ----
        function SettingsView(props) {
          const sessionId = props && props.sessionId;
          const settings = useSyncExternalStore(settingsStore.subscribe, settingsStore.getSnapshot);
          const [clearBusy, setClearBusy] = useState(false);
          const [clearMsg, setClearMsg] = useState(null);
          const onClear = () => {
            if (clearBusy || !sessionId) return;
            setClearBusy(true);
            setClearMsg('已通知宿主清理…');
            let session = null;
            try { const b = ctx.sessions.binding(sessionId); session = b && b.session; } catch (e) { session = null; }
            if (!session) { setClearBusy(false); setClearMsg('当前会话不可用。'); return; }
            session.command('/side-notes-clear').then((res) => {
              setClearBusy(false);
              const matched = res && res.ok && res.value && res.value.matched;
              if (matched) setClearMsg('已触发清理；宿主会删除旁问会话日志，刷新后生效。');
              else if (res && res.ok) setClearMsg('命令未匹配（需重启 DSH 加载 Host 插件后可用）。');
              else setClearMsg('清理失败：' + (res && res.error && res.error.message ? res.error.message : '未知错误'));
            }).catch((err) => {
              setClearBusy(false);
              setClearMsg('清理失败：' + (err && err.message ? err.message : err));
            });
          };
          const sRow = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '4px 0' };
          const sLabel = { color: 'var(--dsw-alias-label-primary)', fontSize: 13, fontFamily: 'inherit' };
          const sSeg = { display: 'flex', gap: 4, padding: 2, borderRadius: 'var(--dsw-radius-sm)', background: 'var(--dsw-alias-interactive-bg-hover)' };
          const sSegBtn = (active) => ({ padding: '3px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', background: active ? 'var(--dsw-alias-state-business-primary)' : 'transparent', color: active ? '#fff' : 'var(--dsw-alias-label-secondary)' });
          const sToggle = (on) => ({ width: 34, height: 18, borderRadius: 9, border: 'none', cursor: 'pointer', background: on ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-interactive-bg-hover)', position: 'relative', padding: 0, flexShrink: 0 });
          const sKnob = (on) => ({ position: 'absolute', top: 2, left: on ? 18 : 2, width: 14, height: 14, borderRadius: 7, background: '#fff', transition: 'left 120ms ease' });
          return h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 } },
            h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', fontFamily: 'inherit' } }, '改完立即生效（localStorage 保存）'),
            h('div', { style: sRow },
              h('span', { style: sLabel }, '默认投递方式'),
              h('div', { style: sSeg },
                h('button', { onClick: () => settingsStore.set({ defaultMode: 'queue' }), style: sSegBtn(settings.defaultMode === 'queue') }, '攒着'),
                h('button', { onClick: () => settingsStore.set({ defaultMode: 'steer' }), style: sSegBtn(settings.defaultMode === 'steer') }, '立即插话'),
              ),
            ),
            h('div', { style: sRow },
              h('span', { style: sLabel }, '停顿点自动投递'),
              h('button', { onClick: () => settingsStore.set({ autoFlush: !settings.autoFlush }), style: sToggle(settings.autoFlush), 'aria-pressed': !!settings.autoFlush },
                h('span', { style: sKnob(settings.autoFlush) }),
              ),
            ),
            h('div', { style: sRow },
              h('span', { style: sLabel }, '单次合并上限'),
              h('div', { style: sSeg },
                h('button', { onClick: () => settingsStore.set({ maxMerge: 2 }), style: sSegBtn(settings.maxMerge === 2) }, '2'),
                h('button', { onClick: () => settingsStore.set({ maxMerge: 3 }), style: sSegBtn(settings.maxMerge === 3) }, '3'),
                h('button', { onClick: () => settingsStore.set({ maxMerge: 5 }), style: sSegBtn(settings.maxMerge === 5) }, '5'),
              ),
            ),
            h('div', { style: sRow },
              h('span', { style: sLabel }, '旁问档 3（开子会话）'),
              h('button', { onClick: () => settingsStore.set({ allowTier3: !settings.allowTier3 }), style: sToggle(settings.allowTier3), 'aria-pressed': !!settings.allowTier3 },
                h('span', { style: sKnob(settings.allowTier3) }),
              ),
            ),
            h('div', { style: { marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--dsw-alias-border-l3)', display: 'flex', flexDirection: 'column', gap: 6 } },
              h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', fontFamily: 'inherit' } }, '旁问（档 3）会话会占磁盘。清理会删除宿主的旁问会话日志（需重启 DSH 加载 Host 插件后可用）。'),
              h('button', { onClick: onClear, disabled: clearBusy, style: { ...smallBtnStyle, alignSelf: 'flex-start', opacity: clearBusy ? 0.6 : 1 } }, clearBusy ? '清理中…' : '清理旁问缓存'),
              clearMsg != null && h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', fontFamily: 'inherit', wordBreak: 'break-word' } }, clearMsg),
            ),
            h('button', { onClick: () => settingsStore.reset(), style: { ...smallBtnStyle, alignSelf: 'flex-start', marginTop: 6 } }, '恢复默认'),
          );
        }

        // ---- 注册 ----
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          title: () => '旁注',
          guide: [{
            order: 10,
            title: () => '旁注',
            description: () => '不打断的收件箱 + 项目备忘',
          }],
        }), 'side-notes: tab type');

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
        }, SafePanel)), 'side-notes: tab body');

        ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'side-notes-dock',
          order: 5,
        }, DockBadge)), 'side-notes: composer dock');

        ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'side-notes-memo',
          order: 10,
        }, FooterAction)), 'side-notes: footer action');

        ctx.effect(() => ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions',
          id: 'side-notes-annotate',
          order: 20,
          inject: (sessionId) => ({ sessionId }),
        }, AnnotateAction)), 'side-notes: annotate action');

        // Alt+Enter 打开旁注 tab（可能被宿主占用，作为便捷入口，非关键）
        function onKeyDown(e) {
          if (e.altKey && e.key === 'Enter') {
            try { ctx.sidebarRight.openTab(TAB_KIND); } catch (err) { /* 无会话或未注册时忽略 */ }
          }
        }
        window.addEventListener('keydown', onKeyDown);
        ctx.effect(() => () => window.removeEventListener('keydown', onKeyDown));
      },
    };
  },
});
