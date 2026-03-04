/* ============================================================
   GREGORY — Chat Application Logic (Sub-Agent Architecture)
   ============================================================ */

const EDGE_FUNCTION_URL = 'https://civpkkhofvpaifprhpii.supabase.co/functions/v1/gregory-chat';

// ---------- SUPABASE ----------

const supabaseClient = supabase.createClient(
    'https://civpkkhofvpaifprhpii.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNpdnBra2hvZnZwYWlmcHJocGlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDk4ODc2NDksImV4cCI6MjA2NTQ2MzY0OX0.Vu7gH2SZ41OCqH6i9lio3FESM6dL0k3hdIsb-0n_Xww'
);

// ---------- STATE ----------

const appState = {
    currentAgent: null,
    conversations: {},
    isStreaming: false,
    tagDropdownIndex: -1,
    user: null,
};

// ---------- DOM ----------

const chatContainer = document.getElementById('chatContainer');
const messagesDiv = document.getElementById('messages');
const welcomeScreen = document.getElementById('welcomeScreen');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const clearBtn = document.getElementById('clearChat');
const sidebar = document.getElementById('sidebar');
const sidebarOpen = document.getElementById('sidebarOpen');
const sidebarClose = document.getElementById('sidebarClose');
const headerBadge = document.getElementById('headerBadge');
const statusText = document.getElementById('statusText');
const disclaimerEl = document.getElementById('disclaimer');
const inputHint = document.getElementById('inputHint');
const agentTagDropdown = document.getElementById('agentTagDropdown');
const historyToggle = document.getElementById('historyToggle');
const historyPanel = document.getElementById('historyPanel');
const historyList = document.getElementById('historyList');
const authForm = document.getElementById('authForm');
const authEmail = document.getElementById('authEmail');
const authPassword = document.getElementById('authPassword');
const authSignInBtn = document.getElementById('authSignIn');
const authSignUpBtn = document.getElementById('authSignUp');
const authMagicLinkBtn = document.getElementById('authMagicLink');
const authMessage = document.getElementById('authMessage');
const userBar = document.getElementById('userBar');
const userEmailEl = document.getElementById('userEmail');
const authSignOutBtn = document.getElementById('authSignOut');

// ---------- SIDEBAR ----------

sidebarOpen?.addEventListener('click', () => sidebar.classList.add('open'));
sidebarClose?.addEventListener('click', () => sidebar.classList.remove('open'));

// ---------- AGENT NAVIGATION ----------

function renderAgentNav() {
    const container = document.getElementById('agentNavList');
    container.innerHTML = Object.values(AGENTS).map(agent => `
        <a href="#/${agent.key}" class="capability-card agent-nav-item" data-agent="${agent.key}">
            <div class="capability-icon">${agent.icon}</div>
            <div class="capability-info">
                <h4>${agent.name}</h4>
                <p>${agent.tagline}</p>
            </div>
        </a>
    `).join('');
}

function updateSidebarActiveState(agentKey) {
    document.querySelectorAll('.agent-nav-item').forEach(el => {
        el.classList.toggle('active', el.dataset.agent === agentKey);
    });
}

// ---------- THEME ----------

function applyAgentTheme(agentKey) {
    const agent = agentKey ? AGENTS[agentKey] : null;
    const config = agent || GREGORY_HUB;
    const [s1, s2, s3] = config.gradientStops;

    document.body.style.setProperty('--accent', config.accentColor);
    document.body.style.setProperty('--accent-glow', `rgba(${config.accentColorRGB}, 0.2)`);
    document.body.style.setProperty('--accent-light', s1);
    document.body.style.setProperty('--accent-gradient', `linear-gradient(135deg, ${s1} 0%, ${s2} 50%, ${s3} 100%)`);

    if (agent) {
        document.body.setAttribute('data-agent', agentKey);
    } else {
        document.body.removeAttribute('data-agent');
    }
}

// ---------- WELCOME SCREENS ----------

function renderHubWelcome() {
    welcomeScreen.innerHTML = `
        <div class="welcome-glow"></div>
        <div class="welcome-icon">G</div>
        <h2>What can I help you with?</h2>
        <p>${escapeHtml(GREGORY_HUB.description)}</p>
        <div class="hub-agents">
            ${Object.values(AGENTS).map(agent => `
                <a href="#/${agent.key}" class="hub-agent-card">
                    <div class="hub-agent-icon">${agent.icon}</div>
                    <h3>${agent.shortName}</h3>
                    <p>${agent.tagline}</p>
                </a>
            `).join('')}
        </div>
        <div class="example-questions" style="margin-top: 20px;">
            ${GREGORY_HUB.exampleQuestions.map(q => `
                <button class="example-btn" data-query="${escapeAttr(q.query)}">
                    ${escapeHtml(q.label)}
                </button>
            `).join('')}
        </div>
    `;

    welcomeScreen.querySelectorAll('.example-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            sendMessage(btn.dataset.query);
        });
    });
}

