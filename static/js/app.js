        (function() {
            const html = document.documentElement;
            const canvasWrap = document.getElementById('canvasWrap');
            const canvasGridLayer = document.getElementById('canvasGridLayer');
            const canvasContent = document.getElementById('canvasContent');
            const linkLayer = document.getElementById('linkLayer');
            const linkLabels = document.getElementById('linkLabels');
            const miniMapSvg = document.getElementById('miniMapSvg');
            const zoomLabel = document.getElementById('zoomLabel');
            const statNodes = document.getElementById('statNodes');
            const statLinks = document.getElementById('statLinks');
            const statTheme = document.getElementById('statTheme');
            const progressLabel = document.getElementById('progressLabel');
            const progressFill = document.getElementById('progressFill');
            const nodeTemplate = document.getElementById('nodeTemplate');
            const themeBtn = document.getElementById('themeBtn');
            const themeIcon = document.getElementById('themeIcon');
            const addRootBtn = document.getElementById('addRootBtn');
            const centerBtn = document.getElementById('centerBtn');
            const templatesBtn = document.getElementById('templatesBtn');
            const templatesPanel = document.getElementById('templatesPanel');
            const templatesList = document.getElementById('templatesList');
            const templateCount = document.getElementById('templateCount');
            const templateNameInput = document.getElementById('templateNameInput');
            const newTemplateBtn = document.getElementById('newTemplateBtn');
            const currentTemplateName = document.getElementById('currentTemplateName');
            const loginScreen = document.getElementById('loginScreen');
            const loginForm = document.getElementById('loginForm');
            const loginUsername = document.getElementById('loginUsername');
            const loginPassword = document.getElementById('loginPassword');
            const loginError = document.getElementById('loginError');
            const loginSubmit = document.getElementById('loginSubmit');
            const logoutBtn = document.getElementById('logoutBtn');
            const userRoleLabel = document.getElementById('userRoleLabel');

            const DEFAULT_NODE_WIDTH = 320;
            const DEFAULT_NODE_HEIGHT = 200;
            const MIN_NODE_WIDTH = 220;
            const MIN_NODE_HEIGHT = 150;
            const DRAG_THRESHOLD = 4;
            const SUBSTEP_NODE_WIDTH = 320;
            const SUBSTEP_NODE_HEIGHT = 200;
            const SUBSTEP_GAP_X = 60;
            const SUBSTEP_GAP_Y = 30;

            const state = {
                theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
                panX: window.innerWidth * 0.26,
                panY: window.innerHeight * 0.24,
                scale: 1,
                nodes: [],
                links: [],
                selectedNodeId: null,
                selectedLinkId: null,
                potentialDrag: null,
                drag: null,
                pan: null,
                resize: null,
                previewLink: null,
                uid: 0,
                clipboard: null,
                undoStack: [],
                redoStack: [],
                currentId: null,
                currentName: '',
                version: null,
                templates: [],
                readOnly: false,
            };

            let saveTimer = null;
            let saveChain = Promise.resolve();
            let pendingDeleteId = null;
            let pendingDeleteTimer = null;
            let editingField = null;
            let authToken = localStorage.getItem('timeline_token') || null;
            let currentUser = null;

            async function api(path, options = {}) {
                const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
                if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
                const res = await fetch(path, { ...options, headers });
                if (res.status === 401) {
                    authToken = null;
                    currentUser = null;
                    localStorage.removeItem('timeline_token');
                    showLogin('Сессия истекла, войдите снова');
                    throw new Error('401 Unauthorized');
                }
                if (!res.ok) {
                    const err = new Error(`${res.status} ${res.statusText}`);
                    err.status = res.status;
                    throw err;
                }
                return res.json();
            }

            function showLogin(message = '') {
                loginError.textContent = message;
                loginScreen.classList.remove('is-hidden');
            }

            function hideLogin() {
                loginScreen.classList.add('is-hidden');
            }

            function applyRole() {
                const isViewer = currentUser?.role === 'observer';
                state.readOnly = isViewer;
                document.body.classList.toggle('is-viewer', isViewer);
                userRoleLabel.textContent = isViewer ? 'Наблюдатель' : 'Администратор';
                templateNameInput.disabled = isViewer;
                requestRender();
            }

            function formatTemplateDate(value) {
                if (!value) return '';
                const d = new Date(value);
                if (isNaN(d)) return '';
                return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) + ' ' +
                    d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
            }

            function scheduleSave() {
                if (state.readOnly || state.currentId == null) return;
                clearTimeout(saveTimer);
                saveTimer = setTimeout(enqueueSave, 600);
            }

            function flushSave() {
                if (state.readOnly || state.currentId == null || !saveTimer) return;
                clearTimeout(saveTimer);
                saveTimer = null;
                enqueueSave();
            }

            function buildSaveBody() {
                const name = (templateNameInput.value.trim() || state.currentName || 'Без названия').trim();
                const payload = {
                    nodes: state.nodes.map(n => ({ ...n })),
                    links: state.links.map(l => ({ ...l })),
                    uid: state.uid,
                    viewport: { panX: state.panX, panY: state.panY, scale: state.scale },
                };
                return { name, payload, base_version: state.version };
            }

            async function doSave(body) {
                if (state.readOnly || state.currentId == null) return;
                const saveId = state.currentId;
                try {
                    const saved = await api(`/api/roadmaps/${saveId}`, {
                        method: 'PUT',
                        body: JSON.stringify(body),
                    });
                    if (state.currentId !== saveId) return;
                    state.version = saved.version;
                    if (body.name !== state.currentName) {
                        state.currentName = body.name;
                        await refreshTemplates();
                    }
                } catch (e) {
                    if (state.currentId !== saveId) return;
                    if (e.status === 409) {
                        showToast('⚠️ Схема изменена в другом окне, обновлено');
                        await switchTemplate(saveId);
                        return;
                    }
                    showToast('⚠️ Не удалось сохранить шаблон');
                }
            }

            function enqueueSave() {
                const body = buildSaveBody();
                saveChain = saveChain.then(() => doSave(body)).catch(() => {});
                return saveChain;
            }

            async function saveCurrent() {
                if (state.readOnly || state.currentId == null) return;
                return enqueueSave();
            }

            async function refreshTemplates() {
                state.templates = await api('/api/roadmaps');
                renderTemplatesList();
            }

            function renderTemplatesList() {
                templateCount.textContent = String(state.templates.length);
                const active = state.templates.find(t => t.id === state.currentId);
                currentTemplateName.textContent = active ? active.name : (state.currentName || '—');
                templatesList.innerHTML = '';
                state.templates.forEach(t => {
                    const li = document.createElement('li');
                    li.className = 'template-item' + (t.id === state.currentId ? ' is-active' : '');
                    li.dataset.id = t.id;

                    const pct = t.node_count ? Math.round((t.done_count || 0) / t.node_count * 100) : 0;
                    const ringC = 2 * Math.PI * 10.5;
                    const prog = document.createElement('span');
                    prog.className = 'tm-progress' + (pct >= 100 ? ' is-complete' : '');
                    prog.title = t.node_count ? `Выполнено ${t.done_count || 0} из ${t.node_count} (${pct}%)` : 'Нет этапов';
                    prog.innerHTML = `<svg viewBox="0 0 26 26" aria-hidden="true"><circle class="tm-progress-bg" cx="13" cy="13" r="10.5"></circle><circle class="tm-progress-val" cx="13" cy="13" r="10.5" stroke-dasharray="${ringC}" stroke-dashoffset="${ringC * (1 - pct / 100)}"></circle></svg>`;

                    const name = document.createElement('span');
                    name.className = 'template-item-name';
                    name.textContent = t.name;
                    name.title = t.name;

                    const date = document.createElement('span');
                    date.className = 'template-item-date';
                    date.textContent = formatTemplateDate(t.updated_at);

                    const del = document.createElement('button');
                    del.className = 'template-delete';
                    del.type = 'button';
                    del.title = 'Удалить шаблон';
                    del.setAttribute('aria-label', 'Удалить шаблон');
                    del.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7H20M9 7V5.8C9 5.358 9.358 5 9.8 5H14.2C14.642 5 15 5.358 15 5.8V7M7.5 7V18.2C7.5 18.642 7.858 19 8.3 19H15.7C16.142 19 16.5 18.642 16.5 18.2V7M10 10.5V15.5M14 10.5V15.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

                    li.append(prog, name, date, del);
                    li.addEventListener('click', e => {
                        if (e.target.closest('.template-delete')) return;
                        switchTemplate(t.id);
                    });
                    del.addEventListener('click', e => {
                        e.stopPropagation();
                        deleteTemplate(t.id, del);
                    });
                    templatesList.appendChild(li);
                });
            }

            async function switchTemplate(id) {
                if (state.currentId != null && state.currentId !== id) {
                    flushSave();
                }
                const data = await api(`/api/roadmaps/${id}`);
                state.currentId = data.id;
                state.currentName = data.name;
                state.version = data.version;
                templateNameInput.value = data.name;
                const payload = data.payload || {};
                state.nodes = (payload.nodes || []).map(n => ({
                    ...n,
                    done: !!n.done,
                    width: n.width || DEFAULT_NODE_WIDTH,
                    height: n.height || DEFAULT_NODE_HEIGHT,
                    substeps: copySubsteps(n.substeps),
                }));
                state.links = (payload.links || []).map(l => ({ ...l }));
                state.uid = payload.uid || state.nodes.length;
                if (payload.viewport && typeof payload.viewport.panX === 'number') {
                    state.panX = payload.viewport.panX;
                    state.panY = payload.viewport.panY;
                    state.scale = payload.viewport.scale || 1;
                }
                state.selectedNodeId = null;
                state.previewLink = null;
                state.clipboard = null;
                state.undoStack = [];
                state.redoStack = [];
                renderTemplatesList();
                requestRender();
            }

            async function createTemplate() {
                const count = state.templates.length + 1;
                const name = `Шаблон ${count}`;
                const payload = {
                    nodes: [],
                    links: [],
                    uid: 0,
                    viewport: { panX: 0, panY: 0, scale: 1 },
                };
                const created = await api('/api/roadmaps', {
                    method: 'POST',
                    body: JSON.stringify({ name, payload }),
                });
                await refreshTemplates();
                await switchTemplate(created.id);
                showToast('✅ Новый шаблон создан');
            }

            async function deleteTemplate(id, btn) {
                if (pendingDeleteId !== id) {
                    pendingDeleteId = id;
                    clearTimeout(pendingDeleteTimer);
                    pendingDeleteTimer = setTimeout(() => {
                        pendingDeleteId = null;
                        templatesList.querySelectorAll('.template-delete.is-armed').forEach(b => b.classList.remove('is-armed'));
                    }, 3000);
                    btn.classList.add('is-armed');
                    showToast('⚠️ Удалить шаблон? Нажмите на корзину ещё раз');
                    return;
                }
                pendingDeleteId = null;
                clearTimeout(pendingDeleteTimer);
                if (id === state.currentId) {
                    clearTimeout(saveTimer);
                    saveTimer = null;
                }
                await api(`/api/roadmaps/${id}`, { method: 'DELETE' });
                await refreshTemplates();
                if (id === state.currentId) {
                    const next = state.templates[0];
                    if (next) {
                        await switchTemplate(next.id);
                    } else {
                        state.currentId = null;
                        state.currentName = '';
                        state.nodes = [];
                        state.links = [];
                        state.undoStack = [];
                        state.redoStack = [];
                        requestRender();
                        await createTemplate();
                    }
                }
                showToast('🗑️ Шаблон удалён');
            }

            function openTemplatesPanel(open) {
                templatesPanel.classList.toggle('is-open', open);
                templatesBtn.setAttribute('aria-expanded', String(open));
                if (open) refreshTemplates();
            }

            const copySubsteps = (steps) => (steps || []).map(s => ({
                id: s.id,
                title: s.title || '',
                note: s.note || '',
                done: !!s.done,
                x: typeof s.x === 'number' ? s.x : undefined,
                y: typeof s.y === 'number' ? s.y : undefined,
            }));
            const copyNode = (n) => ({ ...n, substeps: copySubsteps(n.substeps) });
            const snapshotNodes = () => state.nodes.map(copyNode);

            const pushUndo = () => {
                if (state.readOnly) return;
                const snapshot = {
                    nodes: snapshotNodes(),
                    links: state.links.map(l => ({ ...l })),
                    uid: state.uid,
                };
                state.undoStack.push(snapshot);
                if (state.undoStack.length > 60) state.undoStack.shift();
                state.redoStack = [];
                scheduleSave();
            };

            const undo = () => {
                if (state.readOnly || !state.undoStack.length) return false;
                const current = {
                    nodes: snapshotNodes(),
                    links: state.links.map(l => ({ ...l })),
                    uid: state.uid,
                };
                state.redoStack.push(current);
                const snapshot = state.undoStack.pop();
                state.nodes = snapshot.nodes;
                state.links = snapshot.links;
                state.uid = snapshot.uid;
                if (state.selectedNodeId && !state.nodes.find(n => n.id === state.selectedNodeId)) {
                    state.selectedNodeId = state.nodes[0]?.id || null;
                }
                if (state.selectedLinkId && !state.links.find(l => l.id === state.selectedLinkId)) {
                    state.selectedLinkId = null;
                }
                requestRender();
                scheduleSave();
                return true;
            };

            const redo = () => {
                if (state.readOnly || !state.redoStack.length) return false;
                const current = {
                    nodes: snapshotNodes(),
                    links: state.links.map(l => ({ ...l })),
                    uid: state.uid,
                };
                state.undoStack.push(current);
                const snapshot = state.redoStack.pop();
                state.nodes = snapshot.nodes;
                state.links = snapshot.links;
                state.uid = snapshot.uid;
                if (state.selectedNodeId && !state.nodes.find(n => n.id === state.selectedNodeId)) {
                    state.selectedNodeId = state.nodes[0]?.id || null;
                }
                if (state.selectedLinkId && !state.links.find(l => l.id === state.selectedLinkId)) {
                    state.selectedLinkId = null;
                }
                requestRender();
                scheduleSave();
                return true;
            };

            const createId = () => `node-${++state.uid}`;

            function showToast(message) {
                const existing = document.querySelector('.toast');
                if (existing) existing.remove();
                const toast = document.createElement('div');
                toast.className = 'toast';
                toast.textContent = message;
                document.body.appendChild(toast);
                toast.addEventListener('animationend', (e) => {
                    if (e.animationName === 'toastOut') toast.remove();
                });
            }

            function setTheme(theme) {
                state.theme = theme;
                html.setAttribute('data-theme', theme);
                themeBtn.setAttribute('aria-label',
                    theme === 'dark' ? 'Переключить на светлую тему' : 'Переключить на тёмную тему');
                themeIcon.innerHTML = theme === 'dark' ?
                    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' :
                    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="4.5" stroke="currentColor" stroke-width="2"/><path d="M12 2.5V5M12 19V21.5M4.9 4.9L6.7 6.7M17.3 17.3L19.1 19.1M2.5 12H5M19 12H21.5M4.9 19.1L6.7 17.3M17.3 6.7L19.1 4.9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
                statTheme.textContent = theme === 'dark' ? 'Dark' : 'Light';
                requestRender();
            }

            function toggleTheme() { setTheme(state.theme === 'dark' ? 'light' : 'dark'); }

            function updateGridBackground() {
                const minor = 40 * state.scale;
                const major = 200 * state.scale;
                const pos = `${state.panX}px ${state.panY}px`;
                canvasGridLayer.style.backgroundSize =
                    `${minor}px ${minor}px, ${minor}px ${minor}px, ${major}px ${major}px, ${major}px ${major}px`;
                canvasGridLayer.style.backgroundPosition = `${pos}, ${pos}, ${pos}, ${pos}`;
            }

            function updateTransforms() {
                const transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.scale})`;
                canvasContent.style.transform = transform;
                linkLayer.style.transform = transform;
                linkLabels.style.transform = transform;
                updateGridBackground();
                zoomLabel.textContent = `${Math.round(state.scale * 100)}%`;
            }

            function screenToWorld(x, y) {
                return { x: (x - state.panX) / state.scale, y: (y - state.panY) / state.scale };
            }

            function getNodeById(id) { return state.nodes.find(node => node.id === id); }

            function nodeTypeLabel(node) { return node.type === 'Goal' ? 'Цель' : 'Этап'; }

            function getNodeCenter(node) {
                return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
            }

            function sidePoint(node, side) {
                const c = getNodeCenter(node);
                switch (side) {
                    case 'top': return { x: c.x, y: node.y };
                    case 'bottom': return { x: c.x, y: node.y + node.height };
                    case 'left': return { x: node.x, y: c.y };
                    case 'right': return { x: node.x + node.width, y: c.y };
                }
            }

            function sideNormal(side) {
                switch (side) {
                    case 'top': return { x: 0, y: -1 };
                    case 'bottom': return { x: 0, y: 1 };
                    case 'left': return { x: -1, y: 0 };
                    case 'right': return { x: 1, y: 0 };
                }
            }

            function pickSides(fromNode, toNode) {
                const fx1 = fromNode.x, fy1 = fromNode.y;
                const fx2 = fromNode.x + fromNode.width, fy2 = fromNode.y + fromNode.height;
                const tx1 = toNode.x, ty1 = toNode.y;
                const tx2 = toNode.x + toNode.width, ty2 = toNode.y + toNode.height;
                const hOverlap = Math.min(fx2, tx2) - Math.max(fx1, tx1);
                const vOverlap = Math.min(fy2, ty2) - Math.max(fy1, ty1);
                const fromCenter = getNodeCenter(fromNode);
                const toCenter = getNodeCenter(toNode);
                const dx = toCenter.x - fromCenter.x;
                const dy = toCenter.y - fromCenter.y;

                let fromSide, toSide;
                if (vOverlap > 0) {
                    fromSide = dx >= 0 ? 'right' : 'left';
                    toSide = dx >= 0 ? 'left' : 'right';
                } else if (hOverlap > 0) {
                    fromSide = dy >= 0 ? 'bottom' : 'top';
                    toSide = dy >= 0 ? 'top' : 'bottom';
                } else if (Math.abs(dx) > Math.abs(dy)) {
                    fromSide = dx >= 0 ? 'right' : 'left';
                    toSide = dx >= 0 ? 'left' : 'right';
                } else {
                    fromSide = dy >= 0 ? 'bottom' : 'top';
                    toSide = dy >= 0 ? 'top' : 'bottom';
                }
                return { fromSide, toSide };
            }

            function pickSideToward(center, node, target) {
                const dx = target.x - center.x;
                const dy = target.y - center.y;
                const tRight = dx > 0 ? (node.width / 2) / dx : Infinity;
                const tLeft = dx < 0 ? (-node.width / 2) / dx : Infinity;
                const tBottom = dy > 0 ? (node.height / 2) / dy : Infinity;
                const tTop = dy < 0 ? (-node.height / 2) / dy : Infinity;
                const minT = Math.min(tRight, tLeft, tBottom, tTop);
                if (minT === tRight) return 'right';
                if (minT === tLeft) return 'left';
                if (minT === tBottom) return 'bottom';
                return 'top';
            }

            function curvePath(start, end, n1, n2, inset, bend) {
                const dist = Math.hypot(end.x - start.x, end.y - start.y);
                if (bend === undefined) bend = Math.max(60, Math.min(220, dist * 0.45));
                const c1 = { x: start.x + n1.x * bend, y: start.y + n1.y * bend };
                const endAdjusted = n2 ? { x: end.x - n2.x * inset, y: end.y - n2.y * inset } : end;
                const c2 = n2
                    ? { x: endAdjusted.x + n2.x * bend, y: endAdjusted.y + n2.y * bend }
                    : { x: end.x - n1.x * bend, y: end.y - n1.y * bend };
                return {
                    d: `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${endAdjusted.x} ${endAdjusted.y}`,
                    midX: (start.x + endAdjusted.x) / 2,
                    midY: (start.y + endAdjusted.y) / 2,
                };
            }

            function buildCurve(fromNode, toNode) {
                const { fromSide, toSide } = pickSides(fromNode, toNode);
                const start = sidePoint(fromNode, fromSide);
                const end = sidePoint(toNode, toSide);
                return curvePath(start, end, sideNormal(fromSide), sideNormal(toSide), 6);
            }

            function fitTitle(el) {
                el.style.height = 'auto';
                el.style.height = `${el.scrollHeight}px`;
            }

            function renderNodes() {
                canvasContent.innerHTML = '';
                const fragment = document.createDocumentFragment();
                state.nodes.forEach(node => {
                    const el = nodeTemplate.content.firstElementChild.cloneNode(true);
                    el.dataset.id = node.id;
                    el.style.left = `${node.x}px`;
                    el.style.top = `${node.y}px`;
                    el.style.width = `${node.width}px`;
                    el.style.minHeight = `${node.height}px`;
                    el.classList.toggle('is-selected', node.id === state.selectedNodeId);
                    el.classList.toggle('is-done', !!node.done);

                    const typeEl = el.querySelector('.node-type');
                    typeEl.textContent = nodeTypeLabel(node);
                    if (node.type === 'Goal') {
                        typeEl.style.color = '#59c690';
                        typeEl.style.background = 'rgba(89,198,144,0.15)';
                    } else {
                        typeEl.style.color = '';
                        typeEl.style.background = '';
                    }

                    el.querySelector('.node-title').value = node.title;
                    el.querySelector('.node-text').value = node.note;
                    el.querySelector('.node-date').value = node.due;
                    el.querySelector('.node-duration').value = node.duration;

                    const substepsBox = el.querySelector('.node-substeps');
                    const isGoal = node.type === 'Goal';
                    substepsBox.style.display = isGoal ? 'none' : '';
                    const steps = node.substeps || [];
                    const doneSteps = steps.filter(s => s.done).length;
                    const stepsTitle = el.querySelector('.node-substeps-title');
                    stepsTitle.textContent = steps.length ? `Подэтапы ${doneSteps}/${steps.length}` : 'Подэтапы';
                    const isExpanded = !!node.substepsExpanded;
                    const expandBtn = el.querySelector('.substep-expand');
                    expandBtn.classList.toggle('is-active', isExpanded);
                    expandBtn.title = isExpanded ? 'Свернуть подэтапы внутрь' : 'Развернуть подэтапы на карту';
                    expandBtn.setAttribute('aria-label', expandBtn.title);
                    if (state.readOnly) expandBtn.disabled = true;
                    const stepsList = el.querySelector('.node-substeps-list');
                    stepsList.innerHTML = '';
                    stepsList.style.display = isExpanded ? 'none' : '';
                    if (!isExpanded) {
                        steps.forEach(step => {
                            const li = document.createElement('li');
                            li.className = 'substep' + (step.done ? ' is-done' : '');
                            li.dataset.substep = step.id;

                            const toggle = document.createElement('button');
                            toggle.type = 'button';
                            toggle.className = 'substep-toggle';
                            toggle.setAttribute('aria-label', step.done ? 'Снять отметку' : 'Отметить выполненным');
                            toggle.title = step.done ? 'Снять отметку' : 'Отметить выполненным';
                            toggle.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12.5L9.5 17L19 7" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
                            if (state.readOnly) toggle.disabled = true;

                            const input = document.createElement('input');
                            input.type = 'text';
                            input.className = 'substep-title';
                            input.value = step.title;
                            input.placeholder = 'Название подэтапа';
                            input.spellcheck = false;
                            if (state.readOnly) input.readOnly = true;

                            const del = document.createElement('button');
                            del.type = 'button';
                            del.className = 'substep-delete';
                            del.title = 'Удалить подэтап';
                            del.setAttribute('aria-label', 'Удалить подэтап');
                            del.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6L18 18M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
                            if (state.readOnly) del.disabled = true;

                            li.append(toggle, input, del);
                            stepsList.appendChild(li);
                        });
                    }

                    if (state.readOnly) {
                        el.querySelectorAll('.node-title, .node-text, .node-date, .node-duration').forEach(f => f.readOnly = true);
                    }

                    const statusEl = el.querySelector('.node-status');
                    statusEl.textContent = node.done ? 'Выполнено' : 'В работе';
                    statusEl.classList.toggle('is-done', !!node.done);

                    el.querySelector('.complete-btn').classList.toggle('is-on', !!node.done);

                    const connectBtn = el.querySelector('.connect-btn');
                    if (state.previewLink && state.previewLink.fromId === node.id) {
                        connectBtn.classList.add('is-active');
                    }
                    if (state.previewLink && state.previewLink.fromId && state.previewLink.fromId !== node.id && canLinkToGoal(node.id)) {
                        el.classList.add('is-drop-target');
                    }

                    fragment.appendChild(el);
                });
                canvasContent.appendChild(fragment);
                canvasContent.querySelectorAll('.node-title').forEach(fitTitle);
            }

            function renderLinks() {
                linkLayer.querySelectorAll('path').forEach(p => {
                    if (!p.closest('defs')) p.remove();
                });
                linkLabels.innerHTML = '';

                state.links.forEach(link => {
                    const fromNode = getNodeById(link.from);
                    const toNode = getNodeById(link.to);
                    if (!fromNode || !toNode) return;

                    const curve = buildCurve(fromNode, toNode);
                    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                    hit.setAttribute('d', curve.d);
                    hit.setAttribute('class', 'link-hit');
                    hit.dataset.link = link.id;
                    linkLayer.appendChild(hit);

                    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                    path.setAttribute('d', curve.d);
                    path.setAttribute('class', 'link-path' + (link.id === state.selectedLinkId ? ' is-selected' : ''));
                    path.dataset.link = link.id;
                    linkLayer.appendChild(path);

                    const label = document.createElement('div');
                    label.className = 'link-label' + (link.id === state.selectedLinkId ? ' is-selected' : '');
                    label.dataset.linkLabel = link.id;
                    label.style.left = `${curve.midX}px`;
                    label.style.top = `${curve.midY}px`;
                    label.textContent = link.label || 'без срока';
                    linkLabels.appendChild(label);
                });

                if (state.previewLink?.fromId && state.previewLink.pointer) {
                    const fromNode = getNodeById(state.previewLink.fromId);
                    if (fromNode) {
                        const pointerWorld = screenToWorld(state.previewLink.pointer.x, state.previewLink.pointer.y);
                        const fromCenter = getNodeCenter(fromNode);
                        const startSide = pickSideToward(fromCenter, fromNode, pointerWorld);
                        const start = sidePoint(fromNode, startSide);
                        const endNode = state.previewLink.targetId ? getNodeById(state.previewLink.targetId) : null;
                        let endPoint, n2 = null;
                        if (endNode) {
                            const ec = getNodeCenter(endNode);
                            const endSide = pickSideToward(ec, endNode, pointerWorld);
                            endPoint = sidePoint(endNode, endSide);
                            n2 = sideNormal(endSide);
                        } else {
                            endPoint = pointerWorld;
                        }
                        const curve = curvePath(start, endPoint, sideNormal(startSide), n2, 6);
                        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                        path.setAttribute('d', curve.d);
                        path.setAttribute('class', 'link-path is-preview' + (endNode ? ' is-snapped' : ''));
                        linkLayer.appendChild(path);
                    }
                }
            }

            function substepLayout(node) {
                const steps = node.substeps || [];
                const count = steps.length;
                const totalH = count * SUBSTEP_NODE_HEIGHT + (count - 1) * SUBSTEP_GAP_Y;
                const baseX = node.x + node.width + SUBSTEP_GAP_X;
                const baseY = node.y + node.height / 2 - totalH / 2;
                const cards = steps.map((s, i) => ({
                    x: typeof s.x === 'number' ? s.x : baseX,
                    y: typeof s.y === 'number' ? s.y : baseY + i * (SUBSTEP_NODE_HEIGHT + SUBSTEP_GAP_Y),
                    w: SUBSTEP_NODE_WIDTH,
                    h: SUBSTEP_NODE_HEIGHT,
                }));
                return { cards, fromX: node.x + node.width, fromY: node.y + node.height / 2 };
            }

            function buildSubstepCard(step, parentId) {
                const card = document.createElement('article');
                card.className = 'substep-node' + (step.done ? ' is-done' : '');
                card.dataset.substepCard = 'true';
                card.dataset.parent = parentId;
                card.dataset.substep = step.id;

                const header = document.createElement('div');
                header.className = 'substep-node-header';

                const headerMain = document.createElement('div');
                headerMain.className = 'substep-node-header-main';

                const typeEl = document.createElement('span');
                typeEl.className = 'substep-node-type';
                typeEl.textContent = 'Подэтап';

                const title = document.createElement('textarea');
                title.rows = 1;
                title.className = 'node-title substep-node-title';
                title.value = step.title;
                title.placeholder = 'Название подэтапа';
                title.spellcheck = false;
                if (state.readOnly) title.readOnly = true;

                headerMain.append(typeEl, title);

                const actions = document.createElement('div');
                actions.className = 'substep-node-actions';

                const complete = document.createElement('button');
                complete.type = 'button';
                complete.className = 'icon-btn complete-btn';
                complete.classList.toggle('is-on', !!step.done);
                complete.title = step.done ? 'Снять отметку' : 'Отметить выполненным';
                complete.setAttribute('aria-label', complete.title);
                complete.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12.5L9.5 17L19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
                if (state.readOnly) complete.disabled = true;

                const del = document.createElement('button');
                del.type = 'button';
                del.className = 'icon-btn delete-btn';
                del.title = 'Удалить подэтап';
                del.setAttribute('aria-label', del.title);
                del.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7H20M9 7V5.8C9 5.358 9.358 5 9.8 5H14.2C14.642 5 15 5.358 15 5.8V7M7.5 7V18.2C7.5 18.642 7.858 19 8.3 19H15.7C16.142 19 16.5 18.642 16.5 18.2V7M10 10.5V15.5M14 10.5V15.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
                if (state.readOnly) del.disabled = true;

                actions.append(complete, del);
                header.append(headerMain, actions);

                const note = document.createElement('textarea');
                note.className = 'node-text substep-node-note';
                note.value = step.note || '';
                note.placeholder = 'Комментарий по подэтапу';
                note.spellcheck = false;
                if (state.readOnly) note.readOnly = true;

                const footer = document.createElement('div');
                footer.className = 'substep-node-footer';

                const status = document.createElement('div');
                status.className = 'node-status substep-node-status';
                status.classList.toggle('is-done', !!step.done);
                status.textContent = step.done ? 'Выполнено' : 'В работе';

                footer.appendChild(status);
                card.append(header, note, footer);
                return card;
            }

            function renderSubstepCards() {
                canvasContent.querySelectorAll('[data-substep-card]').forEach(el => el.remove());
                state.nodes.forEach(node => {
                    const steps = node.substeps || [];
                    if (node.type === 'Goal' || !steps.length || !node.substepsExpanded) return;
                    const layout = substepLayout(node);
                    steps.forEach((step, i) => {
                        const card = buildSubstepCard(step, node.id);
                        card.style.left = `${layout.cards[i].x}px`;
                        card.style.top = `${layout.cards[i].y}px`;
                        card.style.width = `${layout.cards[i].w}px`;
                        card.style.height = `${layout.cards[i].h}px`;
                        canvasContent.appendChild(card);
                        const titleEl = card.querySelector('.node-title');
                        if (titleEl) fitTitle(titleEl);
                    });
                });
            }

            function renderSubstepLinks() {
                const svgNS = 'http://www.w3.org/2000/svg';
                state.nodes.forEach(node => {
                    const steps = node.substeps || [];
                    if (node.type === 'Goal' || !steps.length || !node.substepsExpanded) return;
                    const layout = substepLayout(node);
                    steps.forEach((step, i) => {
                        const card = layout.cards[i];
                        if (!card) return;
                        const cy = card.y + card.h / 2;
                        const dx = Math.max(20, Math.abs(card.x - layout.fromX) * 0.5);
                        const path = document.createElementNS(svgNS, 'path');
                        path.setAttribute('d',
                            `M ${layout.fromX} ${layout.fromY} C ${layout.fromX + dx} ${layout.fromY}, ${card.x - dx} ${cy}, ${card.x} ${cy}`);
                        path.setAttribute('class', 'link-path is-substep');
                        path.dataset.parent = node.id;
                        linkLayer.appendChild(path);
                    });
                });
            }

            function refreshSubsteps(id) {
                const node = getNodeById(id);
                if (!node) return;
                const layout = substepLayout(node);
                const cards = canvasContent.querySelectorAll(`[data-substep-card][data-parent="${id}"]`);
                cards.forEach((card, i) => {
                    if (!layout.cards[i]) return;
                    card.style.left = `${layout.cards[i].x}px`;
                    card.style.top = `${layout.cards[i].y}px`;
                });
                linkLayer.querySelectorAll(`path[data-parent="${id}"].is-substep`).forEach((path, i) => {
                    const card = layout.cards[i];
                    if (!card) return;
                    const cy = card.y + card.h / 2;
                    const dx = Math.max(20, Math.abs(card.x - layout.fromX) * 0.5);
                    path.setAttribute('d',
                        `M ${layout.fromX} ${layout.fromY} C ${layout.fromX + dx} ${layout.fromY}, ${card.x - dx} ${cy}, ${card.x} ${cy}`);
                });
            }

            function renderMiniMap() {
                miniMapSvg.innerHTML = '';
                if (!state.nodes.length) return;
                const minX = Math.min(...state.nodes.map(n => n.x));
                const minY = Math.min(...state.nodes.map(n => n.y));
                const maxX = Math.max(...state.nodes.map(n => n.x + n.width));
                const maxY = Math.max(...state.nodes.map(n => n.y + n.height));
                const width = maxX - minX || 1;
                const height = maxY - minY || 1;
                const sc = Math.min(280 / width, 120 / height);
                const offsetX = 20 - minX * sc + (280 - width * sc) / 2;
                const offsetY = 15 - minY * sc + (120 - height * sc) / 2;
                const svgNS = 'http://www.w3.org/2000/svg';

                state.links.forEach(link => {
                    const from = getNodeById(link.from);
                    const to = getNodeById(link.to);
                    if (!from || !to) return;
                    const line = document.createElementNS(svgNS, 'path');
                    const { fromSide, toSide } = pickSides(from, to);
                    const start = sidePoint(from, fromSide);
                    const end = sidePoint(to, toSide);
                    const p1 = { x: start.x * sc + offsetX, y: start.y * sc + offsetY };
                    const p2 = { x: end.x * sc + offsetX, y: end.y * sc + offsetY };
                    const n1 = { x: sideNormal(fromSide).x * sc, y: sideNormal(fromSide).y * sc };
                    const n2 = { x: sideNormal(toSide).x * sc, y: sideNormal(toSide).y * sc };
                    const bend = Math.max(60, Math.min(220, Math.hypot(end.x - start.x, end.y - start.y) * 0.45)) * sc;
                    line.setAttribute('d', curvePath(p1, p2, n1, n2, 0, bend).d);
                    line.setAttribute('class', 'mini-link');
                    miniMapSvg.appendChild(line);
                });

                state.nodes.forEach(node => {
                    const rect = document.createElementNS(svgNS, 'rect');
                    rect.setAttribute('x', node.x * sc + offsetX);
                    rect.setAttribute('y', node.y * sc + offsetY);
                    rect.setAttribute('width', node.width * sc);
                    rect.setAttribute('height', node.height * sc);
                    rect.setAttribute('rx', 8);
                    rect.setAttribute('class', 'mini-node' + (node.type === 'Goal' ? ' mini-goal' : '') + (node.done ? ' mini-done' : ''));
                    miniMapSvg.appendChild(rect);
                });

                const viewportTopLeft = screenToWorld(0, 0);
                const viewportBottomRight = screenToWorld(canvasWrap.clientWidth, canvasWrap.clientHeight);
                const fx = viewportTopLeft.x * sc + offsetX;
                const fy = viewportTopLeft.y * sc + offsetY;
                const fw = (viewportBottomRight.x - viewportTopLeft.x) * sc;
                const fh = (viewportBottomRight.y - viewportTopLeft.y) * sc;
                const cx = Math.max(0, Math.min(fx, 320 - 1));
                const cy = Math.max(0, Math.min(fy, 150 - 1));
                const view = document.createElementNS(svgNS, 'rect');
                view.setAttribute('x', cx);
                view.setAttribute('y', cy);
                view.setAttribute('width', Math.max(1, Math.min(320 - cx, fw)));
                view.setAttribute('height', Math.max(1, Math.min(150 - cy, fh)));
                view.setAttribute('rx', 10);
                view.setAttribute('class', 'mini-viewport');
                miniMapSvg.appendChild(view);
            }

            function updateStats() {
                statNodes.textContent = state.nodes.length;
                statLinks.textContent = state.links.length;
                const total = state.nodes.length;
                const done = state.nodes.filter(n => n.done).length;
                const pct = total ? Math.round((done / total) * 100) : 0;
                progressLabel.textContent = total ? `${done}/${total} · ${pct}%` : '—';
                progressFill.style.width = `${pct}%`;
            }

            function requestRender() {
                updateTransforms();
                renderNodes();
                renderLinks();
                renderSubstepLinks();
                renderSubstepCards();
                renderMiniMap();
                updateStats();
            }

            function selectNode(id) {
                state.selectedLinkId = null;
                if (state.selectedNodeId === id) return;
                state.selectedNodeId = id;
                requestRender();
            }

            function selectLink(id) {
                state.selectedNodeId = null;
                state.previewLink = null;
                state.selectedLinkId = state.selectedLinkId === id ? null : id;
                requestRender();
            }

            function removeLink(id) {
                if (state.readOnly || !state.links.some(l => l.id === id)) return;
                pushUndo();
                state.links = state.links.filter(l => l.id !== id);
                if (state.selectedLinkId === id) state.selectedLinkId = null;
                requestRender();
            }

            function toggleDone(nodeId) {
                if (state.readOnly) return;
                const node = getNodeById(nodeId);
                if (!node) return;
                pushUndo();
                node.done = !node.done;
                requestRender();
                showToast(node.done ? '✅ Этап выполнен' : '↩️ Этап снова в работе');
            }

            function syncNodeDoneFromSubsteps(node) {
                const steps = node.substeps || [];
                if (steps.length > 0) {
                    node.done = steps.every(s => s.done);
                }
            }

            function addSubstep(nodeId) {
                if (state.readOnly) return;
                const node = getNodeById(nodeId);
                if (!node || node.type === 'Goal') return;
                pushUndo();
                node.substeps = [...(node.substeps || []), { id: `step-${++state.uid}`, title: '', note: '', done: false }];
                syncNodeDoneFromSubsteps(node);
                requestRender();
            }

            function toggleSubstepsExpanded(nodeId) {
                if (state.readOnly) return;
                const node = getNodeById(nodeId);
                if (!node || node.type === 'Goal') return;
                pushUndo();
                node.substepsExpanded = !node.substepsExpanded;
                if (node.substepsExpanded) {
                    const layout = substepLayout(node);
                    (node.substeps || []).forEach((step, i) => {
                        if (typeof step.x !== 'number') step.x = layout.cards[i].x;
                        if (typeof step.y !== 'number') step.y = layout.cards[i].y;
                    });
                }
                requestRender();
                scheduleSave();
            }

            function toggleSubstep(nodeId, stepId) {
                if (state.readOnly) return;
                const node = getNodeById(nodeId);
                if (!node) return;
                const step = (node.substeps || []).find(s => s.id === stepId);
                if (!step) return;
                pushUndo();
                step.done = !step.done;
                syncNodeDoneFromSubsteps(node);
                requestRender();
                showToast(step.done ? '✅ Подэтап выполнен' : '↩️ Подэтап снова в работе');
            }

            function removeSubstep(nodeId, stepId) {
                if (state.readOnly) return;
                const node = getNodeById(nodeId);
                if (!node) return;
                pushUndo();
                node.substeps = (node.substeps || []).filter(s => s.id !== stepId);
                syncNodeDoneFromSubsteps(node);
                requestRender();
            }

            function deselectAll() {
                if (state.selectedNodeId === null && state.selectedLinkId === null) return;
                state.selectedNodeId = null;
                state.selectedLinkId = null;
                state.previewLink = null;
                requestRender();
            }

            function canLinkToGoal(targetNodeId) {
                const target = getNodeById(targetNodeId);
                if (!target || target.type !== 'Goal') return true;
                const incomingLinks = state.links.filter(l => l.to === targetNodeId);
                return incomingLinks.length === 0;
            }

            function addNode(originNode = null) {
                if (state.readOnly) return null;
                pushUndo();
                const newNode = {
                    id: createId(),
                    x: originNode ? originNode.x + originNode.width + 70 : screenToWorld(window.innerWidth * 0.5, window
                        .innerHeight * 0.45).x,
                    y: originNode ? originNode.y + (Math.random() * 160 - 80) : screenToWorld(window.innerWidth * 0.5, window
                        .innerHeight * 0.45).y,
                    width: DEFAULT_NODE_WIDTH,
                    height: DEFAULT_NODE_HEIGHT,
                    title: originNode ? 'Новый этап' : 'Новая цель',
                    type: originNode ? 'Path' : 'Goal',
                    done: false,
                    note: 'Опиши шаг, условия и критерии перехода.',
                    due: '',
                    duration: originNode ? '2 месяца' : '',
                    substeps: []
                };
                state.nodes.push(newNode);
                if (originNode) {
                    if (!canLinkToGoal(newNode.id)) {
                        state.nodes.pop();
                        state.redoStack = [];
                        showToast('⚠️ К цели (Goal) может вести только одна линия');
                        requestRender();
                        return null;
                    }
                    state.links.push({
                        id: `link-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
                        from: originNode.id,
                        to: newNode.id,
                        label: newNode.duration || '2 месяца'
                    });
                }
                selectNode(newNode.id);
                return newNode;
            }

            function removeNode(id) {
                if (state.readOnly) return;
                pushUndo();
                state.nodes = state.nodes.filter(node => node.id !== id);
                state.links = state.links.filter(link => link.from !== id && link.to !== id);
                if (state.selectedNodeId === id) {
                    state.selectedNodeId = state.nodes[0]?.id || null;
                }
                if (state.selectedLinkId && !state.links.some(l => l.id === state.selectedLinkId)) {
                    state.selectedLinkId = null;
                }
                if (state.previewLink?.fromId === id) {
                    state.previewLink = null;
                }
                requestRender();
            }

            function updateNodeField(nodeId, field, value) {
                if (state.readOnly) return;
                const node = getNodeById(nodeId);
                if (!node) return;
                if (node[field] === value) return;
                pushUndo();
                node[field] = value;
                if (field === 'duration') {
                    const link = state.links.find(item => item.to === nodeId);
                    if (link) link.label = value || 'без срока';
                }
                if (field === 'type') {
                    if (value === 'Goal') {
                        node.substeps = [];
                        node.substepsExpanded = false;
                        const incomingLinks = state.links.filter(l => l.to === nodeId);
                        if (incomingLinks.length > 1) {
                            const toRemove = incomingLinks.slice(1);
                            state.links = state.links.filter(l => !toRemove.includes(l));
                            showToast('⚠️ Лишние входящие связи к Goal удалены');
                        }
                    }
                }
                requestRender();
            }

            function toggleNodeType(nodeId) {
                const node = getNodeById(nodeId);
                if (!node) return;
                const newType = node.type === 'Goal' ? 'Path' : 'Goal';
                if (newType === 'Goal') {
                    const incomingLinks = state.links.filter(l => l.to === nodeId);
                    if (incomingLinks.length > 1) {
                        showToast('⚠️ Нельзя сделать Goal — более одной входящей связи');
                        return;
                    }
                }
                updateNodeField(nodeId, 'type', newType);
            }

            function connectNodes(fromId, toId) {
                if (state.readOnly || !fromId || !toId || fromId === toId) return;
                const exists = state.links.some(link => link.from === fromId && link.to === toId);
                if (exists) {
                    showToast('⚠️ Такая связь уже существует');
                    return;
                }
                if (!canLinkToGoal(toId)) {
                    showToast('⚠️ К цели (Goal) может вести только одна линия');
                    return;
                }
                pushUndo();
                const target = getNodeById(toId);
                state.links.push({
                    id: `link-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
                    from: fromId,
                    to: toId,
                    label: target?.duration || 'новый переход'
                });
                requestRender();
                showToast('✅ Связь создана');
            }

            function centerOnSelection() {
                const node = getNodeById(state.selectedNodeId) || state.nodes[0];
                if (!node) return;
                state.panX = window.innerWidth / 2 - (node.x + node.width / 2) * state.scale;
                state.panY = window.innerHeight / 2 - (node.y + node.height / 2) * state.scale;
                requestRender();
            }

            function zoomAt(clientX, clientY, delta) {
                const oldScale = state.scale;
                const newScale = Math.min(1.75, Math.max(0.4, oldScale * (delta > 0 ? 0.92 : 1.08)));
                if (newScale === oldScale) return;
                const world = screenToWorld(clientX, clientY);
                state.scale = newScale;
                state.panX = clientX - world.x * newScale;
                state.panY = clientY - world.y * newScale;
                requestRender();
            }

            function isActionButton(el) {
                return el.closest('.add-handle') ||
                    el.closest('.delete-btn') ||
                    el.closest('.connect-btn') ||
                    el.closest('.complete-btn') ||
                    el.closest('[data-resize-handle]') ||
                    el.closest('.node-type') ||
                    el.closest('.substep-add') ||
                    el.closest('.substep-expand') ||
                    el.closest('.substep-toggle') ||
                    el.closest('.substep-delete');
            }

            function isFormField(el) {
                return ['INPUT', 'TEXTAREA'].includes(el.tagName) && !isActionButton(el);
            }

            canvasWrap.addEventListener('wheel', event => {
                let el = event.target;
                while (el && el !== canvasWrap) {
                    const overflowY = getComputedStyle(el).overflowY;
                    if ((overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') && el.scrollHeight > el.clientHeight) {
                        return;
                    }
                    el = el.parentElement;
                }
                event.preventDefault();
                zoomAt(event.clientX, event.clientY, event.deltaY);
            }, { passive: false });

            canvasWrap.addEventListener('pointerdown', event => {
                const nodeEl = event.target.closest('[data-node]');

                if (state.previewLink && nodeEl && nodeEl.dataset.id !== state.previewLink.fromId && !event.target.closest('.connect-btn')) {
                    event.preventDefault();
                    return;
                }

                const substepEl = event.target.closest('[data-substep-card]');
                if (substepEl) {
                    const parentId = substepEl.dataset.parent;
                    const stepId = substepEl.dataset.substep;
                    if (event.target.closest('.complete-btn')) {
                        event.preventDefault();
                        event.stopPropagation();
                        toggleSubstep(parentId, stepId);
                        return;
                    }
                    if (event.target.closest('.delete-btn')) {
                        event.preventDefault();
                        event.stopPropagation();
                        removeSubstep(parentId, stepId);
                        return;
                    }
                    if (state.readOnly) return;
                    if (!event.target.closest('.node-title') && !event.target.closest('.node-text')) {
                        selectNode(parentId);
                        const node = getNodeById(parentId);
                        const step = (node?.substeps || []).find(s => s.id === stepId);
                        if (step) {
                            state.potentialSubstepDrag = {
                                nodeId: parentId,
                                stepId,
                                pointerId: event.pointerId,
                                startX: event.clientX,
                                startY: event.clientY,
                                stepStartX: typeof step.x === 'number' ? step.x : 0,
                                stepStartY: typeof step.y === 'number' ? step.y : 0,
                            };
                            try { substepEl.setPointerCapture(event.pointerId); } catch (e) {}
                        }
                    }
                    return;
                }

                if (isActionButton(event.target)) {
                    const nodeId = nodeEl?.dataset.id;
                    if (nodeId) selectNode(nodeId);

                    if (event.target.closest('.add-handle') && nodeId) {
                        event.preventDefault();
                        event.stopPropagation();
                        const origin = getNodeById(nodeId);
                        addNode(origin);
                        return;
                    }
                    if (event.target.closest('.delete-btn') && nodeId) {
                        event.preventDefault();
                        event.stopPropagation();
                        removeNode(nodeId);
                        return;
                    }
                    if (event.target.closest('.complete-btn') && nodeId) {
                        event.preventDefault();
                        event.stopPropagation();
                        toggleDone(nodeId);
                        return;
                    }
                    if (event.target.closest('.connect-btn') && nodeId) {
                        event.preventDefault();
                        event.stopPropagation();
                        if (state.previewLink && state.previewLink.fromId === nodeId) {
                            state.previewLink = null;
                            requestRender();
                            return;
                        }
                        state.previewLink = { fromId: nodeId, pointer: { x: event.clientX, y: event.clientY }, activePointer: event.pointerId };
                        requestRender();
                        return;
                    }
                    if (event.target.closest('[data-resize-handle]') && nodeId) {
                        event.preventDefault();
                        event.stopPropagation();
                        const node = getNodeById(nodeId);
                        if (!node) return;
                        const rectEl = nodeElement(nodeId);
                        const rect = rectEl ? rectEl.getBoundingClientRect() : null;
                        state.resize = {
                            id: nodeId,
                            pointerId: event.pointerId,
                            startX: event.clientX,
                            startY: event.clientY,
                            startWidth: rect ? rect.width / state.scale : node.width,
                            startHeight: rect ? rect.height / state.scale : node.height,
                        };
                        const freshEl = canvasContent.querySelector(`[data-id="${nodeId}"]`);
                        if (freshEl) {
                            try { freshEl.setPointerCapture(event.pointerId); } catch (e) {}
                        }
                        return;
                    }
                    if (event.target.closest('.node-type') && nodeId) {
                        event.preventDefault();
                        event.stopPropagation();
                        toggleNodeType(nodeId);
                        return;
                    }
                    if (event.target.closest('.substep-add') && nodeId) {
                        event.preventDefault();
                        event.stopPropagation();
                        addSubstep(nodeId);
                        return;
                    }
                    if (event.target.closest('.substep-expand') && nodeId) {
                        event.preventDefault();
                        event.stopPropagation();
                        toggleSubstepsExpanded(nodeId);
                        return;
                    }
                    if (event.target.closest('.substep-toggle') && nodeId) {
                        event.preventDefault();
                        event.stopPropagation();
                        const stepEl = event.target.closest('[data-substep]');
                        if (stepEl) toggleSubstep(nodeId, stepEl.dataset.substep);
                        return;
                    }
                    if (event.target.closest('.substep-delete') && nodeId) {
                        event.preventDefault();
                        event.stopPropagation();
                        const stepEl = event.target.closest('[data-substep]');
                        if (stepEl) removeSubstep(nodeId, stepEl.dataset.substep);
                        return;
                    }
                    return;
                }

                if (state.previewLink && !nodeEl) {
                    state.previewLink = null;
                    requestRender();
                }

                const linkEl = event.target.closest('.link-hit') || event.target.closest('.link-label');
                if (linkEl) {
                    const linkId = linkEl.dataset.link || linkEl.dataset.linkLabel;
                    if (linkId) {
                        event.preventDefault();
                        selectLink(linkId);
                        return;
                    }
                }

                if (nodeEl) {
                    const nodeId = nodeEl.dataset.id;
                    selectNode(nodeId);
                    const node = getNodeById(nodeId);
                    if (!node) return;
                    if (state.readOnly) return;

                    state.potentialDrag = {
                        id: nodeId,
                        pointerId: event.pointerId,
                        startX: event.clientX,
                        startY: event.clientY,
                        nodeStartX: node.x,
                        nodeStartY: node.y,
                    };

                    if (!isFormField(event.target)) {
                        const freshEl = canvasContent.querySelector(`[data-id="${nodeId}"]`);
                        if (freshEl) {
                            try { freshEl.setPointerCapture(event.pointerId); } catch (e) {}
                        }
                    }
                    return;
                }

                deselectAll();
                state.pan = {
                    pointerId: event.pointerId,
                    startX: event.clientX,
                    startY: event.clientY,
                    panX: state.panX,
                    panY: state.panY,
                };
                canvasWrap.classList.add('is-panning');
                canvasWrap.setPointerCapture(event.pointerId);
            });

            function nodeElement(id) {
                return canvasContent.querySelector(`[data-id="${id}"]`);
            }

            function updateDropTargetHighlights(hoverId) {
                canvasContent.querySelectorAll('[data-node]').forEach(el => {
                    const id = el.dataset.id;
                    const isTarget = !!state.previewLink && id !== state.previewLink.fromId && canLinkToGoal(id);
                    el.classList.toggle('is-drop-target', isTarget);
                    el.classList.toggle('is-drop-hover', isTarget && id === hoverId);
                });
            }

            function refreshLinks(id) {
                state.links.forEach(link => {
                    if (link.from !== id && link.to !== id) return;
                    const fromNode = getNodeById(link.from);
                    const toNode = getNodeById(link.to);
                    if (!fromNode || !toNode) return;
                    const c = buildCurve(fromNode, toNode);
                    linkLayer.querySelectorAll(`[data-link="${link.id}"]`).forEach(p => p.setAttribute('d', c.d));
                    const labelEl = linkLabels.querySelector(`[data-link-label="${link.id}"]`);
                    if (labelEl) {
                        labelEl.style.left = `${c.midX}px`;
                        labelEl.style.top = `${c.midY}px`;
                    }
                });
            }

            window.addEventListener('pointermove', event => {
                if (state.resize && state.resize.pointerId === event.pointerId) {
                    const node = getNodeById(state.resize.id);
                    if (!node) return;
                    const dx = (event.clientX - state.resize.startX) / state.scale;
                    const dy = (event.clientY - state.resize.startY) / state.scale;
                    node.width = Math.max(MIN_NODE_WIDTH, state.resize.startWidth + dx);
                    node.height = Math.max(MIN_NODE_HEIGHT, state.resize.startHeight + dy);
                    const el = nodeElement(node.id);
                    if (el) {
                        el.style.width = `${node.width}px`;
                        el.style.minHeight = `${node.height}px`;
                        const titleEl = el.querySelector('.node-title');
                        if (titleEl) fitTitle(titleEl);
                    }
                    refreshLinks(node.id);
                    refreshSubsteps(node.id);
                    renderMiniMap();
                    return;
                }

                if (state.drag && state.drag.pointerId === event.pointerId) {
                    const node = getNodeById(state.drag.id);
                    if (!node) return;
                    node.x = state.drag.nodeStartX + (event.clientX - state.drag.startX) / state.scale;
                    node.y = state.drag.nodeStartY + (event.clientY - state.drag.startY) / state.scale;
                    const el = nodeElement(node.id);
                    if (el) {
                        el.style.left = `${node.x}px`;
                        el.style.top = `${node.y}px`;
                        el.classList.add('is-dragging');
                    }
                    refreshLinks(node.id);
                    refreshSubsteps(node.id);
                    renderMiniMap();
                    return;
                }

                if (state.substepDrag && state.substepDrag.pointerId === event.pointerId) {
                    const node = getNodeById(state.substepDrag.nodeId);
                    const step = (node?.substeps || []).find(s => s.id === state.substepDrag.stepId);
                    if (!node || !step) return;
                    step.x = state.substepDrag.stepStartX + (event.clientX - state.substepDrag.startX) / state.scale;
                    step.y = state.substepDrag.stepStartY + (event.clientY - state.substepDrag.startY) / state.scale;
                    const card = canvasContent.querySelector(`[data-substep-card][data-parent="${node.id}"][data-substep="${step.id}"]`);
                    if (card) card.classList.add('is-dragging');
                    refreshSubsteps(node.id);
                    renderMiniMap();
                    return;
                }

                if (state.potentialSubstepDrag && state.potentialSubstepDrag.pointerId === event.pointerId) {
                    const dx = event.clientX - state.potentialSubstepDrag.startX;
                    const dy = event.clientY - state.potentialSubstepDrag.startY;
                    if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
                        pushUndo();
                        state.substepDrag = {
                            nodeId: state.potentialSubstepDrag.nodeId,
                            stepId: state.potentialSubstepDrag.stepId,
                            pointerId: state.potentialSubstepDrag.pointerId,
                            startX: state.potentialSubstepDrag.startX,
                            startY: state.potentialSubstepDrag.startY,
                            stepStartX: state.potentialSubstepDrag.stepStartX,
                            stepStartY: state.potentialSubstepDrag.stepStartY,
                        };
                        state.potentialSubstepDrag = null;
                    }
                    return;
                }

                if (state.potentialDrag && state.potentialDrag.pointerId === event.pointerId) {
                    const dx = event.clientX - state.potentialDrag.startX;
                    const dy = event.clientY - state.potentialDrag.startY;
                    if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
                        const node = getNodeById(state.potentialDrag.id);
                        if (!node) return;
                        pushUndo();
                        state.drag = {
                            id: state.potentialDrag.id,
                            pointerId: state.potentialDrag.pointerId,
                            startX: state.potentialDrag.startX,
                            startY: state.potentialDrag.startY,
                            nodeStartX: state.potentialDrag.nodeStartX,
                            nodeStartY: state.potentialDrag.nodeStartY,
                        };
                        state.potentialDrag = null;
                        node.x = state.drag.nodeStartX + (event.clientX - state.drag.startX) / state.scale;
                        node.y = state.drag.nodeStartY + (event.clientY - state.drag.startY) / state.scale;
                        const el = nodeElement(node.id);
                        if (el) {
                            if (!el.hasPointerCapture(event.pointerId)) {
                                try { el.setPointerCapture(event.pointerId); } catch (e) {}
                            }
                            el.classList.add('is-dragging');
                            el.style.left = `${node.x}px`;
                            el.style.top = `${node.y}px`;
                        }
                        refreshLinks(node.id);
                    }
                    return;
                }

                if (state.pan && state.pan.pointerId === event.pointerId) {
                    state.panX = state.pan.panX + (event.clientX - state.pan.startX);
                    state.panY = state.pan.panY + (event.clientY - state.pan.startY);
                    updateTransforms();
                    renderMiniMap();
                    return;
                }

                if (state.previewLink) {
                    state.previewLink.pointer = { x: event.clientX, y: event.clientY };
                    let hoverId = null;
                    const underEl = document.elementFromPoint(event.clientX, event.clientY);
                    const underNode = underEl ? underEl.closest('[data-node]') : null;
                    if (underNode && underNode.dataset.id !== state.previewLink.fromId && canLinkToGoal(underNode.dataset.id)) {
                        hoverId = underNode.dataset.id;
                    }
                    if (state.previewLink.targetId !== hoverId) {
                        state.previewLink.targetId = hoverId;
                        updateDropTargetHighlights(hoverId);
                    }
                    renderLinks();
                }
            });

            window.addEventListener('pointerup', event => {
                if (state.previewLink && state.previewLink.fromId) {
                    const targetNodeEl = event.target.closest('[data-node]');
                    const targetId = targetNodeEl ? targetNodeEl.dataset.id : null;
                    if (targetId && targetId !== state.previewLink.fromId) {
                        connectNodes(state.previewLink.fromId, targetId);
                        state.previewLink = null;
                        requestRender();
                        return;
                    }
                    if (!targetId && state.previewLink.activePointer === event.pointerId) {
                        state.previewLink = null;
                        requestRender();
                        return;
                    }
                }

                if (state.resize && state.resize.pointerId === event.pointerId) {
                    state.resize = null;
                    requestRender();
                    scheduleSave();
                    return;
                }

                if (state.drag && state.drag.pointerId === event.pointerId) {
                    const draggedEl = canvasContent.querySelector(`[data-id="${state.drag.id}"]`);
                    draggedEl?.classList.remove('is-dragging');
                    state.drag = null;
                    requestRender();
                    scheduleSave();
                    return;
                }

                if (state.substepDrag && state.substepDrag.pointerId === event.pointerId) {
                    state.substepDrag = null;
                    requestRender();
                    scheduleSave();
                    return;
                }

                if (state.potentialSubstepDrag && state.potentialSubstepDrag.pointerId === event.pointerId) {
                    state.potentialSubstepDrag = null;
                    return;
                }

                if (state.potentialDrag && state.potentialDrag.pointerId === event.pointerId) {
                    const nodeEl = canvasContent.querySelector(`[data-id="${state.potentialDrag.id}"]`);
                    if (nodeEl && isFormField(event.target)) {
                        const field = event.target;
                        setTimeout(() => {
                            field.focus();
                            if (field.tagName === 'INPUT') field.select();
                        }, 10);
                    }
                    state.potentialDrag = null;
                    return;
                }

                if (state.pan && state.pan.pointerId === event.pointerId) {
                    state.pan = null;
                    canvasWrap.classList.remove('is-panning');
                    return;
                }
            });

            canvasContent.addEventListener('focusin', event => {
                if (isFormField(event.target)) editingField = event.target;
            });
            canvasContent.addEventListener('focusout', event => {
                if (event.target === editingField) editingField = null;
            });
            canvasContent.addEventListener('input', event => {
                const cardEl = event.target.closest('[data-substep-card]');
                if (cardEl) {
                    const parent = getNodeById(cardEl.dataset.parent);
                    const step = (parent?.substeps || []).find(s => s.id === cardEl.dataset.substep);
                    if (!step) return;
                    if (event.target === editingField) {
                        pushUndo();
                        editingField = null;
                    }
                    if (event.target.classList.contains('node-text')) {
                        step.note = event.target.value;
                    } else {
                        step.title = event.target.value;
                    }
                    scheduleSave();
                    return;
                }
                const nodeEl = event.target.closest('[data-node]');
                if (!nodeEl) return;
                const node = getNodeById(nodeEl.dataset.id);
                if (!node) return;
                if (event.target === editingField) {
                    pushUndo();
                    editingField = null;
                }
                const value = event.target.value;
                if (event.target.classList.contains('node-title')) {
                    node.title = value;
                    fitTitle(event.target);
                } else if (event.target.classList.contains('node-text')) {
                    node.note = value;
                } else if (event.target.classList.contains('node-date')) {
                    node.due = value;
                } else if (event.target.classList.contains('node-duration')) {
                    node.duration = value;
                    const link = state.links.find(item => item.to === node.id);
                    if (link) {
                        link.label = value || 'без срока';
                        const labelEl = linkLabels.querySelector(`[data-link-label="${link.id}"]`);
                        if (labelEl) labelEl.textContent = link.label;
                    }
                } else if (event.target.classList.contains('substep-title')) {
                    const stepEl = event.target.closest('[data-substep]');
                    const step = (node.substeps || []).find(s => s.id === stepEl?.dataset.substep);
                    if (step) step.title = value;
                }
                scheduleSave();
            });

            themeBtn.addEventListener('click', toggleTheme);

            addRootBtn.addEventListener('click', () => {
                const newNode = addNode(null);
                if (newNode) centerOnSelection();
            });
            centerBtn.addEventListener('click', centerOnSelection);
            window.addEventListener('resize', requestRender);

            document.addEventListener('keydown', event => {
                const isEditing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);

                if (state.readOnly) {
                    if ((event.key === 'Delete' || event.key === 'Backspace') && !isEditing) {
                        event.preventDefault();
                    }
                    return;
                }

                if (event.key === 'Escape' && !isEditing && state.previewLink) {
                    state.previewLink = null;
                    requestRender();
                    return;
                }

                if ((event.key === 'Delete' || event.key === 'Backspace') && !isEditing) {
                    if (state.selectedNodeId) {
                        event.preventDefault();
                        removeNode(state.selectedNodeId);
                        return;
                    }
                    if (state.selectedLinkId) {
                        event.preventDefault();
                        removeLink(state.selectedLinkId);
                        return;
                    }
                }

                if ((event.ctrlKey || event.metaKey) && event.code === 'KeyZ' && !event.shiftKey) {
                    event.preventDefault();
                    if (!undo()) showToast('Нечего отменять');
                    return;
                }

                if ((event.ctrlKey || event.metaKey) && (event.code === 'KeyY' || (event.code === 'KeyZ' && event.shiftKey))) {
                    event.preventDefault();
                    if (!redo()) showToast('Нечего повторять');
                    return;
                }

                if ((event.ctrlKey || event.metaKey) && event.code === 'KeyC' && !isEditing) {
                    if (state.selectedNodeId) {
                        const node = getNodeById(state.selectedNodeId);
                        if (node) {
                            state.clipboard = copyNode(node);
                            showToast('📋 Этап скопирован (Ctrl+V чтобы вставить)');
                        }
                    }
                    event.preventDefault();
                    return;
                }

                if ((event.ctrlKey || event.metaKey) && event.code === 'KeyV' && !isEditing) {
                    if (state.clipboard) {
                        pushUndo();
                        const newNode = {
                            ...copyNode(state.clipboard),
                            id: createId(),
                            x: state.clipboard.x + 60,
                            y: state.clipboard.y + 60,
                        };
                        state.nodes.push(newNode);
                        selectNode(newNode.id);
                        showToast('✅ Этап вставлен');
                    } else {
                        showToast('📋 Сначала скопируйте этап (Ctrl+C)');
                    }
                    event.preventDefault();
                    return;
                }

                if ((event.ctrlKey || event.metaKey) && event.code === 'KeyN') {
                    event.preventDefault();
                    const newNode = addNode(getNodeById(state.selectedNodeId) || null);
                    if (newNode) centerOnSelection();
                    return;
                }

                if ((event.ctrlKey || event.metaKey) && event.code === 'Digit0') {
                    event.preventDefault();
                    state.scale = 1;
                    centerOnSelection();
                    return;
                }
            });

            templatesBtn.addEventListener('click', event => {
                event.stopPropagation();
                openTemplatesPanel(!templatesPanel.classList.contains('is-open'));
            });
            newTemplateBtn.addEventListener('click', async () => {
                openTemplatesPanel(false);
                await createTemplate();
            });
            templateNameInput.addEventListener('change', async () => {
                const name = templateNameInput.value.trim();
                if (name && name !== state.currentName) {
                    state.currentName = name;
                    await saveCurrent();
                    await refreshTemplates();
                }
            });
            document.addEventListener('pointerdown', event => {
                if (templatesPanel.classList.contains('is-open') &&
                    !event.target.closest('#templatesPanel') &&
                    !event.target.closest('#templatesBtn')) {
                    openTemplatesPanel(false);
                }
            });

            async function initApp() {
                if (!authToken) {
                    showLogin();
                    return;
                }
                try {
                    currentUser = await api('/api/auth/me');
                    applyRole();
                    await refreshTemplates();
                    if (state.templates.length) {
                        await switchTemplate(state.templates[0].id);
                    } else if (!state.readOnly) {
                        await createTemplate();
                    }
                } catch (e) {
                    showToast('⚠️ Не удалось загрузить шаблоны');
                }
                setTheme(state.theme);
                requestRender();
            }

            loginForm.addEventListener('submit', async event => {
                event.preventDefault();
                loginError.textContent = '';
                const username = loginUsername.value.trim();
                const password = loginPassword.value;
                if (!username || !password) return;
                loginSubmit.disabled = true;
                try {
                    const res = await fetch('/api/auth/login', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username, password }),
                    });
                    if (!res.ok) throw new Error('Неверный логин или пароль');
                    const data = await res.json();
                    authToken = data.token;
                    currentUser = { username: data.username, role: data.role };
                    localStorage.setItem('timeline_token', authToken);
                    loginPassword.value = '';
                    hideLogin();
                    applyRole();
                    await initApp();
                } catch (e) {
                    loginError.textContent = 'Неверный логин или пароль';
                } finally {
                    loginSubmit.disabled = false;
                }
            });

            logoutBtn.addEventListener('click', async () => {
                try {
                    await fetch('/api/auth/logout', {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${authToken}` },
                    });
                } catch (e) {}
                authToken = null;
                currentUser = null;
                localStorage.removeItem('timeline_token');
                loginUsername.value = '';
                loginPassword.value = '';
                templateNameInput.value = '';
                state.currentId = null;
                state.currentName = '';
                state.version = null;
                state.nodes = [];
                state.links = [];
                requestRender();
                showLogin('Вы вышли из системы');
            });

            window.addEventListener('pagehide', () => {
                flushSave();
            });

            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') flushSave();
            });

            setTheme(state.theme);
            initApp();


        })();
