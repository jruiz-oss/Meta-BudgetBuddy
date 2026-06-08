import React, { useState, useEffect, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { Loader2, Save, X, RefreshCw } from 'lucide-react';
import Sidebar from '../components/Sidebar';
import { useToast } from '../components/Toast';

// Deterministic hue for card bar color
function acctHue(id) {
  const n = parseInt(id, 10) || 0;
  return (n * 137 + 43) % 360;
}

// Inline icons
const IKey = () => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="8" cy="15" r="4"/>
    <path d="m10.85 12.15 7.65-7.65a1 1 0 0 1 1.41 0l1.65 1.65a1 1 0 0 1 0 1.41L19 9.5l-2-2-3 3 .15.15"/>
  </svg>
);
const ISheet = () => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2"/>
    <path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>
  </svg>
);
const IPlus = () => (
  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
    <path d="M12 5v14M5 12h14"/>
  </svg>
);
const ILogout = () => (
  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
    <path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>
  </svg>
);
const IArrowRight = () => (
  <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12h14M13 5l7 7-7 7"/>
  </svg>
);

function Accounts({ user, onLogout }) {
  const toast = useToast();
  const navigate = useNavigate();

  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [addSaving, setAddSaving] = useState(false);
  const [newAccountName, setNewAccountName] = useState('');
  const [newMetaAccountId, setNewMetaAccountId] = useState('');
  const [newMetaToken, setNewMetaToken] = useState('');
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('budget-desc');

  // Global token
  const [globalToken, setGlobalToken] = useState('');
  const [globalTokenPreview, setGlobalTokenPreview] = useState('');
  const [hasGlobalToken, setHasGlobalToken] = useState(false);
  const [tokenSaving, setTokenSaving] = useState(false);
  const [showTokenInput, setShowTokenInput] = useState(false);

  // Global sheet (workspace-shared)
  const [globalSheet, setGlobalSheet] = useState('');
  const [globalSheetId, setGlobalSheetId] = useState('');
  const [hasGlobalSheet, setHasGlobalSheet] = useState(false);
  const [sheetSaving, setSheetSaving] = useState(false);
  const [showSheetInput, setShowSheetInput] = useState(false);

  const [refreshing, setRefreshing] = useState({});

  useEffect(() => { fetchAccounts(); fetchGlobalToken(); fetchGlobalSheet(); }, []);

  const fetchAccounts = async () => {
    try {
      setLoading(true);
      const res = await axios.get('/api/accounts');
      setAccounts(res.data.accounts || res.data || []);
    } catch { setError('Failed to load accounts'); }
    finally { setLoading(false); }
  };

  const fetchGlobalToken = async () => {
    try {
      const res = await axios.get('/api/accounts/global-token');
      setHasGlobalToken(res.data.has_token);
      setGlobalTokenPreview(res.data.preview || '');
    } catch {}
  };

  const handleSaveGlobalToken = async () => {
    setTokenSaving(true);
    try {
      const res = await axios.put('/api/accounts/global-token', { global_meta_token: globalToken });
      setHasGlobalToken(res.data.has_token);
      setGlobalTokenPreview(res.data.preview || '');
      setGlobalToken(''); setShowTokenInput(false);
      toast.success('Global token saved.');
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to save token'); }
    finally { setTokenSaving(false); }
  };

  const fetchGlobalSheet = async () => {
    try {
      const res = await axios.get('/api/sheets/global-config');
      setHasGlobalSheet(res.data.has_sheet);
      setGlobalSheetId(res.data.google_sheet_id || '');
    } catch {}
  };

  const handleSaveGlobalSheet = async () => {
    setSheetSaving(true);
    try {
      const res = await axios.put('/api/sheets/global-config', { google_sheet_id: globalSheet });
      setHasGlobalSheet(res.data.has_sheet);
      setGlobalSheetId(res.data.google_sheet_id || '');
      setGlobalSheet(''); setShowSheetInput(false);
      toast.success('Global sheet saved.');
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to save sheet'); }
    finally { setSheetSaving(false); }
  };

  const handleCreateAccount = async (e) => {
    e.preventDefault(); setError('');
    if (!newAccountName || !newMetaAccountId) { setError('Account name and Meta Account ID are required.'); return; }
    if (!newMetaToken && !hasGlobalToken) { setError('Either paste a token here or set a Global Token above first.'); return; }
    setAddSaving(true);
    try {
      const res = await axios.post('/api/accounts', { account_name: newAccountName, meta_account_id: newMetaAccountId, meta_token: newMetaToken });
      const ai = res.data.auto_import;
      const importMsg = ai
        ? ai.imported > 0 ? ` Auto-imported ${ai.imported} campaign(s).` : ai.errors?.length ? ` Campaigns not imported: ${ai.errors[0]}` : ' No active campaigns found.'
        : '';
      toast.success(`Account created.${importMsg}`, { title: 'Done' });
      setNewAccountName(''); setNewMetaAccountId(''); setNewMetaToken(''); setShowAdd(false);
      fetchAccounts();
    } catch (err) { setError(err.response?.data?.error || 'Failed to create account'); }
    finally { setAddSaving(false); }
  };

  const handleRefreshCampaigns = async (accountId, accountName) => {
    setRefreshing(p => ({ ...p, [accountId]: true }));
    try {
      const res = await axios.post(`/api/accounts/${accountId}/refresh-campaigns`);
      toast.success(`${res.data.imported} campaign(s) synced for ${accountName}.`, { title: 'Campaigns refreshed' });
      fetchAccounts();
    } catch (err) { toast.error(err.response?.data?.error || 'Refresh failed'); }
    finally { setRefreshing(p => ({ ...p, [accountId]: false })); }
  };

  const handleLogout = async () => {
    try { await axios.post('/api/auth/logout'); } catch {}
    onLogout(); navigate('/login');
  };

  const totals = useMemo(() => {
    const t = { all: accounts.length, on: 0, under: 0, over: 0, budget: 0, campaigns: 0 };
    accounts.forEach(a => {
      t.budget += a.total_monthly_budget || 0;
      t.campaigns += a.campaign_count || 0;
      const cat = a.status_category;
      if (cat === 'on_track') t.on++;
      else if (cat === 'under_pacing') t.under++;
      else if (cat === 'over_pacing') t.over++;
    });
    return t;
  }, [accounts]);

  const filtered = useMemo(() => {
    let list = accounts;
    const filterMap = { on: 'on_track', under: 'under_pacing', over: 'over_pacing' };
    if (filter !== 'all') list = list.filter(a => a.status_category === filterMap[filter]);
    list = [...list].sort((a, b) => {
      if (sort === 'budget-desc') return (b.total_monthly_budget || 0) - (a.total_monthly_budget || 0);
      if (sort === 'budget-asc')  return (a.total_monthly_budget || 0) - (b.total_monthly_budget || 0);
      if (sort === 'name-asc')    return (a.account_name || '').localeCompare(b.account_name || '');
      if (sort === 'campaigns-desc') return (b.campaign_count || 0) - (a.campaign_count || 0);
      return 0;
    });
    return list;
  }, [accounts, filter, sort]);

  const toneForCategory = (cat) => {
    if (cat === 'on_track')     return 'ok';
    if (cat === 'under_pacing') return 'cool';
    if (cat === 'over_pacing')  return 'warn';
    return null;
  };
  const labelForCategory = (cat) => {
    if (cat === 'on_track')     return 'On pace';
    if (cat === 'under_pacing') return 'Underspending';
    if (cat === 'over_pacing')  return 'Overspending';
    return 'No data';
  };

  return (
    <div className="bb-app">
      <Sidebar user={user} accounts={accounts} onAddAccount={() => setShowAdd(true)} />

      <main className="bb-main">
        {/* Header */}
        <div className="bb-header">
          <div>
            <h1 className="bb-h1">Your Accounts</h1>
            <div className="bb-sub">All Meta ad accounts you're managing across the agency.</div>
          </div>
          <div className="bb-header-actions">
            <button className="bb-btn bb-btn-primary" onClick={() => setShowAdd(true)}>
              <IPlus /> Add Account
            </button>
            <button className="bb-btn bb-btn-ghost" onClick={handleLogout}>
              <ILogout /> Log out
            </button>
          </div>
        </div>

        {/* Page tabs */}
        <div className="bb-page-tabs">
          <Link to="/" className="bb-page-tab">All Campaigns</Link>
          <span className="bb-page-tab is-active">Accounts</span>
        </div>

        {error && <div className="bb-alert bb-alert-error">{error}</div>}

        {/* Token bar */}
        <div className="bb-token-bar">
          <div className="bb-key-icon"><IKey /></div>
          <div style={{ flex: 1 }}>
            <div className="bb-token-title">Global Meta Token</div>
            <div className="bb-token-sub">Shared across all accounts. Set a per-account override in each account's Settings if needed.</div>
            {hasGlobalToken && !showTokenInput && (
              <div className="bb-token-current">
                Current token: <span className="bb-token-val">{globalTokenPreview}</span>
              </div>
            )}
            {showTokenInput && (
              <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="password" className="bb-input" placeholder="EAAb… paste your system user token"
                  value={globalToken} onChange={e => setGlobalToken(e.target.value)} autoFocus style={{ maxWidth: 380 }} />
                <button className="bb-btn bb-btn-primary" onClick={handleSaveGlobalToken}
                  disabled={tokenSaving || !globalToken.trim()}>
                  {tokenSaving ? <Loader2 size={13} className="bb-spin" /> : <Save size={13} />} Save
                </button>
                <button className="bb-btn" onClick={() => { setShowTokenInput(false); setGlobalToken(''); }}>
                  <X size={13} /> Cancel
                </button>
              </div>
            )}
          </div>
          {!showTokenInput && (
            <button className="bb-btn" onClick={() => setShowTokenInput(true)}>
              {hasGlobalToken ? 'Update token' : 'Set token'}
            </button>
          )}
        </div>

        {/* Sheet bar */}
        <div className="bb-token-bar">
          <div className="bb-key-icon"><ISheet /></div>
          <div style={{ flex: 1 }}>
            <div className="bb-token-title">Global Google Sheet</div>
            <div className="bb-token-sub">Shared across all accounts. Set a per-account override in each account's Settings → Google Sheets if needed.</div>
            {hasGlobalSheet && !showSheetInput && (
              <div className="bb-token-current">
                Current sheet ID: <span className="bb-token-val">{globalSheetId}</span>
              </div>
            )}
            {showSheetInput && (
              <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="text" className="bb-input" placeholder="https://docs.google.com/spreadsheets/d/…"
                  value={globalSheet} onChange={e => setGlobalSheet(e.target.value)} autoFocus style={{ maxWidth: 380 }} />
                <button className="bb-btn bb-btn-primary" onClick={handleSaveGlobalSheet}
                  disabled={sheetSaving || !globalSheet.trim()}>
                  {sheetSaving ? <Loader2 size={13} className="bb-spin" /> : <Save size={13} />} Save
                </button>
                <button className="bb-btn" onClick={() => { setShowSheetInput(false); setGlobalSheet(''); }}>
                  <X size={13} /> Cancel
                </button>
              </div>
            )}
          </div>
          {!showSheetInput && (
            <button className="bb-btn" onClick={() => setShowSheetInput(true)}>
              {hasGlobalSheet ? 'Update sheet' : 'Set sheet'}
            </button>
          )}
        </div>

        {/* State cards */}
        <div className="bb-state-grid">
          <div className="bb-state-card">
            <div className="bb-state-label">Accounts</div>
            <div className="bb-state-value">{totals.all}</div>
            <div className="bb-state-meta">{totals.campaigns} campaigns total</div>
          </div>
          <div className="bb-state-card is-ok" style={{ cursor: 'pointer' }} onClick={() => setFilter('on')}>
            <div className="bb-state-label">On Pace</div>
            <div className="bb-state-value">{totals.on}</div>
            <div className="bb-state-meta">{totals.all > 0 ? Math.round(totals.on / totals.all * 100) : 0}% of accounts</div>
          </div>
          <div className="bb-state-card is-cool" style={{ cursor: 'pointer' }} onClick={() => setFilter('under')}>
            <div className="bb-state-label">Underspending</div>
            <div className="bb-state-value">{totals.under}</div>
            <div className="bb-state-meta">below target pace</div>
          </div>
          <div className="bb-state-card is-warn" style={{ cursor: 'pointer' }} onClick={() => setFilter('over')}>
            <div className="bb-state-label">Overspending</div>
            <div className="bb-state-value">{totals.over}</div>
            <div className="bb-state-meta">above target pace</div>
          </div>
          <div className="bb-state-card">
            <div className="bb-state-label">Monthly Budget</div>
            <div className="bb-state-value">${totals.budget.toLocaleString('en-US', { maximumFractionDigits: 0 })}</div>
            <div className="bb-state-meta">across all accounts</div>
          </div>
        </div>

        {/* Filter pills + sort */}
        <div className="bb-filter-row">
          {[['all','All',totals.all],['on','On Pace',totals.on],['under','Underspending',totals.under],['over','Overspending',totals.over]].map(([k,lbl,cnt]) => (
            <button key={k} className={'bb-filter-pill' + (filter === k ? ' is-active' : '')} onClick={() => setFilter(k)}>
              {lbl} <span className="bb-pill-count">({cnt})</span>
            </button>
          ))}
          <div className="bb-sort">
            Sort:
            <select value={sort} onChange={e => setSort(e.target.value)}>
              <option value="budget-desc">Budget (high → low)</option>
              <option value="budget-asc">Budget (low → high)</option>
              <option value="name-asc">Name (A → Z)</option>
              <option value="campaigns-desc">Campaigns (most)</option>
            </select>
          </div>
        </div>

        {/* Account cards grid */}
        {loading ? (
          <div style={{ color: 'var(--bb-mute)', fontSize: 'var(--bb-text-sm)', padding: '20px 0' }}>Loading accounts…</div>
        ) : filtered.length === 0 ? (
          <div style={{ color: 'var(--bb-mute)', padding: '40px 0', textAlign: 'center' }}>
            {accounts.length === 0 ? 'No accounts yet. Click + Add Account to get started.' : 'No accounts match this filter.'}
          </div>
        ) : (
          <div className="bb-acct-grid">
            {filtered.map(account => {
              const tone = toneForCategory(account.status_category);
              const label = labelForCategory(account.status_category);
              return (
                <div key={account.id} className="bb-acct-card"
                  style={{ '--acct-hue': acctHue(account.id) }}
                  onClick={() => navigate(`/account/${account.id}`)}>
                  <div className="bb-acct-card-head">
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="bb-acct-card-name">{account.account_name}</div>
                      <div className="bb-acct-card-id">Meta ID: {account.meta_account_id || '—'}</div>
                    </div>
                    {tone && <span className={`bb-state-pill is-${tone}`}>{label}</span>}
                  </div>

                  <div className="bb-acct-card-stats">
                    <div>
                      <div className="bb-s-num">{account.campaign_count || 0}</div>
                      <div className="bb-s-label">Campaigns</div>
                    </div>
                    <div>
                      <div className="bb-s-num">${(account.total_monthly_budget || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}</div>
                      <div className="bb-s-label">Monthly</div>
                    </div>
                    <div>
                      <div className="bb-s-num" style={{ color: (account.pacing_status?.on_track || 0) === (account.campaign_count || 0) && account.campaign_count > 0 ? 'var(--bb-ok)' : undefined }}>
                        {account.pacing_status?.on_track || 0}/{account.campaign_count || 0}
                      </div>
                      <div className="bb-s-label">On pace</div>
                    </div>
                  </div>

                  <div className="bb-acct-card-actions">
                    <button className="bb-btn bb-btn-sm bb-btn-primary" onClick={e => { e.stopPropagation(); navigate(`/account/${account.id}`); }}>
                      View Dashboard <IArrowRight />
                    </button>
                    <button className="bb-btn bb-btn-sm" onClick={e => { e.stopPropagation(); navigate(`/account/${account.id}/settings`); }}>Settings</button>
                    <button className="bb-icon-btn" title="Re-sync campaigns from Meta"
                      onClick={e => { e.stopPropagation(); handleRefreshCampaigns(account.id, account.account_name); }}
                      disabled={!!refreshing[account.id]}>
                      {refreshing[account.id] ? <Loader2 size={13} className="bb-spin" /> : <RefreshCw size={13} />}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Add Account modal */}
        {showAdd && (
          <div className="bb-modal-backdrop" onClick={() => setShowAdd(false)}>
            <div className="bb-modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
              <div className="bb-modal-head">
                <div className="bb-modal-title">Add Account</div>
                <button className="bb-icon-btn" onClick={() => setShowAdd(false)} aria-label="Close"><X size={18} /></button>
              </div>
              <form onSubmit={handleCreateAccount}>
                <div className="bb-modal-body">
                  {error && <div className="bb-alert bb-alert-error" style={{ marginBottom: 12 }}>{error}</div>}
                  <div className="bb-form-group">
                    <label className="bb-form-label">Account Name</label>
                    <input type="text" className="bb-input" placeholder="e.g., Harrah's Oklahoma"
                      value={newAccountName} onChange={e => setNewAccountName(e.target.value)} autoFocus />
                  </div>
                  <div className="bb-form-group">
                    <label className="bb-form-label">Meta Ad Account ID</label>
                    <input type="text" className="bb-input" placeholder="e.g., 123456789"
                      value={newMetaAccountId} onChange={e => setNewMetaAccountId(e.target.value)} />
                    <span className="bb-form-help">The number from Ads Manager. Just the digits — no "act_" needed.</span>
                  </div>
                  <div className="bb-form-group">
                    <label className="bb-form-label">Token Override <span style={{ fontWeight: 400, color: 'var(--bb-mute)' }}>(optional)</span></label>
                    <input type="password" className="bb-input"
                      placeholder={hasGlobalToken ? 'Leave blank to use global token' : 'EAAb…'}
                      value={newMetaToken} onChange={e => setNewMetaToken(e.target.value)} />
                    <span className="bb-form-help">
                      {hasGlobalToken ? `Global token is set (${globalTokenPreview}). Only fill this in if this account uses a different token.` : 'No global token set — paste a token here, or cancel and set one above first.'}
                    </span>
                  </div>
                  <div className="bb-alert bb-alert-info" style={{ fontSize: 12 }}>
                    Active campaigns will be imported automatically after saving.
                  </div>
                </div>
                <div className="bb-modal-foot">
                  <button type="button" className="bb-btn" onClick={() => setShowAdd(false)} disabled={addSaving}>Cancel</button>
                  <button type="submit" className="bb-btn bb-btn-primary" disabled={addSaving}>
                    {addSaving ? <Loader2 size={13} className="bb-spin" /> : null}
                    {addSaving ? 'Creating…' : 'Create & Import'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default Accounts;