function renderAgentWelcome(agentKey) {
    const agent = AGENTS[agentKey];
    if (!agent) return;

    welcomeScreen.innerHTML = `
        <div class="welcome-glow"></div>
        <div class="welcome-icon">${agent.icon}</div>
        <h2>${agent.name}</h2>
        <p>${agent.description}</p>
        <div class="example-questions">
            ${agent.exampleQuestions.map(q => `
                <button class="example-btn" data-query="${escapeAttr(q.query)}">
                    ${escapeHtml(q.label)}
                </button>
            `).join('')}
        </div>
    `;

    welcomeScreen.querySelectorAll('.example-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            sendMessage(btn.dataset.query);
        });
    });
}

// ---------- HEADER & INPUT UPDATES ----------

function updateHeaderForAgent(agentKey) {
    const agent = AGENTS[agentKey];
    if (agent) {
        headerBadge.textContent = agent.headerBadge;
        messageInput.placeholder = agent.placeholder;
        statusText.textContent = agent.statusText;
        disclaimerEl.textContent = agent.disclaimer;
        inputHint.textContent = agent.disclaimer;
        document.title = `GREGORY \u2014 ${agent.name}`;
    } else {
        headerBadge.textContent = 'Citation-First AI';
        messageInput.placeholder = 'Ask GREGORY anything about marketing\u2026';
        statusText.textContent = 'Knowledge graph active';
        disclaimerEl.textContent = 'Responses use peer-reviewed research and verified data. All numbers labeled as REPORTED, ESTIMATE, or UNKNOWN.';
        inputHint.textContent = 'GREGORY uses peer-reviewed research & real-time data. All claims are sourced.';
        document.title = 'GREGORY \u2014 Marketing Intelligence';
    }
}

// ---------- AUTH ----------

function showAuthMessage(text, isError = false) {
    authMessage.textContent = text;
    authMessage.className = isError ? 'auth-message error' : 'auth-message';
}

function renderAuthUI() {
    if (appState.user) {
        authForm.style.display = 'none';
        userBar.style.display = 'flex';
        userEmailEl.textContent = appState.user.email;
    } else {
        authForm.style.display = 'flex';
        userBar.style.display = 'none';
        showAuthMessage('');
    }
}

authSignInBtn.addEventListener('click', async () => {
    const email = authEmail.value.trim();
    const password = authPassword.value;
    if (!email || !password) { showAuthMessage('Enter email and password', true); return; }
    showAuthMessage('Signing in...');
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) showAuthMessage(error.message, true);
});

authSignUpBtn.addEventListener('click', async () => {
    const email = authEmail.value.trim();
    const password = authPassword.value;
    if (!email || !password) { showAuthMessage('Enter email and password', true); return; }
    if (password.length < 6) { showAuthMessage('Password must be at least 6 characters', true); return; }
    showAuthMessage('Creating account...');
    const { error } = await supabaseClient.auth.signUp({ email, password });
    if (error) showAuthMessage(error.message, true);
    else showAuthMessage('Check your email to confirm your account');
});

authMagicLinkBtn.addEventListener('click', async () => {
    const email = authEmail.value.trim();
    if (!email) { showAuthMessage('Enter your email address', true); return; }
    showAuthMessage('Sending magic link...');
    const { error } = await supabaseClient.auth.signInWithOtp({ email });
    if (error) showAuthMessage(error.message, true);
    else showAuthMessage('Check your email for the sign-in link');
});

authSignOutBtn.addEventListener('click', async () => {
    await supabaseClient.auth.signOut();
});

supabaseClient.auth.onAuthStateChange(async (event, session) => {
    const prevUser = appState.user;
    appState.user = session?.user || null;
    renderAuthUI();

    if (appState.user && !prevUser) {
        // Just signed in — migrate localStorage to DB, then load from DB
        await migrateLocalToDb();
        await loadConversations();
        handleRoute();
    } else if (!appState.user && prevUser) {
        // Just signed out — clear state, switch to localStorage
        appState.conversations = {};
        loadConversationsFromLocal();
        handleRoute();
    }
});

async function migrateLocalToDb() {
    try {
        const raw = localStorage.getItem('gregory_conversations');
        if (!raw) return;
        const data = JSON.parse(raw);
        const entries = Object.entries(data);
        if (entries.length === 0) return;

        for (const [agentKey, history] of entries) {
            if (history.length > 0) {
                await supabaseClient.from('conversations').upsert({
                    user_id: appState.user.id,
                    agent_key: agentKey,
                    history,
                    updated_at: new Date().toISOString(),
                }, { onConflict: 'user_id,agent_key' });
            }
        }
        localStorage.removeItem('gregory_conversations');
    } catch (e) {
        // Migration failed — keep localStorage as fallback
    }
}

// ---------- CONVERSATION STORAGE ----------

function saveConversations() {
    if (appState.user) {
        saveConversationsToDb();
    } else {
        saveConversationsToLocal();
    }
    renderHistoryPanel();
}

function saveConversationsToLocal() {
    const data = {};
    for (const [key, conv] of Object.entries(appState.conversations)) {
        if (conv.history.length > 0) {
            data[key] = conv.history;
        }
    }
    localStorage.setItem('gregory_conversations', JSON.stringify(data));
}

