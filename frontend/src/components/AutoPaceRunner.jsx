/**
 * AutoPaceRunner
 * --------------
 * Fires once per browser session after the user is authenticated. Loops through
 * every account in the shared workspace, hits POST /api/pacing/<id>/run for
 * each, and renders a blocking modal with a progress bar + per-account status
 * list. On any single-account failure it keeps going and surfaces a summary
 * toast at the end.
 *
 * The modal has a "Run in background" button that shrinks it into a compact
 * floating widget (top-right, non-blocking) so users can navigate freely
 * while pacing continues. Clicking the widget re-expands the full modal.
 *
 * Gating: sessionStorage key `bb-autopaced`. Cleared automatically when the
 * browser/tab closes. Set as soon as the run starts (not after it finishes) so
 * a page refresh mid-run won't kick off a second pass.
 *
 * NOTE: this duplicates work that the daily 06:00 UTC cron already does. The
 * sessionStorage gate keeps the cost bounded to one fan-out per workspace
 * session, but heavy accounts can take 60s+ each (axios timeout) — be aware
 * the modal could sit open for a couple minutes on workspaces with many
 * accounts.
 */
import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Check, AlertCircle, Activity, Minimize2, Maximize2 } from 'lucide-react';
import { useToast } from './Toast';

const SESSION_FLAG = 'bb-autopaced';

export default function AutoPaceRunner({ user }) {
  const toast = useToast();
  const startedRef = useRef(false);
  const [minimized, setMinimized] = useState(false);
  const [state, setState] = useState({
    open: false,
    total: 0,
    current: 0,             // index of account currently being paced (0-based)
    currentName: '',
    results: [],            // [{ name, status: 'ok' | 'error' }]
  });

  useEffect(() => {
    if (!user) return;
    if (startedRef.current) return;
    if (sessionStorage.getItem(SESSION_FLAG)) return;
    startedRef.current = true;
    // Set the flag immediately so a mid-run refresh doesn't fire a second pass.
    sessionStorage.setItem(SESSION_FLAG, '1');
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const run = async () => {
    // Pull the account list. If this fails, bail silently — never trap the
    // user behind a broken modal.
    let accounts = [];
    try {
      const { data } = await axios.get('/api/accounts');
      accounts = data.accounts || [];
    } catch (err) {
      return;
    }

    if (accounts.length === 0) return;

    setState({
      open: true,
      total: accounts.length,
      current: 0,
      currentName: accounts[0].account_name,
      results: [],
    });

    const results = [];
    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      setState((s) => ({
        ...s,
        current: i,
        currentName: acc.account_name,
      }));

      try {
        await axios.post(`/api/pacing/${acc.id}/run`);
        results.push({ name: acc.account_name, status: 'ok' });
      } catch (err) {
        results.push({ name: acc.account_name, status: 'error' });
      }

      setState((s) => ({
        ...s,
        current: i + 1,
        results: [...results],
      }));
    }

    // Close modal/widget, then surface summary toast.
    setState((s) => ({ ...s, open: false }));
    setMinimized(false);

    const ok = results.filter((r) => r.status === 'ok').length;
    const failed = results.length - ok;
    if (failed === 0) {
      toast.success(`Paced ${ok} account${ok === 1 ? '' : 's'}.`);
    } else if (ok === 0) {
      toast.error(`Auto-pace failed for all ${failed} account${failed === 1 ? '' : 's'}.`);
    } else {
      toast.warn(`Paced ${ok} of ${results.length} accounts — ${failed} failed. Check History.`);
    }
  };

  if (!state.open) return null;

  const pct = state.total > 0 ? Math.min(100, Math.round((state.current / state.total) * 100)) : 0;

  // ── Minimized floating widget (top-right, non-blocking) ──────────
  if (minimized) {
    return (
      <div className="bb-autopace-float" role="status" aria-label="Pacing in progress">
        <div className="bb-autopace-float-header">
          <Activity size={13} className="bb-autopace-float-icon" />
          <span className="bb-autopace-float-title">
            Pacing accounts…
          </span>
          <span className="bb-autopace-float-count">{state.current}/{state.total}</span>
          <button
            className="bb-autopace-float-btn"
            onClick={() => setMinimized(false)}
            title="Expand"
            aria-label="Expand pacing modal"
          >
            <Maximize2 size={12} />
          </button>
        </div>
        <div className="bb-autopace-float-name">
          {state.currentName || 'Starting…'}
        </div>
        <div className="bb-autopace-float-bar" aria-hidden="true">
          <div className="bb-autopace-bar-fill" style={{ width: `${pct}%` }} />
          <div className="bb-autopace-bar-shimmer" />
        </div>
      </div>
    );
  }

  // ── Full modal (blocking) ─────────────────────────────────────────
  return (
    <div className="bb-modal-backdrop" style={{ zIndex: 1100 }}>
      <div className="bb-modal" style={{ maxWidth: 520 }}>
        <div className="bb-modal-head">
          <div className="bb-modal-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Activity size={16} />
            Pacing all accounts
          </div>
          <button
            className="bb-btn bb-btn-ghost"
            style={{ fontSize: 12, padding: '4px 10px', display: 'flex', alignItems: 'center', gap: 5 }}
            onClick={() => setMinimized(true)}
            title="Run in background"
          >
            <Minimize2 size={13} />
            Run in background
          </button>
        </div>
        <div className="bb-modal-body">
          <p className="bb-muted" style={{ marginTop: 0, marginBottom: 14 }}>
            Running a fresh pacing pass on every account before you start.
            You can minimize this and navigate freely — it'll finish in the background.
          </p>

          <div className="bb-autopace-bar" aria-label="Pacing progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="bb-autopace-bar-fill" style={{ width: `${pct}%` }} />
            <div className="bb-autopace-bar-shimmer" />
          </div>

          <div className="bb-row-between" style={{ marginTop: 10, fontSize: 12 }}>
            <span>
              {state.currentName ? (
                <>Pacing: <strong>{state.currentName}</strong></>
              ) : (
                'Starting…'
              )}
            </span>
            <span className="bb-muted">
              {state.current} of {state.total}
            </span>
          </div>

          {state.results.length > 0 && (
            <ul className="bb-autopace-list">
              {state.results.map((r, i) => (
                <li key={i} className="bb-autopace-item">
                  {r.status === 'ok' ? (
                    <Check size={14} className="bb-autopace-icon-ok" />
                  ) : (
                    <AlertCircle size={14} className="bb-autopace-icon-err" />
                  )}
                  <span style={{ flex: 1 }}>{r.name}</span>
                  {r.status === 'error' && <span className="bb-muted">failed</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="bb-modal-foot">
          <button
            className="bb-btn bb-btn-secondary"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            onClick={() => setMinimized(true)}
          >
            <Minimize2 size={13} />
            Run in background
          </button>
        </div>
      </div>
    </div>
  );
}
