import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { getCached, isStale, setCached, invalidateCache } from '../cache';
import { Loader2, AlertCircle, RotateCcw, X } from 'lucide-react';
import Sidebar from '../components/Sidebar';
import { SkeletonStatTile, SkeletonAccountBlock } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';
import { useToast } from '../components/Toast';

// ── Inline icons (no extra bundle cost) ──────────────────────
const IPlay = () => (
  <svg width={13} height={13} viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8z"/></svg>
);
const ILogout = () => (
  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>
  </svg>
);
const ISearch = () => (
  <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>
  </svg>
);
const IAlert = () => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 9v4M12 17h.01"/><path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
  </svg>
);
const IChevron = ({ collapsed }) => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    style={{ transition: 'transform 0.18s', transform: collapsed ? 'rotate(-90deg)' : 'rotate(0)' }}>
    <path d="m6 9 6 6 6-6"/>
  </svg>
);
const ICheck = () => (
  <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6 9 17l-5-5"/>
  </svg>
);
const IArrowUp = () => (
  <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m12 19 0-14M5 12l7-7 7 7"/>
  </svg>
);
const IArrowDown = () => (
  <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m12 5 0 14M19 12l-7 7-7-7"/>
  </svg>
);
const ITrendUp = () => (
  <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m3 17 6-6 4 4 8-8"/><path d="M14 7h7v7"/>
  </svg>
);
const ITrendDown = () => (
  <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m3 7 6 6 4-4 8 8"/><path d="M14 17h7v-7"/>
  </svg>
);
const IArrowRight = () => (
  <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12h14M13 5l7 7-7 7"/>
  </svg>
);
const IArrowSub = () => (
  <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 4v8a3 3 0 0 0 3 3h11"/><path d="m15 11 4 4-4 4"/>
  </svg>
);
const IFileText = () => (
  <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
  </svg>
);

// ── Notes popover — anchors to the cell, not center screen ───────
function NotesPopover({ notes, onClose, anchorRef }) {
  const popRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!anchorRef?.current || !popRef.current) return;
    const cell = anchorRef.current.getBoundingClientRect();
    const pop  = popRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    let left = cell.left;
    // Clamp so popover doesn't overflow right edge
    if (left + pop.width + 12 > vw) left = Math.max(8, vw - pop.width - 12);
    // getBoundingClientRect() is viewport-relative; position: fixed is also
    // viewport-relative. Do NOT add window.scrollY here — it would push the
    // popover off-screen by the scroll amount whenever the page is scrolled.
    setPos({ top: cell.bottom + 6, left });
  }, [anchorRef]);

  useEffect(() => {
    const handler = (e) => {
      if (popRef.current && !popRef.current.contains(e.target) &&
          anchorRef?.current && !anchorRef.current.contains(e.target)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose, anchorRef]);

  return (
    <div
      ref={popRef}
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        zIndex: 9999,
        background: 'var(--bb-surface)',
        border: '1px solid var(--bb-line)',
        borderRadius: 'var(--bb-radius)',
        boxShadow: '0 4px 18px rgba(0,0,0,0.18)',
        padding: '12px 14px',
        maxWidth: 340,
        minWidth: 180,
        fontSize: 'var(--bb-text-sm)',
        color: 'var(--bb-fg)',
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
        <span style={{ fontWeight: 600, fontSize: 'var(--bb-text-xs)', color: 'var(--bb-mute)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Sheet Notes</span>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--bb-mute)', padding: 0, lineHeight: 1 }}
        >
          <X size={12} />
        </button>
      </div>
      {notes}
    </div>
  );
}

// ── Inline notes cell with expand trigger ────────────────────────
function NotesCell({ notes }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  if (!notes) return <span style={{ color: 'var(--bb-mute)' }}>—</span>;
  const snippet = notes.length > 38 ? notes.slice(0, 38).trimEnd() + '…' : notes;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: 160 }}>
      <span style={{ color: 'var(--bb-fg-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--bb-text-xs)' }}>
        {snippet}
      </span>
      {notes.length > 0 && (
        <button
          ref={btnRef}
          onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--bb-accent)', padding: 0, display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}
          title="Expand notes"
        >
          <IFileText />
        </button>
      )}
      {open && <NotesPopover notes={notes} onClose={() => setOpen(false)} anchorRef={btnRef} />}
    </span>
  );
}