async function saveConversationsToDb() {
    if (!appState.user) return;
    for (const [key, conv] of Object.entries(appState.conversations)) {
        if (conv.history.length > 0) {
            await supabaseClient.from('conversations').upsert({
                user_id: appState.user.id,
                agent_key: key,
                history: conv.history,
                updated_at: new Date().toISOString(),
            }, { onConflict: 'user_id,agent_key' });
        }
    }
}

async function loadConversations() {
    if (appState.user) {
        await loadConversationsFromDb();
    } else {
        loadConversationsFromLocal();
    }
}

function loadConversationsFromLocal() {
    try {
        const raw = localStorage.getItem('gregory_conversations');
        if (!raw) return;
        const data = JSON.parse(raw);
        for (const [key, history] of Object.entries(data)) {
            appState.conversations[key] = {
                history,
                domSnapshot: '',
                welcomeHidden: history.length > 0,
            };
        }
    } catch (e) {
        // Corrupted data — start fresh
    }
}

async function loadConversationsFromDb() {
    if (!appState.user) return;
    try {
        const { data, error } = await supabaseClient
            .from('conversations')
            .select('agent_key, history')
            .eq('user_id', appState.user.id);
        if (error) throw error;
        appState.conversations = {};
        for (const row of data) {
            appState.conversations[row.agent_key] = {
                history: row.history,
                domSnapshot: '',
                welcomeHidden: row.history.length > 0,
            };
        }
    } catch (e) {
        console.error('Failed to load conversations from DB:', e);
        loadConversationsFromLocal();
    }
}

async function deleteConversationFromDb(agentKey) {
    if (!appState.user) return;
    await supabaseClient
        .from('conversations')
        .delete()
        .eq('user_id', appState.user.id)
        .eq('agent_key', agentKey);
}

// ---------- HISTORY PANEL ----------

function renderHistoryPanel() {
    const entries = [];
    for (const [key, conv] of Object.entries(appState.conversations)) {
        if (conv.history.length > 0) {
            const agent = AGENTS[key];
            const isHub = key === 'gregory';
            const icon = agent ? agent.icon : 'G';
            const name = agent ? agent.shortName : 'GREGORY';
            const firstUserMsg = conv.history.find(m => m.role === 'user');
            const preview = firstUserMsg ? firstUserMsg.content : 'Conversation';
            const msgCount = Math.floor(conv.history.length / 2);
            const isActive = isHub
                ? appState.currentAgent === null
                : appState.currentAgent === key;

            entries.push({ key, icon, name, preview, msgCount, isActive, isHub });
        }
    }

    if (entries.length === 0) {
        historyList.innerHTML = '<div class="history-panel-empty">No saved conversations</div>';
        return;
    }

    historyList.innerHTML = entries.map(e => `
        <div class="history-item ${e.isActive ? 'active' : ''}" data-key="${e.key}">
            <div class="history-item-icon">${e.isHub ? '<span style="font-weight:700;font-size:0.85rem;">G</span>' : e.icon}</div>
            <div class="history-item-info">
                <div class="history-item-name">${e.name}</div>
                <div class="history-item-preview">${escapeHtml(e.preview)}</div>
            </div>
            <span class="history-item-count">${e.msgCount}</span>
            <button class="history-item-delete" data-key="${e.key}" title="Delete conversation">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
            </button>
        </div>
    `).join('');

    historyList.querySelectorAll('.history-item').forEach(el => {
        el.addEventListener('click', (e) => {
            if (e.target.closest('.history-item-delete')) return;
            const key = el.dataset.key;
            if (key === 'gregory') {
                window.location.hash = '#/';
            } else {
                window.location.hash = `#/${key}`;
            }
            historyPanel.classList.remove('visible');
        });
    });

    historyList.querySelectorAll('.history-item-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteConversation(btn.dataset.key);
        });
    });
}

function toggleHistoryPanel() {
    historyPanel.classList.toggle('visible');
    if (historyPanel.classList.contains('visible')) {
        renderHistoryPanel();
    }
}

function deleteConversation(key) {
    const conv = appState.conversations[key];
    if (conv) {
        conv.history = [];
        conv.domSnapshot = '';
        conv.welcomeHidden = false;
    }
    saveConversations();
    deleteConversationFromDb(key);

    const isCurrentAgent = (key === 'gregory' && appState.currentAgent === null)
        || key === appState.currentAgent;
    if (isCurrentAgent) {
        messagesDiv.innerHTML = '';
        welcomeScreen.style.display = 'flex';
        if (appState.currentAgent) {
            renderAgentWelcome(appState.currentAgent);
        } else {
            renderHubWelcome();
        }
    }
}

historyToggle.addEventListener('click', toggleHistoryPanel);

document.addEventListener('click', (e) => {
    if (!e.target.closest('#historyPanel') && !e.target.closest('#historyToggle')) {
        historyPanel.classList.remove('visible');
    }
});

// ---------- TASK HISTORY ----------

function initHistoryTabs() {
    var tabs = historyPanel.querySelectorAll('.history-tab');
    tabs.forEach(function(tab) {
        tab.addEventListener('click', function() {
            tabs.forEach(function(t) { t.classList.remove('active'); });
            tab.classList.add('active');

            var target = tab.dataset.tab;
            var convList = document.getElementById('historyList');
            var taskList = document.getElementById('taskHistoryList');

            if (target === 'tasks') {
                convList.style.display = 'none';
                taskList.style.display = 'block';
                loadTaskHistory();
            } else {
                convList.style.display = 'block';
                taskList.style.display = 'none';
            }
        });
    });
}

