/**
 * ChiefWidget
 * -----------
 * Floating chat button + panel for Chief, a read-only assistant that answers
 * simple fact questions (flight dates, budget used, spend, clicks). It never
 * changes anything and gives no optimization advice; the backend enforces both.
 *
 * Chats are saved in this browser's localStorage (no backend or DB change).
 * Closing the panel keeps the current chat. "New chat" starts a fresh one and
 * the old one stays in the history list until you delete it. A new chat is only
 * saved once you send the first message, so you never collect empty chats.
 *
 * Backend: GET /api/chief/status, POST /api/chief/chat (see backend/routes/chief.py).
 * Avatar: /chief.jpg from frontend/public. Falls back to a plain "C" badge if the
 * file is missing so a missing photo never shows a broken image.
 *
 * Shown only on pages where it applies (SHOW_ON). Everything else hides it.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { matchPath, useLocation } from 'react-router-dom';
import axios from 'axios';
import { ArrowLeft, History, Plus, Send, Trash2, X } from 'lucide-react';
import './ChiefWidget.css';

// Pages where a quick fact check makes sense. Login, Register, Docs, Settings,
// History and the Accounts setup page are intentionally left out.
const SHOW_ON = [
  '/',
  '/account/:accountId',
  '/account/:accountId/campaign/:campaignId',
];

const GREETING = "Woof, I'm Chief.";

const SUGGESTIONS = ['Which flights end today?', 'Is anything close to max spend?'];

const STORE_KEY = 'bb.chief.chats.v1';
const MAX_CHATS = 30;
const MAX_MESSAGES = 100;

// Saved shape: { chats: [{ id, title, createdAt, updatedAt, messages: [{ role, content }] }], activeId }
function loadStore() {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return { chats: [], activeId: null };
    const data = JSON.parse(raw);
    const chats = (Array.isArray(data.chats) ? data.chats : []).filter(
      (c) => c && typeof c.id === 'string' && Array.isArray(c.messages),
    );
    return { chats, activeId: chats.some((c) => c.id === data.activeId) ? data.activeId : null };
  } catch {
    return { chats: [], activeId: null };
  }
}

function saveStore(chats, activeId) {
  try {
    const trimmed = [...chats]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_CHATS)
      // Error bubbles are display-only, so they are not worth keeping.
      .map((c) => ({ ...c, messages: c.messages.filter((m) => !m.error).slice(-MAX_MESSAGES) }));
    window.localStorage.setItem(STORE_KEY, JSON.stringify({
      chats: trimmed,
      activeId: trimmed.some((c) => c.id === activeId) ? activeId : null,
    }));
  } catch {
    // Storage full or blocked (private mode). Chat still works, it just won't survive a reload.
  }
}

function newId() {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeTitle(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 42 ? `${t.slice(0, 42).trimEnd()}...` : t;
}

function whenLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function Avatar({ size = 36, working = false }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={'chief-avatar' + (working ? ' is-working' : '')} style={{ width: size, height: size }}>
      {failed ? (
        <span className="chief-avatar-fallback" aria-hidden="true">C</span>
      ) : (
        <img src="/chief.jpg" alt="" onError={() => setFailed(true)} draggable={false} />
      )}
    </span>
  );
}

export default function ChiefWidget() {
  const location = useLocation();
  const [initial] = useState(loadStore);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState('chat'); // 'chat' | 'list'
  const [enabled, setEnabled] = useState(null); // null = unknown yet
  const [chats, setChats] = useState(initial.chats);
  const [activeId, setActiveId] = useState(initial.activeId); // null = fresh chat, not saved yet
  const [pending, setPending] = useState([]); // chat ids waiting on a reply
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [input, setInput] = useState('');
  const inputRef = useRef(null);
  const endRef = useRef(null);

  const activeChat = useMemo(() => chats.find((c) => c.id === activeId) || null, [chats, activeId]);
  const messages = activeChat ? activeChat.messages : [];
  const sending = activeId !== null && pending.includes(activeId);
  const sortedChats = useMemo(() => [...chats].sort((a, b) => b.updatedAt - a.updatedAt), [chats]);

  const route = useMemo(() => {
    for (const p of SHOW_ON) {
      const m = matchPath({ path: p, end: true }, location.pathname);
      if (m) return m;
    }
    return null;
  }, [location.pathname]);

  // Save on every change.
  useEffect(() => { saveStore(chats, activeId); }, [chats, activeId]);

  // Ask once, when the panel first opens, whether the server has a key.
  useEffect(() => {
    if (!open || enabled !== null) return;
    axios.get('/api/chief/status')
      .then((r) => setEnabled(!!r.data.enabled))
      .catch(() => setEnabled(true)); // let the real call report the problem
  }, [open, enabled]);

  useEffect(() => {
    if (open && view === 'chat' && inputRef.current) inputRef.current.focus();
  }, [open, view, activeId]);

  useEffect(() => {
    if (endRef.current) endRef.current.scrollIntoView({ block: 'end' });
  }, [messages, sending, open, view, activeId]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!route) return null;

  // Update one chat by id. A no-op if it was deleted while a reply was in flight.
  const patchChat = (id, fn) => {
    setChats((cs) => cs.map((c) => (c.id === id
      ? { ...c, updatedAt: Date.now(), messages: fn(c.messages) }
      : c)));
  };

  const startNewChat = () => {
    setActiveId(null);
    setView('chat');
    setInput('');
    setConfirmDeleteId(null);
  };

  const openChat = (id) => {
    setActiveId(id);
    setView('chat');
    setInput('');
    setConfirmDeleteId(null);
  };

  const deleteChat = (id) => {
    if (confirmDeleteId !== id) { setConfirmDeleteId(id); return; }
    setChats((cs) => cs.filter((c) => c.id !== id));
    if (activeId === id) setActiveId(null);
    setConfirmDeleteId(null);
  };

  const send = async (text) => {
    const content = (text ?? input).trim();
    if (!content || sending) return;

    const userMsg = { role: 'user', content };
    let chatId = activeId;
    let history;
    if (chatId === null) {
      chatId = newId();
      history = [userMsg];
      const now = Date.now();
      setChats((cs) => [...cs, { id: chatId, title: makeTitle(content), createdAt: now, updatedAt: now, messages: history }]);
      setActiveId(chatId);
    } else {
      history = [...messages, userMsg];
      patchChat(chatId, (ms) => [...ms, userMsg]);
    }
    setInput('');
    setPending((p) => [...p, chatId]);

    const params = route.params || {};
    try {
      const { data } = await axios.post('/api/chief/chat', {
        // Errors are display-only; never send them back as history.
        messages: history.filter((m) => !m.error).slice(-10).map(({ role, content: c }) => ({ role, content: c })),
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        page: {
          account_id: params.accountId ? Number(params.accountId) : null,
          campaign_id: params.campaignId ? Number(params.campaignId) : null,
        },
      }, { timeout: 90000 });
      patchChat(chatId, (ms) => [...ms, { role: 'assistant', content: data.reply }]);
    } catch (err) {
      const msg = err?.response?.data?.error
        || (err?.code === 'ECONNABORTED' ? 'That took too long. Try again.' : "I couldn't reach the server. Try again in a moment.");
      patchChat(chatId, (ms) => [...ms, { role: 'assistant', content: msg, error: true }]);
    } finally {
      setPending((p) => {
        const i = p.indexOf(chatId);
        return i === -1 ? p : [...p.slice(0, i), ...p.slice(i + 1)];
      });
    }
  };

  const onSubmit = (e) => { e.preventDefault(); send(); };

  const inList = view === 'list';

  return (
    <>
      {open && (
        <section className="chief-panel" role="dialog" aria-label="Chat with Chief">
          <header className="chief-head">
            {inList ? (
              <button type="button" className="chief-iconbtn" onClick={() => setView('chat')} aria-label="Back to chat">
                <ArrowLeft size={16} />
              </button>
            ) : (
              <Avatar size={34} working={pending.length > 0} />
            )}
            <div className="chief-head-text">
              <div className="chief-name">{inList ? 'Chats' : 'Chief'}</div>
              <div className="chief-sub">
                {inList ? 'Saved in this browser' : 'Quick fact checks. Read only.'}
              </div>
            </div>
            {!inList && (
              <>
                <button type="button" className="chief-iconbtn" onClick={() => setView('list')} aria-label="Chat history" title="Chat history">
                  <History size={16} />
                </button>
                <button
                  type="button"
                  className="chief-iconbtn"
                  onClick={startNewChat}
                  disabled={activeId === null}
                  aria-label="New chat"
                  title="New chat"
                >
                  <Plus size={16} />
                </button>
              </>
            )}
            <button type="button" className="chief-iconbtn" onClick={() => setOpen(false)} aria-label="Close chat">
              <X size={16} />
            </button>
          </header>

          {inList ? (
            <div className="chief-body chief-list">
              <button type="button" className="chief-newchat" onClick={startNewChat}>
                <Plus size={15} /> New chat
              </button>
              {sortedChats.length === 0 && (
                <p className="chief-empty">No saved chats yet. Ask Chief something and it shows up here.</p>
              )}
              {sortedChats.map((c) => (
                <div key={c.id} className={'chief-item' + (c.id === activeId ? ' is-active' : '')}>
                  <button type="button" className="chief-item-main" onClick={() => openChat(c.id)}>
                    <span className="chief-item-title">{c.title || 'New chat'}</span>
                    <span className="chief-item-meta">
                      {c.messages.filter((m) => !m.error).length} messages, {whenLabel(c.updatedAt)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={'chief-item-del' + (confirmDeleteId === c.id ? ' is-confirm' : '')}
                    onClick={() => deleteChat(c.id)}
                    onBlur={() => setConfirmDeleteId((id) => (id === c.id ? null : id))}
                    aria-label={confirmDeleteId === c.id ? 'Click again to delete this chat' : 'Delete chat'}
                    title={confirmDeleteId === c.id ? 'Click again to delete' : 'Delete chat'}
                  >
                    {confirmDeleteId === c.id ? 'Delete?' : <Trash2 size={14} />}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <>
              <div className="chief-body" aria-live="polite">
                <div className="chief-row chief-row-bot">
                  <Avatar size={26} />
                  <div className="chief-bubble chief-bubble-bot">{GREETING}</div>
                </div>

                {enabled === false && (
                  <div className="chief-row chief-row-bot">
                    <Avatar size={26} />
                    <div className="chief-bubble chief-bubble-bot chief-bubble-error">
                      I'm not set up yet. The server needs an Anthropic API key before I can answer.
                    </div>
                  </div>
                )}

                {messages.length === 0 && enabled !== false && (
                  <div className="chief-chips">
                    {SUGGESTIONS.map((s) => (
                      <button key={s} type="button" className="chief-chip" onClick={() => send(s)}>{s}</button>
                    ))}
                  </div>
                )}

                {messages.map((m, i) => (
                  <div key={i} className={'chief-row ' + (m.role === 'user' ? 'chief-row-user' : 'chief-row-bot')}>
                    {m.role !== 'user' && <Avatar size={26} />}
                    <div className={'chief-bubble ' + (m.role === 'user' ? 'chief-bubble-user' : 'chief-bubble-bot')
                      + (m.error ? ' chief-bubble-error' : '')}>
                      {m.content}
                    </div>
                  </div>
                ))}

                {sending && (
                  <div className="chief-row chief-row-bot">
                    <Avatar size={26} working />
                    <div className="chief-bubble chief-bubble-bot chief-typing" aria-label="Chief is looking that up">
                      <span /><span /><span />
                    </div>
                  </div>
                )}
                <div ref={endRef} />
              </div>

              <form className="chief-form" onSubmit={onSubmit}>
                <input
                  ref={inputRef}
                  className="chief-input"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Ask a quick question"
                  maxLength={1000}
                  aria-label="Message to Chief"
                  disabled={enabled === false}
                />
                <button type="submit" className="chief-send" disabled={!input.trim() || sending || enabled === false} aria-label="Send">
                  <Send size={16} />
                </button>
              </form>
            </>
          )}
        </section>
      )}

      <button
        type="button"
        className={'chief-fab' + (open ? ' is-open' : '') + (pending.length > 0 ? ' is-working' : '')}
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? 'Close Chief' : 'Open Chief, quick fact checks'}
        aria-expanded={open}
      >
        <Avatar size={56} working={pending.length > 0} />
      </button>
    </>
  );
}