// ── Helpers ──────────────────────────────────────────────────
const fmt$ = (n, dec = 0) =>
  `$${(n || 0).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;

const fmtMo = (n) => `${fmt$(n)}/mo`;

const timeAgo = (isoStr) => {
  if (!isoStr) return 'Never';
  const diff = Date.now() - new Date(isoStr + 'Z').getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 2)  return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
};

// Map status → tone color CSS variable
function statusTone(status, paceRatio) {
  const s = (status || '').toUpperCase();
  if (s === 'ON_PACE') return 'var(--bb-ok)';
  if (s === 'INCREASE') return 'var(--bb-warn-cool)';
  if (s === 'DECREASE') return 'var(--bb-warn)';
  return 'var(--bb-mute)';
}

function statusLabel(status, paceRatio) {
  const s = (status || '').toUpperCase();
  const pct = Math.round(Math.abs(((paceRatio || 0) - 1) * 100));
  if (s === 'ON_PACE') return 'On pace';
  if (s === 'INCREASE') return `${pct}% under`;
  if (s === 'DECREASE') return `${pct}% over`;
  return '—';
}

function StatusPill({ status, paceRatio }) {
  const tone = statusTone(status, paceRatio);
  const label = statusLabel(status, paceRatio);
  const s = (status || '').toUpperCase();
  const Icon = s === 'ON_PACE' ? ICheck : s === 'INCREASE' ? ITrendUp : ITrendDown;
  return (
    <span className="bb-status" style={{ '--bb-tone': tone }}>
      <Icon />{label}
    </span>
  );
}

function ChangeBadge({ pct }) {
  if (pct == null || Math.abs(pct) < 0.5) return null;
  if (pct > 0) return (
    <span className="bb-delta up"><IArrowUp />{pct.toFixed(1)}%</span>
  );
  return (
    <span className="bb-delta down"><IArrowDown />{Math.abs(pct).toFixed(1)}%</span>
  );
}

// ── Account section with collapse ────────────────────────────
function AccountSection({ acct, applying, skipped, results, search,
  onApplyCbo, onApplyAdset, onSkip, onUnskip, onApplyAll, onEditAlloc }) {
  const [collapsed, setCollapsed] = useState(false);

  const q = search.trim().toLowerCase();

  // Filter campaigns based on search
  const filteredCampaigns = useMemo(() => {
    if (!q) return acct.campaigns;
    return acct.campaigns.reduce((acc, c) => {
      const mode = c.budget_mode || 'CBO';
      if ((c.campaign_name || '').toLowerCase().includes(q)) {
        acc.push(c); return acc;
      }
      if (mode === 'ABO') {
        const matchedAdsets = (c.adsets || []).filter(
          a => (a.adset_name || '').toLowerCase().includes(q)
        );
        if (matchedAdsets.length) acc.push({ ...c, adsets: matchedAdsets });
      }
      return acc;
    }, []);
  }, [acct.campaigns, q]);

  // Detect accounts where nothing is actually running right now
  // Triggers when: all campaigns have ended flights OR no campaign has pacing data
  const nothingRunningAlert = useMemo(() => {
    if (acct.campaigns.length === 0) return null;
    const today = new Date().toISOString().slice(0, 10);
    const activeCampaigns = acct.campaigns.filter(c => {
      if (c.flight_type === 'ALWAYS_ON') return true;
      if (c.flight_type === 'LIMITED') {
        const end = c.flight_end_date;
        const start = c.flight_start_date;
        if (!end) return true; // no end date = assume active
        if (end < today) return false; // flight ended
        if (start && start > today) return false; // not started yet
        return true;
      }
      return true;
    });
    // All flights have ended
    if (activeCampaigns.length === 0) {
      return { type: 'ended', msg: 'All campaign flights have ended. No pacing will run until a flight is active.' };
    }
    // No campaign has any pacing data at all
    const hasPacingData = acct.campaigns.some(c => {
      if ((c.budget_mode || 'CBO') === 'ABO') return (c.adsets || []).some(a => a.latest_pacing);
      return !!c.latest_pacing;
    });
    if (!hasPacingData) {
      return { type: 'no_data', msg: 'No pacing data yet. Run pacing to get recommendations for this account.' };
    }
    return null;
  }, [acct.campaigns]);

  // Sheet budget match status for title color-coding.
  // 'none'    = sheet configured, 0 campaigns matched → red
  // 'partial' = sheet configured, some campaigns unmatched → yellow
  // null      = no sheet, or all matched (no indicator)
  const sheetStatus = useMemo(() => {
    if (!acct.has_sheet) return null;
    const stats = acct.sheet_sync_stats;
    if (!stats) return null; // no sync data yet — no indicator
    if (stats.matched === 0) return 'none';
    if (stats.matched < stats.total) return 'partial';
    return null;
  }, [acct.has_sheet, acct.sheet_sync_stats]);

  // Count actionable items — must be BEFORE any early return (hooks must be unconditional)
  const actionableCount = useMemo(() => {
    let n = 0;
    acct.campaigns.forEach(c => {
      if ((c.budget_mode || 'CBO') === 'ABO') {
        (c.adsets || []).forEach(a => {
          const alp = a.latest_pacing;
          const action = (alp?.action || alp?.status || '').toUpperCase();
          const rk = `a-${a.id}`;
          if (alp && action !== 'ON_PACE' && !results[rk]?.ok && !skipped[rk]) n++;
        });
      } else {
        const lp = c.latest_pacing;
        const rk = `c-${c.id}`;
        if (lp && (lp.status || '').toUpperCase() !== 'ON_PACE' && !results[rk]?.ok && !skipped[rk]) n++;
      }
    });
    return n;
  }, [acct.campaigns, results, skipped]);

  // Early return after all hooks
  const campaignsToShow = q && !acct.account_name.toLowerCase().includes(q) ? filteredCampaigns : acct.campaigns;
  if (q && !acct.account_name.toLowerCase().includes(q) && filteredCampaigns.length === 0) return null;

  const totalBudget = acct.campaigns.reduce((s, c) => s + (c.monthly_budget || 0), 0);
  const totalSpend  = acct.campaigns.reduce((s, c) => {
    const lp = c.latest_pacing;
    return s + (lp ? Number(lp.actual_spend) || 0 : 0);
  }, 0);

  return (
    <section className={'bb-acct' + (collapsed ? ' bb-acct-collapsed' : '')}
      style={{ '--acct-hue': (parseInt(acct.id, 10) * 137 + 43) % 360 }}>

      <header className="bb-acct-head" onClick={() => setCollapsed(c => !c)}>
        <div className="bb-acct-bar" />
        <div className="bb-flex-col">
          <div className={`bb-acct-title${sheetStatus ? ` bb-acct-title-sheet-${sheetStatus}` : ''}`}>{acct.account_name}</div>
          <div className="bb-acct-meta">
            Last run: <strong>{timeAgo(acct.last_run)}</strong>
            {(acct.hidden_count || 0) > 0 && (
              <><span>·</span><span>{acct.hidden_count} hidden</span></>
            )}
          </div>
        </div>

        <div className="bb-acct-spacer" />

        <div className="bb-acct-stats">
          <div>
            <div className="bb-stat-label">Budget</div>
            <div className="bb-stat-val">{totalBudget >= 1000 ? `$${(totalBudget/1000).toFixed(totalBudget >= 10000 ? 0 : 1)}k` : fmt$(totalBudget)}</div>
          </div>
          <div>
            <div className="bb-stat-label">MTD</div>
            <div className="bb-stat-val">{totalSpend >= 1000 ? `$${(totalSpend/1000).toFixed(1)}k` : fmt$(totalSpend, 2)}</div>
          </div>
          <div>
            <div className="bb-stat-label">Actionable</div>
            <div className="bb-stat-val" style={{ color: actionableCount > 0 ? 'var(--bb-warn)' : 'var(--bb-mute)' }}>
              {actionableCount}
            </div>
          </div>
        </div>

        {actionableCount > 0 && (
          <button
            className="bb-btn bb-btn-sm bb-btn-primary"
            onClick={e => { e.stopPropagation(); onApplyAll(acct); }}
          >
            <ICheck /> Apply all ({actionableCount})
          </button>
        )}

        <Link to={`/account/${acct.id}`} className="bb-dash-link" onClick={e => e.stopPropagation()}>
          Dashboard <IArrowRight />
        </Link>
        <span className="bb-chevron"><IChevron collapsed={collapsed} /></span>
      </header>

      {!collapsed && (
        campaignsToShow.length === 0 ? (
          <div style={{ padding: '20px 18px', color: 'var(--bb-mute)', fontSize: 'var(--bb-text-sm)' }}>
            No campaigns tracked for this account.
          </div>
        ) : (
          <>
          {nothingRunningAlert && (
            <div className={`bb-alert ${nothingRunningAlert.type === 'ended' ? 'bb-alert-warn' : 'bb-alert-info'}`}
              style={{ margin: '0 0 0 0', borderRadius: 0, borderLeft: 'none', borderRight: 'none', borderTop: 'none' }}>
              <IAlert /> {nothingRunningAlert.msg}
            </div>
          )}
          <table className="bb-table">
            <thead>
              <tr>
                <th>Campaign / Ad Set</th>
                <th>Mode</th>
                <th className="num">Budget</th>
                <th className="num">MTD Spend</th>
                <th className="num">Pace</th>
                <th className="num">Current Daily</th>
                <th className="num">Rec. Daily</th>
                <th>Status</th>
                <th>Notes</th>
                <th style={{ width: 1 }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {campaignsToShow.flatMap(campaign => {
                const mode = campaign.budget_mode || 'CBO';
                if (mode === 'ABO') {
                  const lp = campaign.latest_pacing;
                  const unmatched = acct.has_sheet && campaign.sheet_budget_matched === false;
                  const parentRow = (
                    <tr key={`c-${campaign.id}`} style={{ background: 'var(--bb-surface-2)' }}
                      className={unmatched ? 'bb-row-sheet-unmatched' : ''}>
                      <td>
                        <div className="bb-row-name">
                          <Link to={`/account/${acct.id}/campaign/${campaign.id}`}
                            style={{ fontWeight: 600, color: 'var(--bb-fg)' }}>
                            {campaign.campaign_name}
                          </Link>
                        </div>
                      </td>
                      <td><span className="bb-mode bb-mode-abo">ABO</span></td>
                      <td className="num">{unmatched ? <span style={{ color: 'var(--bb-mute)' }}>—</span> : fmtMo(campaign.monthly_budget)}</td>
                      <td className="num">{lp ? fmt$(lp.actual_spend, 2) : '—'}</td>
                      <td className="num">{lp ? `${(lp.pace_ratio || 0).toFixed(2)}x` : '—'}</td>
                      <td className="num" style={{ color: 'var(--bb-mute)' }}>—</td>
                      <td className="num" style={{ color: 'var(--bb-mute)' }}>—</td>
                      <td>
                        {lp ? <StatusPill status={lp.status} paceRatio={lp.pace_ratio} /> : null}
                      </td>
                      <td><NotesCell notes={campaign.sheet_notes || ''} /></td>
                      <td><span style={{ fontSize: 'var(--bb-text-sm)', color: 'var(--bb-mute)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>per ad set <IArrowRight /></span></td>
                    </tr>
                  );
                  const adsetRows = (campaign.adsets || []).map(adset => {
                    const alp    = adset.latest_pacing;
                    const action = (alp?.action || alp?.status || '').toUpperCase();
                    const rowKey = `a-${adset.id}`;
                    const res    = results[rowKey];
                    const isApplying = !!applying[rowKey];
                    const isSkipped  = !!skipped[rowKey];
                    const needsAction = alp && action !== 'ON_PACE';
                    const adsetMo = campaign.monthly_budget * ((adset.allocation_pct || 0) / 100);

                    return (
                      <tr key={rowKey} className="bb-row-adset">
                        <td>
                          <div className="bb-row-name">
                            <span className="bb-arrow"><IArrowSub /></span>
                            {adset.adset_name}
                            <button
                              type="button"
                              className="bb-row-weight"
                              title="Click to edit allocation"
                              onClick={(e) => { e.stopPropagation(); onEditAlloc(acct.id, campaign, adset.id); }}
                            >
                              {(adset.allocation_pct || 0).toFixed(0)}%
                            </button>
                          </div>
                        </td>
                        <td><span className="bb-mode bb-mode-adset">ad set</span></td>
                        <td className="num">{fmtMo(adsetMo)}</td>
                        <td className="num">{alp ? fmt$(alp.actual_spend, 2) : '—'}</td>
                        <td className="num">{alp ? <span style={{ color: statusTone(action, alp.pace_ratio), fontWeight: 600 }}>{(alp.pace_ratio || 0).toFixed(2)}x</span> : '—'}</td>
                        <td className="num">{alp?.current_daily_budget != null ? fmt$(alp.current_daily_budget, 2) : '—'}</td>
                        <td className="num">
                          {alp?.recommended_daily_budget != null ? (
                            <div className="bb-rec-cell">
                              <span>{fmt$(alp.recommended_daily_budget, 2)}</span>
                              <ChangeBadge pct={alp.change_percent} />
                            </div>
                          ) : '—'}
                        </td>
                        <td>{alp ? <StatusPill status={action} paceRatio={alp.pace_ratio} /> : <span style={{ color: 'var(--bb-mute)' }}>No data</span>}</td>
                        <td><span style={{ color: 'var(--bb-mute)' }}>—</span></td>
                        <td><ActionCell rowKey={rowKey} res={res} isApplying={isApplying} isSkipped={isSkipped}
                          needsAction={needsAction} onApply={() => onApplyAdset(acct.id, campaign, adset)}
                          onSkip={() => onSkip(rowKey)} onUnskip={() => onUnskip(rowKey)} /></td>
                      </tr>
                    );
                  });
                  return [parentRow, ...adsetRows];
                }

                // CBO
                const lp  = campaign.latest_pacing;
                const status = lp?.status || '';
                const rowKey = `c-${campaign.id}`;
                const res = results[rowKey];
                const isApplying = !!applying[rowKey];
                const isSkipped  = !!skipped[rowKey];
                const needsAction = lp && status.toUpperCase() !== 'ON_PACE';
                const cboUnmatched = acct.has_sheet && campaign.sheet_budget_matched === false;
                return [(
                  <tr key={rowKey} className={cboUnmatched ? 'bb-row-sheet-unmatched' : ''}>
                    <td>
                      <div className="bb-row-name">
                        <Link to={`/account/${acct.id}/campaign/${campaign.id}`}
                          style={{ fontWeight: 600, color: 'var(--bb-fg)', textDecoration: 'none' }}>
                          {campaign.campaign_name}
                        </Link>
                      </div>
                    </td>
                    <td><span className="bb-mode bb-mode-cbo">CBO</span></td>
                    <td className="num">{cboUnmatched ? <span style={{ color: 'var(--bb-mute)' }}>—</span> : fmtMo(campaign.monthly_budget)}</td>
                    <td className="num">{lp ? fmt$(lp.actual_spend, 2) : '—'}</td>
                    <td className="num">{lp ? <span style={{ color: statusTone(status, lp.pace_ratio), fontWeight: 600 }}>{(lp.pace_ratio || 0).toFixed(2)}x</span> : '—'}</td>
                    <td className="num">{lp?.current_daily_budget != null ? fmt$(lp.current_daily_budget, 2) : '—'}</td>
                    <td className="num">
                      {lp?.recommended_daily_budget != null ? (
                        <div className="bb-rec-cell">
                          <span>{fmt$(lp.recommended_daily_budget, 2)}</span>
                          <ChangeBadge pct={lp.change_percent} />
                        </div>
                      ) : '—'}
                    </td>
                    <td>{lp ? <StatusPill status={status} paceRatio={lp.pace_ratio} /> : <span style={{ color: 'var(--bb-mute)' }}>No data</span>}</td>
                    <td><NotesCell notes={campaign.sheet_notes || ''} /></td>
                    <td><ActionCell rowKey={rowKey} res={res} isApplying={isApplying} isSkipped={isSkipped}
                      needsAction={needsAction} onApply={() => onApplyCbo(acct.id, campaign)}
                      onSkip={() => onSkip(rowKey)} onUnskip={() => onUnskip(rowKey)} /></td>
                  </tr>
                )];
              })}
            </tbody>
          </table>
          </>
        )
      )}
    </section>
  );
}

function ActionCell({ rowKey, res, isApplying, isSkipped, needsAction, onApply, onSkip, onUnskip }) {
  if (res?.ok) return (
    <span className="bb-applied"><ICheck /> Applied</span>
  );
  if (res?.msg) return (
    <span style={{ color: 'var(--bb-warn-hot)', fontSize: 'var(--bb-text-sm)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <AlertCircle size={12} /> {res.msg}
    </span>
  );
  if (isSkipped) return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span className="bb-skipped">Skipped</span>
      <button style={{ background: 'none', border: 'none', color: 'var(--bb-accent)', cursor: 'pointer', fontSize: 'var(--bb-text-xs)', padding: 0, display: 'inline-flex', alignItems: 'center', gap: 3 }}
        onClick={onUnskip}>
        <RotateCcw size={10} /> Undo
      </button>
    </span>
  );
  if (!needsAction) return <span style={{ color: 'var(--bb-mute)', fontSize: 'var(--bb-text-sm)' }}>—</span>;
  return (
    <div className="bb-actions">
      <button className="bb-apply" onClick={onApply} disabled={isApplying}>
        {isApplying ? <Loader2 size={11} className="bb-spin" /> : <ICheck />}
        {isApplying ? '…' : 'Apply'}
      </button>
      <button className="bb-skip" onClick={onSkip} disabled={isApplying}>Skip</button>
    </div>
  );
}

// ── Allocation editor (inline ABO % editing from Home) ─────────
function AllocationEditorModal({ accountId, campaign, focusAdsetId, onClose, onSaved, toast }) {
  const adsets = useMemo(
    () => (campaign.adsets || []).filter(a => a.is_active !== false),
    [campaign]
  );
  const [values, setValues] = useState(() => {
    const o = {};
    adsets.forEach(a => { o[a.id] = (a.allocation_pct || 0).toFixed(2).replace(/\.?0+$/, ''); });
    return o;
  });
  const [saving, setSaving] = useState(false);

  const total = Object.values(values).reduce((s, v) => s + (parseFloat(v) || 0), 0);
  const validTotal = Math.abs(total - 100) <= 1.5;
  const anyEmpty = Object.values(values).some(v => v === '' || isNaN(parseFloat(v)));
  const monthly = campaign.monthly_budget || 0;

  const splitEvenly = () => {
    const n = adsets.length;
    if (n === 0) return;
    const even = +(100 / n).toFixed(2);
    const remainder = +(100 - even * n).toFixed(2);
    const o = {};
    adsets.forEach((a, i) => {
      const v = i === 0 ? +(even + remainder).toFixed(2) : even;
      o[a.id] = String(v);
    });
    setValues(o);
  };

  const handleSave = async () => {
    if (!validTotal || anyEmpty || saving) return;
    setSaving(true);
    try {
      await axios.put(`/api/campaigns/${accountId}/${campaign.id}/adsets`, {
        adsets: adsets.map(a => ({ id: a.id, allocation_pct: parseFloat(values[a.id]) })),
      });
      toast.success('Allocations updated', { title: campaign.campaign_name });
      onSaved();
      onClose();
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Save failed';
      toast.error(msg, { title: 'Save failed' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bb-modal-backdrop" onClick={onClose}>
      <div className="bb-modal" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
        <div className="bb-modal-head">
          <div className="bb-modal-title">Edit allocations · {campaign.campaign_name}</div>
          <button className="bb-icon-btn" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="bb-modal-body">
          <div style={{ fontSize: 'var(--bb-text-sm)', color: 'var(--bb-mute)', marginBottom: 12 }}>
            These percentages split this campaign's monthly budget of{' '}
            <strong style={{ color: 'var(--bb-fg)' }}>{fmtMo(monthly)}</strong> across its ad sets. Must sum to 100% (±1.5%).
          </div>
          <table className="bb-table">
            <thead>
              <tr>
                <th>Ad set</th>
                <th className="num" style={{ width: 130 }}>Allocation</th>
                <th className="num">Monthly</th>
              </tr>
            </thead>
            <tbody>
              {adsets.map(a => {
                const pct = parseFloat(values[a.id]);
                const mo = monthly * ((isNaN(pct) ? 0 : pct) / 100);
                const isFocus = a.id === focusAdsetId;
                return (
                  <tr key={a.id} style={isFocus ? { background: 'var(--bb-accent-soft)' } : null}>
                    <td>{a.adset_name}</td>
                    <td className="num">
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <input
                          autoFocus={isFocus}
                          className="bb-input"
                          style={{ width: 80, textAlign: 'right', padding: '5px 8px' }}
                          type="number"
                          step="0.01"
                          min="0"
                          max="100"
                          value={values[a.id] ?? ''}
                          onChange={e => setValues(p => ({ ...p, [a.id]: e.target.value }))}
                          onFocus={e => e.target.select()}
                        />
                        <span style={{ color: 'var(--bb-mute)' }}>%</span>
                      </div>
                    </td>
                    <td className="num">{fmtMo(mo)}</td>
                  </tr>
                );
              })}
              <tr style={{ borderTop: '2px solid var(--bb-line)' }}>
                <td style={{ fontWeight: 600, color: 'var(--bb-mute)' }}>Total</td>
                <td className="num" style={{ fontWeight: 600, color: validTotal ? 'var(--bb-ok)' : 'var(--bb-warn)' }}>
                  {total.toFixed(2)}%
                </td>
                <td className="num" style={{ color: 'var(--bb-mute)' }}>
                  {fmtMo(monthly * total / 100)}
                </td>
              </tr>
            </tbody>
          </table>
          {!validTotal && !anyEmpty && (
            <div className="bb-alert bb-alert-warn" style={{ marginTop: 12 }}>
              Allocations must sum to 100% (±1.5%). Current total: <strong>{total.toFixed(2)}%</strong>.
            </div>
          )}
        </div>
        <div className="bb-modal-foot">
          <button className="bb-btn bb-btn-ghost" type="button" onClick={splitEvenly} disabled={saving}>
            Split evenly
          </button>
          <span className="bb-spacer" />
          <button className="bb-btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="bb-apply" onClick={handleSave} disabled={!validTotal || anyEmpty || saving}>
            {saving ? <Loader2 size={11} className="bb-spin" /> : <ICheck />}
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────
function Home({ user, onLogout }) {
  const toast = useToast();
  const [accountBlocks, setAccountBlocks] = useState([]);
  const [allAccounts,   setAllAccounts]   = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState('');
  const [applying, setApplying] = useState({});
  const [skipped,  setSkipped]  = useState({});
  const [results,  setResults]  = useState({});
  const [pendingConfirm, setPendingConfirm] = useState(null);
  const [editingAlloc, setEditingAlloc] = useState(null); // { accountId, campaign, focusAdsetId }
  const [search, setSearch] = useState('');
  const [runningAll, setRunningAll]   = useState(false);
  const [runProgress, setRunProgress] = useState({ done: 0, total: 0 });
  const navigate = useNavigate();

  const runConcurrent = async (items, fn, limit = 2) => {
    const res = new Array(items.length);
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < items.length) {
        const i = nextIndex++;
        try { res[i] = { status: 'fulfilled', value: await fn(items[i]) }; }
        catch (err) { res[i] = { status: 'rejected', reason: err }; }
        setRunProgress(p => ({ ...p, done: p.done + 1 }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return res;
  };

  const fetchAll = useCallback(async (force = false) => {
    const cached = getCached('home-data');
    if (cached && !force) {
      setAllAccounts(cached.accounts);
      setAccountBlocks(cached.blocks);
      setLoading(false);
      if (!isStale('home-data')) return;
    }
    if (!cached) setLoading(true);
    try {
      const res = await axios.get('/api/campaigns/all');
      const blocks = res.data?.accounts || [];
      const accounts = blocks.map(b => ({ id: b.id, account_name: b.account_name }));
      setAllAccounts(accounts);
      setAccountBlocks(blocks);
      setCached('home-data', { accounts, blocks });
    } catch (err) {
      if (!cached) setError('Failed to load campaigns: ' + (err.response?.data?.error || err.message));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const handleRunAll = async () => {
    if (runningAll || allAccounts.length === 0) return;
    setRunningAll(true);
    setRunProgress({ done: 0, total: allAccounts.length });
    try {
      const settled = await runConcurrent(
        allAccounts,
        a => axios.post(`/api/pacing/${a.id}/run`, { run_type: 'MANUAL' }, { timeout: 120_000 }),
        1,
      );
      let succeeded = 0; let totalCampaigns = 0; const failures = [];
      settled.forEach((res, i) => {
        const acct = allAccounts[i];
        if (res.status === 'fulfilled') { succeeded++; totalCampaigns += res.value?.data?.campaigns_processed || 0; }
        else failures.push({ account: acct.account_name, error: res.reason?.response?.data?.error || res.reason?.message || 'Unknown error' });
      });
      const isFullSuccess = failures.length === 0;
      const isAllFail = succeeded === 0;
      const summary = isFullSuccess
        ? `${succeeded} of ${allAccounts.length} accounts refreshed · ${totalCampaigns} campaigns processed.`
        : isAllFail
          ? `All ${allAccounts.length} accounts failed: ${failures[0].account} — ${failures[0].error}`
          : `${succeeded} of ${allAccounts.length} accounts refreshed · ${failures.length} failed (${failures[0].account}…)`;
      if (isFullSuccess) toast.success(summary, { title: 'Pacing complete' });
      else if (!isAllFail) toast.warn(summary, { title: 'Pacing finished with errors' });
      else toast.error(summary, { title: 'Pacing failed' });
      invalidateCache('home-data');
      fetchAll(true);
    } finally { setRunningAll(false); }
  };

  const handleLogout = async () => {
    try { await axios.post('/api/auth/logout'); } catch {}
    onLogout(); navigate('/login');
  };

  const applyAdjustment = async (accountId, adjustment, rowKey) => {
    setApplying(p => ({ ...p, [rowKey]: true }));
    setResults(p => ({ ...p, [rowKey]: null }));
    try {
      const { data } = await axios.post(`/api/pacing/${accountId}/apply`, { adjustments: [adjustment] });
      const applied = data.applied_count ?? 0;
      const failures = (data.results || []).filter(r => r.error);
      const skippedR = (data.results || []).filter(r => r.skipped);
      if (failures.length && applied === 0) {
        const msg = failures[0].error || 'Failed';
        setResults(p => ({ ...p, [rowKey]: { ok: false, msg } }));
        toast.error(msg, { title: 'Apply failed' });
      } else if (failures.length) {
        setResults(p => ({ ...p, [rowKey]: { ok: true, partial: true } }));
        toast.warn(failures[0].error || 'Partial apply', { title: 'Apply warning' });
        invalidateCache('home-data'); fetchAll(true);
      } else if (skippedR.length && applied === 0) {
        setResults(p => ({ ...p, [rowKey]: { ok: true, noop: true } }));
        toast.info('No change sent — already on pace or unchanged.', { title: 'Apply' });
        invalidateCache('home-data'); fetchAll(true);
      } else {
        setResults(p => ({ ...p, [rowKey]: { ok: true } }));
        toast.success(`Pushed new daily of $${(adjustment.recommended_daily_budget || 0).toFixed(2)} to Meta.`, { title: 'Applied' });
        invalidateCache('home-data'); fetchAll(true);
      }
    } catch (err) {
      const d = err.response?.data;
      const msg = d?.results?.find(r => r.error)?.error || d?.error || 'Failed';
      setResults(p => ({ ...p, [rowKey]: { ok: false, msg } }));
      toast.error(msg, { title: 'Apply failed' });
    } finally {
      setApplying(p => ({ ...p, [rowKey]: false }));
    }
  };

  const handleApplyCbo = (accountId, campaign) => {
    const lp = campaign.latest_pacing;
    if (!lp) return;
    setPendingConfirm({
      accountId, rowKey: `c-${campaign.id}`,
      adjustment: { level: 'campaign', campaign_id: campaign.id, campaign_name: campaign.campaign_name,
        current_daily_budget: lp.current_daily_budget, recommended_daily_budget: lp.recommended_daily_budget,
        change_percent: lp.change_percent, action: lp.status },
    });
  };
  const handleApplyAdset = (accountId, campaign, adset) => {
    const alp = adset.latest_pacing;
    if (!alp) return;
    setPendingConfirm({
      accountId, rowKey: `a-${adset.id}`,
      adjustment: { level: 'adset', campaign_id: campaign.id, campaign_name: campaign.campaign_name,
        adset_id: adset.id, adset_name: adset.adset_name,
        current_daily_budget: alp.current_daily_budget, recommended_daily_budget: alp.recommended_daily_budget,
        change_percent: alp.change_percent, action: alp.action || alp.status },
    });
  };
  const handleConfirmApply = () => {
    if (!pendingConfirm) return;
    const { accountId, adjustment, rowKey } = pendingConfirm;
    setPendingConfirm(null);
    applyAdjustment(accountId, adjustment, rowKey);
  };
  const handleApplyAll = (acct) => {
    acct.campaigns.forEach(c => {
      const mode = c.budget_mode || 'CBO';
      if (mode === 'ABO') {
        (c.adsets || []).forEach(a => {
          const alp = a.latest_pacing;
          if (!alp) return;
          const action = (alp.action || alp.status || '').toUpperCase();
          const rk = `a-${a.id}`;
          if (action !== 'ON_PACE' && !results[rk]?.ok && !skipped[rk])
            applyAdjustment(acct.id, { level: 'adset', campaign_id: c.id, campaign_name: c.campaign_name,
              adset_id: a.id, adset_name: a.adset_name,
              current_daily_budget: alp.current_daily_budget, recommended_daily_budget: alp.recommended_daily_budget,
              change_percent: alp.change_percent, action: alp.action || alp.status }, rk);
        });
      } else {
        const lp = c.latest_pacing;
        if (!lp) return;
        const rk = `c-${c.id}`;
        if ((lp.status || '').toUpperCase() !== 'ON_PACE' && !results[rk]?.ok && !skipped[rk])
          applyAdjustment(acct.id, { level: 'campaign', campaign_id: c.id, campaign_name: c.campaign_name,
            current_daily_budget: lp.current_daily_budget, recommended_daily_budget: lp.recommended_daily_budget,
            change_percent: lp.change_percent, action: lp.status }, rk);
      }
    });
  };

  // Totals
  const totals = useMemo(() => {
    let monthly = 0, spent = 0, campaignCount = 0, adsetCount = 0;
    accountBlocks.forEach(acct => {
      acct.campaigns.forEach(c => {
        campaignCount++;
        monthly += Number(c.monthly_budget) || 0;
        const lp = c.latest_pacing;
        if (lp && Number.isFinite(Number(lp.actual_spend))) spent += Number(lp.actual_spend);
        if ((c.budget_mode || 'CBO') === 'ABO') adsetCount += (c.adsets || []).length;
      });
    });
    const pct = monthly > 0 ? Math.min(100, (spent / monthly) * 100) : 0;
    return { monthly, spent, pct, campaignCount, adsetCount };
  }, [accountBlocks]);

  // Attention count
  const attentionCount = useMemo(() => {
    let n = 0;
    accountBlocks.forEach(acct => acct.campaigns.forEach(c => {
      if ((c.budget_mode || 'CBO') === 'ABO') {
        (c.adsets || []).forEach(a => {
          const alp = a.latest_pacing;
          const rk = `a-${a.id}`;
          if (alp && (alp.action || alp.status || '').toUpperCase() !== 'ON_PACE' && !results[rk]?.ok && !skipped[rk]) n++;
        });
      } else {
        const lp = c.latest_pacing;
        const rk = `c-${c.id}`;
        if (lp && (lp.status || '').toUpperCase() !== 'ON_PACE' && !results[rk]?.ok && !skipped[rk]) n++;
      }
    }));
    return n;
  }, [accountBlocks, results, skipped]);

  const fmt$M = (n) => {
    if (!n) return '$0';
    if (n >= 1000000) return `$${(n/1000000).toFixed(1)}M`;
    if (n >= 1000) return `$${(n/1000).toFixed(0)}k`;
    return fmt$(n);
  };

  return (
    <div className="bb-app">
      <Sidebar user={user} accounts={allAccounts} onAddAccount={() => navigate('/accounts')} />

      <main className="bb-main">
        {/* Header */}
        <div className="bb-header">
          <div>
            <h1 className="bb-h1">All Campaigns</h1>
            <div className="bb-sub">Every tracked campaign across all accounts. Apply pacing recommendations or skip the ones you've already addressed.</div>
          </div>
          <div className="bb-header-actions">
            <button className="bb-btn bb-btn-primary" onClick={handleRunAll}
              disabled={runningAll || loading || allAccounts.length === 0}>
              {runningAll ? <Loader2 size={13} className="bb-spin" /> : <IPlay />}
              {runningAll ? `Running ${runProgress.done}/${runProgress.total}…` : `Run Pacing (All ${allAccounts.length})`}
            </button>
            <button className="bb-btn bb-btn-ghost" onClick={handleLogout}>
              <ILogout /> Log out
            </button>
          </div>
        </div>

        {error && <div className="bb-alert bb-alert-error">{error}</div>}

        {/* Summary cards */}
        {!loading && accountBlocks.length > 0 && (
          <div className="bb-summary-grid">
            <div className="bb-summary-cell">
              <div className="bb-summary-label">Monthly Budget</div>
              <div className="bb-summary-value">{fmt$M(totals.monthly)}</div>
              <div className="bb-summary-meta">{totals.campaignCount} campaigns · {accountBlocks.length} accounts</div>
            </div>
            <div className="bb-summary-cell">
              <div className="bb-summary-label">Spend (MTD)</div>
              <div className="bb-summary-value">{fmt$(totals.spent, 2)}</div>
              <div className="bb-progress"><div className="bb-progress-fill" style={{ width: totals.pct + '%' }} /></div>
              <div className="bb-summary-meta">{totals.pct.toFixed(1)}% of budget · pacing on track</div>
            </div>
            <div className="bb-summary-cell">
              <div className="bb-summary-label">Tracked Units</div>
              <div className="bb-summary-value">
                {totals.campaignCount}
                {totals.adsetCount > 0 && <span style={{ color: 'var(--bb-mute)', fontSize: 14, fontWeight: 400 }}> / {totals.adsetCount} ad sets</span>}
              </div>
              <div className="bb-summary-meta">across {accountBlocks.length} accounts</div>
            </div>
            <div className="bb-summary-cell">
              <div className="bb-summary-label">Needs Attention</div>
              <div className="bb-summary-value" style={{ color: attentionCount > 0 ? 'var(--bb-warn)' : 'var(--bb-ok)' }}>
                {attentionCount}
              </div>
              <div className="bb-summary-meta">{attentionCount > 0 ? 'pending recommendations' : "you're all caught up"}</div>
            </div>
          </div>
        )}
        {loading && (
          <div className="bb-grid bb-grid-4" style={{ marginBottom: 22, gap: 0, border: '1px solid var(--bb-line)', borderRadius: 'var(--bb-radius)', overflow: 'hidden' }}>
            {[...Array(4)].map((_, i) => <SkeletonStatTile key={i} />)}
          </div>
        )}

        {/* Attention strip */}
        {attentionCount > 0 && (
          <div className="bb-attention">
            <span style={{ color: 'var(--bb-warn)' }}><IAlert /></span>
            <div>
              <strong>{attentionCount}</strong> recommendation{attentionCount !== 1 ? 's' : ''} across <strong>{accountBlocks.filter(a => a.campaigns.some(c => c.latest_pacing && (c.latest_pacing.status || '').toUpperCase() !== 'ON_PACE')).length}</strong> accounts. Newly-detected pace deviations from this morning's run.
            </div>
            <span className="bb-spacer" />
            <button className="bb-btn bb-btn-sm">Review oldest first</button>
          </div>
        )}

        {/* Search */}
        {!loading && accountBlocks.length > 0 && (
          <div className="bb-search">
            <ISearch />
            <input
              type="text"
              placeholder="Search accounts, campaigns, or ad sets…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {search && (
              <div className="bb-search-tools">
                <button className="bb-btn bb-btn-ghost bb-btn-sm" onClick={() => setSearch('')}
                  style={{ borderColor: 'transparent' }}>
                  <X size={12} />
                </button>
              </div>
            )}
            {!search && (
              <div className="bb-search-tools">
                <span className="bb-kbd">⌘K</span>
              </div>
            )}
          </div>
        )}

        {/* Account sections */}
        {loading ? (
          <><SkeletonAccountBlock /><SkeletonAccountBlock /></>
        ) : accountBlocks.length === 0 ? (
          <div className="bb-acct">
            <EmptyState
              icon={null}
              title="No campaigns tracked yet"
              body="Connect a Meta ad account and import campaigns to start pacing recommendations."
              action={{ label: 'Add Account', onClick: () => navigate('/accounts') }}
            />
          </div>
        ) : (
          accountBlocks.map(acct => (
            <AccountSection
              key={acct.id}
              acct={acct}
              applying={applying}
              skipped={skipped}
              results={results}
              search={search}
              onApplyCbo={handleApplyCbo}
              onApplyAdset={handleApplyAdset}
              onSkip={rk => setSkipped(p => ({ ...p, [rk]: true }))}
              onUnskip={rk => setSkipped(p => ({ ...p, [rk]: false }))}
              onApplyAll={handleApplyAll}
              onEditAlloc={(accountId, campaign, focusAdsetId) =>
                setEditingAlloc({ accountId, campaign, focusAdsetId })}
            />
          ))
        )}
      </main>

      {/* Allocation editor modal (inline ABO % edit from Home) */}
      {editingAlloc && (
        <AllocationEditorModal
          accountId={editingAlloc.accountId}
          campaign={editingAlloc.campaign}
          focusAdsetId={editingAlloc.focusAdsetId}
          onClose={() => setEditingAlloc(null)}
          onSaved={() => { invalidateCache('home-data'); fetchAll(true); }}
          toast={toast}
        />
      )}

      {/* Apply confirmation modal */}
      {pendingConfirm && (() => {
        const adj = pendingConfirm.adjustment;
        const isAdset = adj.level === 'adset' || !!adj.adset_id;
        const up = (adj.change_percent || 0) > 0;
        return (
          <div className="bb-modal-backdrop" onClick={() => setPendingConfirm(null)}>
            <div className="bb-modal" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
              <div className="bb-modal-head">
                <div className="bb-modal-title">Confirm budget change in Meta</div>
                <button className="bb-icon-btn" onClick={() => setPendingConfirm(null)}><X size={18} /></button>
              </div>
              <div className="bb-modal-body">
                <div className="bb-alert bb-alert-warn" style={{ marginBottom: 16 }}>
                  This will push <strong>1 budget change</strong> directly to Meta via the API.
                  This cannot be undone automatically.
                </div>
                <table className="bb-table">
                  <thead><tr><th>Target</th><th>Current Daily</th><th>New Daily</th><th>Change</th></tr></thead>
                  <tbody>
                    <tr>
                      <td>
                        <div style={{ fontWeight: 600 }}>{isAdset ? adj.adset_name : adj.campaign_name}</div>
                        {isAdset && <div style={{ fontSize: 11, color: 'var(--bb-mute)' }}>Ad set in {adj.campaign_name}</div>}
                      </td>
                      <td className="num">${(adj.current_daily_budget || 0).toFixed(2)}</td>
                      <td className="num">${(adj.recommended_daily_budget || 0).toFixed(2)}</td>
                      <td>
                        <span className={up ? 'bb-change bb-change-up' : 'bb-change bb-change-down'}>
                          {up ? <ITrendUp /> : <ITrendDown />}
                          {up ? '+' : ''}{(adj.change_percent || 0).toFixed(1)}%
                        </span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="bb-modal-foot">
                <button className="bb-btn" onClick={() => setPendingConfirm(null)}>Cancel</button>
                <button className="bb-apply" onClick={handleConfirmApply}>
                  <ICheck /> Yes, push to Meta
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

export default Home;