async function loadTaskHistory() {
    var taskList = document.getElementById('taskHistoryList');
    if (!taskList) return;

    if (!appState.user) {
        taskList.innerHTML = '<div class="history-panel-empty">Sign in to view task history</div>';
        return;
    }

    taskList.innerHTML = '<div class="history-panel-empty"><span class="tool-spinner"></span> Loading...</div>';

    try {
        var resp = await supabaseClient
            .from('tasks')
            .select('id, title, status, created_at, plan, accumulated_context')
            .eq('user_id', appState.user.id)
            .order('created_at', { ascending: false })
            .limit(20);

        if (resp.error) throw resp.error;
        var tasks = resp.data || [];

        if (tasks.length === 0) {
            taskList.innerHTML = '<div class="history-panel-empty">No completed tasks</div>';
            return;
        }

        var statusIcons = {
            completed: '\u2705',
            failed: '\u274C',
            aborted: '\u23F9',
            executing: '\u25B6',
            checkpoint: '\u23F8',
            awaiting_approval: '\u23F3',
            planning: '\uD83D\uDCCB',
        };

        taskList.innerHTML = tasks.map(function(t) {
            var icon = statusIcons[t.status] || '\u2753';
            var stepCount = t.plan && t.plan.steps ? t.plan.steps.length : 0;
            var dateStr = new Date(t.created_at).toLocaleDateString();
            return '<div class="history-item task-history-item" data-task-id="' + t.id + '">' +
                '<div class="history-item-icon">' + icon + '</div>' +
                '<div class="history-item-info">' +
                    '<div class="history-item-name">' + escapeHtml(t.title) + '</div>' +
                    '<div class="history-item-preview">' + stepCount + ' steps \u2022 ' + t.status + ' \u2022 ' + dateStr + '</div>' +
                '</div>' +
            '</div>';
        }).join('');

        taskList.querySelectorAll('.task-history-item').forEach(function(el) {
            el.addEventListener('click', function() {
                var taskId = el.dataset.taskId;
                var task = tasks.find(function(t) { return t.id === taskId; });
                if (task) showTaskDetail(task);
                historyPanel.classList.remove('visible');
            });
        });
    } catch (e) {
        console.error('Failed to load task history:', e);
        taskList.innerHTML = '<div class="history-panel-empty">Failed to load tasks</div>';
    }
}

function showTaskDetail(task) {
    welcomeScreen.style.display = 'none';
    messagesDiv.innerHTML = '';

    // Render the task as a message
    var msgEl = document.createElement('div');
    msgEl.className = 'message message-ai';
    msgEl.innerHTML = '<div class="message-avatar">G</div>' +
        '<div class="message-content">' +
            '<div class="task-detail-header">' +
                '<h3>' + escapeHtml(task.title) + '</h3>' +
                '<span class="task-detail-status status-' + task.status + '">' + task.status + '</span>' +
            '</div>' +
            (task.plan && task.plan.steps ? '<div class="task-detail-steps">' +
                task.plan.steps.map(function(step, i) {
                    var agentCfg = AGENTS[step.agent] || GREGORY_HUB;
                    return '<div class="task-detail-step">' +
                        '<span class="task-step-number">' + (i + 1) + '</span>' +
                        '<span class="task-step-agent">' + (agentCfg.icon || 'G') + '</span>' +
                        '<span>' + escapeHtml(step.description) + '</span>' +
                    '</div>';
                }).join('') +
            '</div>' : '') +
            (task.accumulated_context ? '<div class="message-text">' + renderMarkdown(task.accumulated_context) + '</div>' : '<div class="message-text"><p style="color: var(--text-muted);">No synthesis available for this task.</p></div>') +
        '</div>';
    messagesDiv.appendChild(msgEl);
    scrollToBottom();
}

// Initialize tabs after DOM loads
setTimeout(initHistoryTabs, 0);

// ---------- CONVERSATION PERSISTENCE ----------

function getConversation(agentKey) {
    const key = agentKey || 'gregory';
    if (!appState.conversations[key]) {
        appState.conversations[key] = {
            history: [],
            domSnapshot: '',
            welcomeHidden: false,
        };
    }
    return appState.conversations[key];
}

function saveCurrentConversation() {
    const key = appState.currentAgent || 'gregory';
    const conv = appState.conversations[key];
    if (conv) {
        conv.domSnapshot = messagesDiv.innerHTML;
        conv.welcomeHidden = (welcomeScreen.style.display === 'none');
    }
}

