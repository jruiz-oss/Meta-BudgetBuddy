/**
 * ChiefWidget
 * -----------
 * Floating chat button + panel for Chief, a read-only assistant that answers
 * simple fact questions (flight dates, budget used, spend, clicks). It never
 * changes anything and gives no optimization advice; the backend enforces both.
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
import { Send, X } from 'lucide-react';
import './ChiefWidget.css';

// Pages where a quick fact check makes sense. Login, Register, Docs, Settings,
// History and the Accounts setup page are intentionally left out.
const SHOW_ON = [
  '/',
  '/account/:accountId',
  '/account/:accountId/campaign/:campaignId',
];

const GREETING =
  "Hi, I'm Chief. Ask me quick facts, like when a flight ends, how much a campaign has spent, or how many clicks it got on a day. I only look things up. I can't change anything or give advice.";

const SUGGESTIONS = ['Which flights end today?', 'Is anything close to max spend?'];

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
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(null); // null = unknown yet
  const [messages, setMessages] = useState([]); // [{ role, content, error? }]
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const inputRef = useRef(null);
  const endRef = useRef(null);

  const route = useMemo(() => {
    for (const p of SHOW_ON) {
      const m = matchPath({ path: p, end: true }, location.pathname);
      if (m) return m;
    }
    return null;
  }, [location.pathname]);

  // Ask once, when the panel first opens, whether the server has a key.
  useEffect(() => {
    if (!open || enabled !== null) return;
    axios.get('/api/chief/status')
      .then((r) => setEnabled(!!r.data.enabled))
      .catch(() => setEnabled(true)); // let the real call report the problem
  }, [open, enabled]);

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  useEffect(() => {
    if (endRef.current) endRef.current.scrollIntoView({ block: 'end' });
  }, [messages, sending, open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!route) return null;

  const send = async (text) => {
    const content = (text ?? input).trim();
    if (!content || sending) return;
    const next = [...messages, { role: 'user', content }];
    setMessages(next);
    setInput('');
    setSending(true);
    const params = route.params || {};
    try {
      const { data } = await axios.post('/api/chief/chat', {
        // Errors are display-only; never send them back as history.
        messages: next.filter((m) => !m.error).slice(-10).map(({ role, content: c }) => ({ role, content: c })),
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        page: {
          account_id: params.accountId ? Number(params.accountId) : null,
          campaign_id: params.campaignId ? Number(params.campaignId) : null,
        },
      }, { timeout: 90000 });
      setMessages((m) => [...m, { role: 'assistant', content: data.reply }]);
    } catch (err) {
      const msg = err?.response?.data?.error
        || (err?.code === 'ECONNABORTED' ? 'That took too long. Try again.' : "I couldn't reach the server. Try again in a moment.");
      setMessages((m) => [...m, { role: 'assistant', content: msg, error: true }]);
    } finally {
      setSending(false);
    }
  };

  const onSubmit = (e) => { e.preventDefault(); send(); };

  return (
    <>
      {open && (
        <section className="chief-panel" role="dialog" aria-label="Chat with Chief">
          <header className="chief-head">
            <Avatar size={34} working={sending} />
            <div className="chief-head-text">
              <div className="chief-name">Chief</div>
              <div className="chief-sub">Quick fact checks. Read only.</div>
            </div>
            <button type="button" className="chief-close" onClick={() => setOpen(false)} aria-label="Close chat">
              <X size={16} />
            </button>
          </header>

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
        </section>
      )}

      <button
        type="button"
        className={'chief-fab' + (open ? ' is-open' : '') + (sending ? ' is-working' : '')}
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? 'Close Chief' : 'Open Chief, quick fact checks'}
        aria-expanded={open}
      >
        <Avatar size={56} working={sending} />
      </button>
    </>
  );
}