function rebuildFromHistory(conv, agentKey) {
    messagesDiv.innerHTML = '';
    const agent = agentKey ? AGENTS[agentKey] : null;
    const avatarLetter = agent ? agent.avatarLetter : 'G';

    for (const msg of conv.history) {
        const msgEl = document.createElement('div');
        if (msg.role === 'user') {
            msgEl.className = 'message message-user';
            msgEl.innerHTML = `
                <div class="message-avatar">You</div>
                <div class="message-content">
                    <div class="message-text">${escapeHtml(msg.content)}</div>
                </div>`;
        } else {
            msgEl.className = 'message message-ai';
            msgEl.innerHTML = `
                <div class="message-avatar">${avatarLetter}</div>
                <div class="message-content">
                    <div class="message-text">${renderMarkdown(msg.content)}</div>
                </div>`;
        }
        messagesDiv.appendChild(msgEl);
    }

    welcomeScreen.style.display = 'none';
}

function restoreConversation(agentKey) {
    const conv = getConversation(agentKey);
    if (conv && conv.domSnapshot) {
        messagesDiv.innerHTML = conv.domSnapshot;
        welcomeScreen.style.display = conv.welcomeHidden ? 'none' : 'flex';
        if (!conv.welcomeHidden) {
            renderAgentWelcome(agentKey);
        }
    } else if (conv && conv.history.length > 0) {
        rebuildFromHistory(conv, agentKey);
    } else {
        messagesDiv.innerHTML = '';
        welcomeScreen.style.display = 'flex';
        renderAgentWelcome(agentKey);
    }
}

function restoreHubConversation() {
    const conv = getConversation(null);
    if (conv && conv.domSnapshot) {
        messagesDiv.innerHTML = conv.domSnapshot;
        welcomeScreen.style.display = conv.welcomeHidden ? 'none' : 'flex';
        if (!conv.welcomeHidden) {
            renderHubWelcome();
        }
    } else if (conv && conv.history.length > 0) {
        rebuildFromHistory(conv, null);
    } else {
        messagesDiv.innerHTML = '';
        welcomeScreen.style.display = 'flex';
        renderHubWelcome();
    }
}

// ---------- ROUTER ----------

function navigateTo(agentKey) {
    if (appState.isStreaming) return;

    saveCurrentConversation();

    if (agentKey && AGENTS[agentKey]) {
        appState.currentAgent = agentKey;
        applyAgentTheme(agentKey);
        updateSidebarActiveState(agentKey);
        updateHeaderForAgent(agentKey);
        restoreConversation(agentKey);
    } else {
        appState.currentAgent = null;
        applyAgentTheme(null);
        updateSidebarActiveState(null);
        updateHeaderForAgent(null);
        restoreHubConversation();
    }

    sidebar.classList.remove('open');
    scrollToBottom();
}

function handleRoute() {
    const hash = window.location.hash.replace('#/', '') || '';
    navigateTo(hash || null);
}

window.addEventListener('hashchange', handleRoute);

// ---------- INPUT ----------

messageInput.addEventListener('input', () => {
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
    sendBtn.disabled = !messageInput.value.trim() || appState.isStreaming;
    handleTagDropdown();
});

messageInput.addEventListener('keydown', (e) => {
    if (agentTagDropdown.classList.contains('visible')) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Escape') {
            handleTagKeyboard(e);
            return;
        }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!sendBtn.disabled) handleSend();
    }
});

sendBtn.addEventListener('click', () => {
    if (!sendBtn.disabled) handleSend();
});

clearBtn.addEventListener('click', () => {
    const key = appState.currentAgent || 'gregory';
    const conv = appState.conversations[key];
    if (conv) {
        conv.history = [];
        conv.domSnapshot = '';
        conv.welcomeHidden = false;
    }
    messagesDiv.innerHTML = '';
    welcomeScreen.style.display = 'flex';
    if (appState.currentAgent) {
        renderAgentWelcome(appState.currentAgent);
    } else {
        renderHubWelcome();
    }
    messageInput.value = '';
    messageInput.style.height = 'auto';
    sendBtn.disabled = true;
    saveConversations();
});

// ---------- AGENT TAGGING ----------

function parseAgentTag(text) {
    const match = text.match(/^@(\w+)\s+([\s\S]+)/);
    if (match) {
        const tag = match[1].toLowerCase();
        const agentKey = Object.keys(AGENTS).find(k =>
            k === tag || AGENTS[k].shortName.toLowerCase() === tag
        );
        if (agentKey) {
            return { agentKey, message: match[2] };
        }
    }
    return { agentKey: appState.currentAgent, message: text };
}

function handleTagDropdown() {
    const val = messageInput.value;
    const atMatch = val.match(/^@(\w*)$/);

    if (atMatch) {
        const filter = atMatch[1].toLowerCase();
        const matches = Object.values(AGENTS).filter(a =>
            a.key.startsWith(filter) || a.shortName.toLowerCase().startsWith(filter)
        );

        if (matches.length > 0) {
            agentTagDropdown.innerHTML = matches.map((a, i) => `
                <button class="agent-tag-option ${i === 0 ? 'focused' : ''}" data-key="${a.key}">
                    <span class="agent-tag-option-icon">${a.icon}</span>
                    <span>${a.name}</span>
                </button>
            `).join('');
            agentTagDropdown.classList.add('visible');
            appState.tagDropdownIndex = 0;

            agentTagDropdown.querySelectorAll('.agent-tag-option').forEach(opt => {
                opt.addEventListener('click', () => selectTagOption(opt.dataset.key));
            });
            return;
        }
    }

    agentTagDropdown.classList.remove('visible');
    appState.tagDropdownIndex = -1;
}

function handleTagKeyboard(e) {
    const opts = agentTagDropdown.querySelectorAll('.agent-tag-option');
    if (!opts.length) return;

    if (e.key === 'Escape') {
        e.preventDefault();
        agentTagDropdown.classList.remove('visible');
        return;
    }

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        appState.tagDropdownIndex = Math.min(appState.tagDropdownIndex + 1, opts.length - 1);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        appState.tagDropdownIndex = Math.max(appState.tagDropdownIndex - 1, 0);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        const focused = opts[appState.tagDropdownIndex];
        if (focused) selectTagOption(focused.dataset.key);
        return;
    }

    opts.forEach((o, i) => o.classList.toggle('focused', i === appState.tagDropdownIndex));
}

function selectTagOption(agentKey) {
    messageInput.value = `@${agentKey} `;
    agentTagDropdown.classList.remove('visible');
    messageInput.focus();
    sendBtn.disabled = true;
}

document.addEventListener('click', (e) => {
    if (!e.target.closest('.input-wrapper')) {
        agentTagDropdown.classList.remove('visible');
    }
});

// ---------- HANDLE SEND ----------

function handleSend() {
    const text = messageInput.value.trim();
    if (!text) return;

    const parsed = parseAgentTag(text);

    if (!parsed.agentKey) {
        // Hub view: chat with GREGORY directly
        sendMessage(parsed.message);
        return;
    }

    if (parsed.agentKey !== appState.currentAgent) {
        // Cross-agent tag: navigate first, then send
        window.location.hash = `#/${parsed.agentKey}`;
        setTimeout(() => sendMessage(parsed.message), 50);
    } else {
        sendMessage(parsed.message);
    }
}

// ---------- MARKDOWN RENDERING ----------

function renderMarkdown(text) {
    let html = text;

    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
        return `<pre><code class="lang-${lang}">${escapeHtml(code.trim())}</code></pre>`;
    });

    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');

    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');

    html = html.replace(/^---$/gm, '<hr>');

    html = html.replace(/^[\s]*[-*] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');
    html = html.replace(/<\/ul>\s*<ul>/g, '');

    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    html = html.replace(/\|(.+)\|\n\|[-| ]+\|\n((?:\|.+\|\n?)*)/g, (_, header, body) => {
        const headers = header.split('|').map(h => h.trim()).filter(Boolean);
        const rows = body.trim().split('\n').map(row =>
            row.split('|').map(c => c.trim()).filter(Boolean)
        );
        let table = '<table><thead><tr>';
        headers.forEach(h => table += `<th>${h}</th>`);
        table += '</tr></thead><tbody>';
        rows.forEach(row => {
            table += '<tr>';
            row.forEach(c => table += `<td>${c}</td>`);
            table += '</tr>';
        });
        table += '</tbody></table>';
        return table;
    });

    html = html.replace(/^(?!<[huolbtph]|<\/)(.*\S.*)$/gm, '<p>$1</p>');
    html = html.replace(/<p>\s*<\/p>/g, '');

    return html;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function escapeAttr(text) {
    return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- MESSAGES ----------

function addUserMessage(text) {
    welcomeScreen.style.display = 'none';

    const msgEl = document.createElement('div');
    msgEl.className = 'message message-user';
    msgEl.innerHTML = `
    <div class="message-avatar">You</div>
    <div class="message-content">
      <div class="message-text">${escapeHtml(text)}</div>
    </div>
  `;
    messagesDiv.appendChild(msgEl);
    scrollToBottom();
}

function createAIMessage(agentKey) {
    const agent = agentKey ? AGENTS[agentKey] : null;
    const avatarLetter = agent ? agent.avatarLetter : 'G';
    const badgeHtml = (agentKey && agentKey !== appState.currentAgent && agent)
        ? `<div class="agent-badge">${agent.icon} ${agent.shortName}</div>`
        : '';

    const msgEl = document.createElement('div');
    msgEl.className = 'message message-ai';
    msgEl.innerHTML = `
    <div class="message-avatar">${avatarLetter}</div>
    <div class="message-content">
      ${badgeHtml}
      <div class="message-text">
        <div class="typing-indicator">
          <span></span><span></span><span></span>
        </div>
      </div>
    </div>
  `;
    messagesDiv.appendChild(msgEl);
    scrollToBottom();
    return msgEl.querySelector('.message-text');
}

function scrollToBottom() {
    chatContainer.scrollTo({
        top: chatContainer.scrollHeight,
        behavior: 'smooth'
    });
}

// ---------- TOOL EVENT UI ----------

function createToolIndicator(parentEl) {
    let container = parentEl.closest('.message-content').querySelector('.tool-activity');
    if (!container) {
        container = document.createElement('div');
        container.className = 'tool-activity';
        parentEl.closest('.message-content').insertBefore(container, parentEl);
    }
    return container;
}

function showToolCallUI(parentEl, data) {
    const container = createToolIndicator(parentEl);
    const toolNames = {
        web_search: 'Searching the web',
        web_scrape: 'Reading webpage',
        financial_data: 'Fetching financial data',
        sec_filings: 'Searching SEC filings',
        google_trends: 'Checking Google Trends',
        fred_economic_data: 'Fetching FRED data',
        news_sentiment: 'Analyzing news sentiment',
        sec_company_facts: 'Fetching SEC company data',
        patent_search: 'Searching patents',
        academic_search: 'Searching academic papers',
        citation_lookup: 'Verifying citations',
        job_market: 'Searching job market',
        bls_data: 'Fetching BLS data',
        world_bank_data: 'Fetching World Bank data',
        news_search: 'Searching news',
        analyze_document: 'Analyzing document',
    };
    const label = toolNames[data.tool] || `Running ${data.tool}`;
    const detail = data.input?.query || data.input?.symbol || data.input?.url || data.input?.company || '';

    const el = document.createElement('div');
    el.className = 'tool-call-indicator';
    el.dataset.tool = data.tool;
    el.innerHTML = `
        <span class="tool-spinner"></span>
        <span class="tool-label">${escapeHtml(label)}</span>
        ${detail ? `<span class="tool-detail">${escapeHtml(String(detail).substring(0, 60))}</span>` : ''}
    `;
    container.appendChild(el);
    scrollToBottom();
}

function showToolResultUI(parentEl, data) {
    const container = parentEl.closest('.message-content').querySelector('.tool-activity');
    if (!container) return;

    const indicator = container.querySelector(`.tool-call-indicator[data-tool="${data.tool}"]`);
    if (indicator) {
        const spinner = indicator.querySelector('.tool-spinner');
        if (spinner) {
            spinner.className = data.success ? 'tool-check' : 'tool-error';
            spinner.textContent = data.success ? '\u2713' : '\u2717';
        }
        if (data.preview) {
            const previewEl = document.createElement('span');
            previewEl.className = 'tool-preview';
            previewEl.textContent = data.preview.substring(0, 80);
            indicator.appendChild(previewEl);
        }
    }
}

// ---------- RETRY & RESILIENCE ----------

const RETRY_CONFIG = {
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 8000,
    streamTimeoutMs: 60000, // 60s without data = stale connection
};

function retryDelay(attempt) {
    var delay = RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt);
    // Add jitter (±25%)
    delay += delay * (Math.random() * 0.5 - 0.25);
    return Math.min(delay, RETRY_CONFIG.maxDelayMs);
}

function showRetryIndicator(parentEl, attempt, maxAttempts) {
    var existing = parentEl.closest('.message-content').querySelector('.retry-indicator');
    if (existing) existing.remove();

    var el = document.createElement('div');
    el.className = 'retry-indicator';
    el.innerHTML = '<span class="tool-spinner"></span> Reconnecting (attempt ' + attempt + '/' + maxAttempts + ')...';
    parentEl.closest('.message-content').appendChild(el);
    scrollToBottom();
}

function removeRetryIndicator(parentEl) {
    var existing = parentEl.closest('.message-content').querySelector('.retry-indicator');
    if (existing) existing.remove();
}

async function getAuthHeaders() {
    var headers = { 'Content-Type': 'application/json' };
    if (appState.user) {
        try {
            var session = await supabaseClient.auth.getSession();
            if (session.data.session) {
                headers['Authorization'] = 'Bearer ' + session.data.session.access_token;
            }
        } catch (_e) { /* proceed without auth */ }
    }
    return headers;
}

// ---------- STREAMING ----------

async function sendMessage(text, options) {
    if (!text || appState.isStreaming) return;
    options = options || {};

    var targetAgent = appState.currentAgent;
    var conv = getConversation(targetAgent);

    // Get the system prompt to pass to the Edge Function
    var agentConfig = targetAgent ? AGENTS[targetAgent] : GREGORY_HUB;
    var systemPrompt = agentConfig ? agentConfig.systemPrompt : '';

    appState.isStreaming = true;
    messageInput.value = '';
    messageInput.style.height = 'auto';
    sendBtn.disabled = true;

    addUserMessage(text);
    var aiTextEl = createAIMessage(targetAgent);

    // Collect any attached documents
    var attachedDocs = typeof getAndClearAttachments === 'function' ? getAndClearAttachments() : [];
    var docIds = attachedDocs.map(function(d) { return d.id; });

    // If documents are attached, prepend context to the message
    var finalMessage = text;
    if (attachedDocs.length > 0) {
        var docNames = attachedDocs.map(function(d) { return d.filename; }).join(', ');
        finalMessage = '[Attached documents: ' + docNames + ' \u2014 document IDs: ' + docIds.join(', ') + ']\n\n' + text;
    }

    var payload = {
        message: finalMessage,
        history: conv ? conv.history.slice(-20) : [],
        agent: targetAgent,
        systemPrompt: systemPrompt,
    };

    if (docIds.length > 0) {
        payload.document_ids = docIds;
    } else if (options.document_ids) {
        payload.document_ids = options.document_ids;
    }

    var fullText = '';
    var attempt = 0;
    var success = false;

    while (attempt < RETRY_CONFIG.maxAttempts && !success) {
        attempt++;

        if (attempt > 1) {
            var delay = retryDelay(attempt - 1);
            showRetryIndicator(aiTextEl, attempt, RETRY_CONFIG.maxAttempts);
            await new Promise(function(r) { setTimeout(r, delay); });
        }

        try {
            var headers = await getAuthHeaders();

            var response = await fetch(EDGE_FUNCTION_URL, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(payload),
            });

            if (response.status === 429) {
                var retryAfter = response.headers.get('Retry-After');
                var waitMs = retryAfter ? parseInt(retryAfter) * 1000 : retryDelay(attempt);
                showRetryIndicator(aiTextEl, attempt, RETRY_CONFIG.maxAttempts);
                await new Promise(function(r) { setTimeout(r, waitMs); });
                continue;
            }

            if (!response.ok) {
                var err = await response.json().catch(function() { return { error: 'Unknown error' }; });
                if (attempt >= RETRY_CONFIG.maxAttempts) {
                    removeRetryIndicator(aiTextEl);
                    aiTextEl.innerHTML = '<p style="color: var(--error);">\u26A0\uFE0F ' + (err.error || 'Something went wrong. Please try again.') + '</p>';
                }
                continue;
            }

            removeRetryIndicator(aiTextEl);

            var reader = response.body.getReader();
            var decoder = new TextDecoder();
            var buffer = '';
            var currentEventType = null;
            var streamTimeout;
            var streamAborted = false;

            // Set up stream timeout detection
            function resetStreamTimeout() {
                clearTimeout(streamTimeout);
                streamTimeout = setTimeout(function() {
                    streamAborted = true;
                    try { reader.cancel(); } catch (_e) {}
                }, RETRY_CONFIG.streamTimeoutMs);
            }

            resetStreamTimeout();

            while (true) {
                var result = await reader.read();
                if (result.done || streamAborted) break;

                resetStreamTimeout();

                if (appState.currentAgent !== targetAgent) continue;

                buffer += decoder.decode(result.value, { stream: true });
                var lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (var li = 0; li < lines.length; li++) {
                    var line = lines[li];

                    // Handle named SSE events
                    if (line.startsWith('event: ')) {
                        currentEventType = line.slice(7).trim();
                        continue;
                    }

                    if (!line.startsWith('data: ')) continue;
                    var data = line.slice(6);
                    if (data === '[DONE]') continue;

                    try {
                        var parsed = JSON.parse(data);

                        switch (currentEventType) {
                            case 'tool_call':
                                showToolCallUI(aiTextEl, parsed);
                                break;

                            case 'tool_result':
                                showToolResultUI(aiTextEl, parsed);
                                break;

                            case 'plan':
                                renderPlan(parsed, aiTextEl);
                                break;

                            case 'step_update':
                                updateStepStatus(parsed);
                                break;

                            case 'checkpoint':
                                renderCheckpoint(parsed, aiTextEl);
                                break;

                            case 'agent_handoff':
                                showAgentHandoff(parsed, aiTextEl);
                                break;

                            case 'task_complete':
                                showTaskComplete(parsed, aiTextEl);
                                break;

                            case 'error':
                                if (parsed.message) {
                                    var errorEl = document.createElement('div');
                                    errorEl.className = 'tool-error-msg';
                                    errorEl.textContent = parsed.message;
                                    aiTextEl.closest('.message-content').appendChild(errorEl);
                                }
                                break;

                            default:
                                // Backward-compatible: OpenAI delta format
                                var delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.content;
                                if (delta) {
                                    fullText += delta;
                                    aiTextEl.innerHTML = renderMarkdown(fullText);
                                    scrollToBottom();
                                }
                        }

                        currentEventType = null;
                    } catch (_e) {
                        // Skip malformed JSON chunks
                    }
                }
            }

            clearTimeout(streamTimeout);

            if (streamAborted && !fullText) {
                // Stream timed out with no data — retry
                continue;
            }

            success = true;

        } catch (err) {
            console.error('GREGORY chat error (attempt ' + attempt + '):', err);
            if (attempt >= RETRY_CONFIG.maxAttempts) {
                removeRetryIndicator(aiTextEl);
                aiTextEl.innerHTML = '<p style="color: var(--error);">\u26A0\uFE0F Connection error. Please check your network and try again.</p>';
            }
        }
    }

    if (fullText) {
        aiTextEl.innerHTML = renderMarkdown(fullText);

        if (conv) {
            conv.history.push(
                { role: 'user', content: text },
                { role: 'assistant', content: fullText }
            );
            saveConversations();
        }
    } else if (success && !aiTextEl.closest('.message-content').querySelector('.tool-activity') &&
               !aiTextEl.closest('.message-content').querySelector('.task-plan')) {
        aiTextEl.innerHTML = '<p style="color: var(--text-muted);">No response received. Please try again.</p>';
    }

    appState.isStreaming = false;
    sendBtn.disabled = !messageInput.value.trim();
    scrollToBottom();
}

// ---------- INIT ----------

renderAgentNav();

(async () => {
    const { data: { session } } = await supabaseClient.auth.getSession();
    appState.user = session?.user || null;
    renderAuthUI();
    await loadConversations();
    handleRoute();
    messageInput.focus();
})();
