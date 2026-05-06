import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { Key, Save, X, Loader2, RefreshCw } from 'lucide-react';
import Sidebar from '../components/Sidebar';
import { useToast } from '../components/Toast';

function Accounts({ user, onLogout }) {
  const toast = useToast();
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [addSaving, setAddSaving] = useState(false);
  const [newAccountName, setNewAccountName] = useState('');
  const [newMetaAccountId, setNewMetaAccountId] = useState('');
  const [newMetaToken, setNewMetaToken] = useState('');
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');

  // Global token state
  const [globalToken, setGlobalToken] = useState('');
  const [globalTokenPreview, setGlobalTokenPreview] = useState('');
  const [hasGlobalToken, setHasGlobalToken] = useState(false);
  const [tokenSaving, setTokenSaving] = useState(false);
  const [showTokenInput, setShowTokenInput] = useState(false);

  // Per-account refresh
  const [refreshing, setRefreshing] = useState({});

  const navigate = useNavigate();

  useEffect(() => {
    fetchAccounts();
    fetchGlobalToken();
  }, []);

  const fetchAccounts = async () => {
    try {
      setLoading(true);
      const res = await axios.get('/api/accounts');
      setAccounts(res.data.accounts || res.data || []);
    } catch {
      setError('Failed to load accounts');
    } finally {
      setLoading(false);
    }
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
      setGlobalToken('');
      setShowTokenInput(false);
      toast.success('Global token saved.');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save token');
    } finally {
      setTokenSaving(false);
    }
  };

  const handleCreateAccount = async (e) => {
    e.preventDefault();
    setError('');
    if (!newAccountName || !newMetaAccountId) {
      setError('Account name and Meta Account ID are required.');
      return;
    }
    if (!newMetaToken && !hasGlobalToken) {
      setError('Either paste a token here or set a Global Token above first.');
      return;
    }
    setAddSaving(true);
    try {
      const res = await axios.post('/api/accounts', {
        account_name: newAccountName,
        meta_account_id: newMetaAccountId,
        meta_token: newMetaToken,
      });
      const ai = res.data.auto_import;
      const importMsg = ai
        ? ai.imported > 0
          ? ` Auto-imported ${ai.imported} campaign(s).`
          : ai.errors?.length
            ? ` Campaigns not imported: ${ai.errors[0]}`
            : ' No active campaigns found.'
        : '';
      toast.success(`Account created.${importMsg}`, { title: 'Done' });
      setNewAccountName('');
      setNewMetaAccountId('');
      setNewMetaToken('');
      setShowAdd(false);
      fetchAccounts();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create account');
    } finally {
      setAddSaving(false);
    }
  };

  const handleRefreshCampaigns = async (accountId, accountName) => {
    setRefreshing((p) => ({ ...p, [accountId]: true }));
    try {
      const res = await axios.post(`/api/accounts/${accountId}/refresh-campaigns`);
      toast.success(
        `${res.data.imported} campaign(s) synced for ${accountName}.`,
        { title: 'Campaigns refreshed' }
      );
      fetchAccounts();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Refresh failed');
    } finally {
      setRefreshing((p) => ({ ...p, [accountId]: false }));
    }
  };

  const handleLogout = async () => {
    try { await axios.post('/api/auth/logout'); } catch {}
    onLogout();
    navigate('/login');
  };

  const totals = useMemo(() => {
    const t = { all: accounts.length, on: 0, under: 0, over: 0, budget: 0, campaigns: 0 };
    accounts.forEach((a) => {
      t.budget += a.total_monthly_budget || 0;
      t.campaigns += a.campaign_count || 0;
      const cat = a.status_category;
      if (cat === 'on_track') t.on += 1;
      else if (cat === 'under_pacing') t.under += 1;
      else if (cat === 'over_pacing') t.over += 1;
    });
    return t;
  }, [accounts]);

  const filteredAccounts = useMemo(() => {
    if (filter === 'all') return accounts;
    const map = { on: 'on_track', under: 'under_pacing', over: 'over_pacing' };
    return accounts.filter((a) => a.status_category === map[filter]);
  }, [accounts, filter]);

  const pillForCategory = (cat) => {
    if (cat === 'on_track')     return { cls: 'bb-pill bb-pill-on',   text: 'On Pace' };
    if (cat === 'over_pacing')  return { cls: 'bb-pill bb-pill-down', text: 'Overspending' };
    if (cat === 'under_pacing') return { cls: 'bb-pill bb-pill-up',   text: 'Underspending' };
    return { cls: 'bb-pill bb-pill-muted', text: 'No data' };
  };

  return (
    <div className="bb-app">
      <Sidebar user={user} accounts={accounts} onAddAccount={() => setShowAdd(true)} />

      <main className="bb-main">
        <div className="bb-row-between" style={{ marginBottom: 18 }}>
          <div>
            <div className="bb-page-title">Your Accounts</div>
            <div className="bb-page-subtitle">All Meta ad accounts you're managing.</div>
          </div>
          <div className="bb-row">
            <button className="bb-btn bb-btn-primary" onClick={() => setShowAdd(true)}>+ Add Account</button>
            <button className="bb-btn bb-btn-ghost" onClick={handleLogout}>Log out</button>
          </div>
        </div>

        {error && <div className="bb-alert bb-alert-error">{error}</div>}

        {/* Global token card */}
        <div className="bb-card bb-section" style={{ marginBottom: 20 }}>
          <div className="bb-row-between" style={{ alignItems: 'flex-start' }}>
            <div>
              <div className="bb-section-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Key size={15} aria-hidden="true" /> Global Meta Token
              </div>
              <div className="bb-section-meta" style={{ marginTop: 4 }}>
                Shared across all accounts. Set a per-account override in each account's Settings if needed.
              </div>
              {hasGlobalToken && !showTokenInput && (
                <div style={{ marginTop: 8, fontSize: 13, color: 'var(--bb-text-muted)' }}>
                  Current token: <code style={{ background: '#f3f4f6', padding: '2px 6px', borderRadius: 4 }}>{globalTokenPreview}</code>
                </div>
              )}
            </div>
            {!showTokenInput && (
              <button className="bb-btn" onClick={() => setShowTokenInput(true)}>
                {hasGlobalToken ? 'Update token' : 'Set token'}
              </button>
            )}
          </div>

          {showTokenInput && (
            <div style={{ marginTop: 14, display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="password"
                className="bb-input"
                placeholder="EAAb… paste your system user token here"
                value={globalToken}
                onChange={(e) => setGlobalToken(e.target.value)}
                autoFocus
                style={{ maxWidth: 480 }}
              />
              <button
                className="bb-btn bb-btn-primary"
                onClick={handleSaveGlobalToken}
                disabled={tokenSaving || !globalToken.trim()}
              >
                {tokenSaving ? <Loader2 size={14} className="bb-spin" /> : <Save size={14} aria-hidden="true" />}
                Save
              </button>
              <button className="bb-btn" onClick={() => { setShowTokenInput(false); setGlobalToken(''); }}>
                <X size={14} aria-hidden="true" /> Cancel
              </button>
            </div>
          )}
        </div>

        {/* Stat tiles */}
        <div className="bb-grid bb-grid-5" style={{ marginBottom: 20 }}>
          <button className="bb-stat" onClick={() => setFilter('all')} style={{ textAlign: 'left', cursor: 'pointer' }}>
            <span className="bb-stat-label">Accounts</span>
            <span className="bb-stat-value">{totals.all}</span>
            <span className="bb-stat-sub">{totals.campaigns} campaigns total</span>
          </button>
          <button className="bb-stat bb-stat-on" onClick={() => setFilter('on')} style={{ textAlign: 'left', cursor: 'pointer' }}>
            <span className="bb-stat-label">On Pace</span>
            <span className="bb-stat-value">{totals.on}</span>
          </button>
          <button className="bb-stat bb-stat-under" onClick={() => setFilter('under')} style={{ textAlign: 'left', cursor: 'pointer' }}>
            <span className="bb-stat-label">Underspending</span>
            <span className="bb-stat-value">{totals.under}</span>
          </button>
          <button className="bb-stat bb-stat-over" onClick={() => setFilter('over')} style={{ textAlign: 'left', cursor: 'pointer' }}>
            <span className="bb-stat-label">Overspending</span>
            <span className="bb-stat-value">{totals.over}</span>
          </button>
          <div className="bb-stat">
            <span className="bb-stat-label">Monthly Budget</span>
            <span className="bb-stat-value">${totals.budget.toFixed(0)}</span>
          </div>
        </div>

        {/* Filter */}
        <div className="bb-filter-bar">
          {[['all','All'],['on','On Pace'],['under','Underspending'],['over','Overspending']].map(([k, lbl]) => (
            <button
              key={k}
              className={`bb-filter-btn ${filter === k ? 'is-active' : ''}`}
              onClick={() => setFilter(k)}
            >
              {lbl} ({k === 'all' ? totals.all : k === 'on' ? totals.on : k === 'under' ? totals.under : totals.over})
            </button>
          ))}
        </div>

        {loading ? (
          <div className="bb-card bb-section bb-muted">Loading accounts…</div>
        ) : filteredAccounts.length === 0 ? (
          <div className="bb-card bb-section" style={{ textAlign: 'center' }}>
            <p className="bb-muted" style={{ marginBottom: 12 }}>
              {accounts.length === 0 ? 'No accounts yet. Click + Add Account to get started.' : 'No accounts match this filter.'}
            </p>
            {accounts.length === 0 && (
              <button className="bb-btn bb-btn-primary" onClick={() => setShowAdd(true)}>+ Add Account</button>
            )}
          </div>
        ) : (
          <div className="bb-grid bb-grid-3">
            {filteredAccounts.map((account) => {
              const pill = pillForCategory(account.status_category);
              return (
                <div key={account.id} className="bb-account-card">
                  <div className="bb-account-card-head">
                    <div>
                      <div className="bb-account-name">{account.account_name}</div>
                      <div className="bb-account-meta">Meta ID: {account.meta_account_id || '—'}</div>
                    </div>
                    <span className={pill.cls}>{pill.text}</span>
                  </div>
                  <div className="bb-account-stats">
                    <div>
                      <div className="num">{account.campaign_count || 0}</div>
                      <div className="lbl">Campaigns</div>
                    </div>
                    <div>
                      <div className="num">${(account.total_monthly_budget || 0).toFixed(0)}</div>
                      <div className="lbl">Monthly Budget</div>
                    </div>
                    <div>
                      <div className="num">{account.pacing_status?.on_track || 0}</div>
                      <div className="lbl">On Pace</div>
                    </div>
                  </div>
                  <div className="bb-account-actions">
                    <button className="bb-btn bb-btn-primary" onClick={() => navigate(`/account/${account.id}`)}>
                      View Dashboard →
                    </button>
                    <button className="bb-btn" onClick={() => navigate(`/account/${account.id}/settings`)}>
                      Settings
                    </button>
                    <button
                      className="bb-btn"
                      title="Re-sync campaigns from Meta"
                      onClick={() => handleRefreshCampaigns(account.id, account.account_name)}
                      disabled={!!refreshing[account.id]}
                    >
                      {refreshing[account.id]
                        ? <Loader2 size={13} className="bb-spin" />
                        : <RefreshCw size={13} aria-hidden="true" />}
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
            <div className="bb-modal" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
              <div className="bb-modal-head">
                <div className="bb-modal-title">Add Account</div>
                <button className="bb-icon-btn" onClick={() => setShowAdd(false)} aria-label="Close">
                  <X size={18} aria-hidden="true" />
                </button>
              </div>
              <form onSubmit={handleCreateAccount}>
                <div className="bb-modal-body">
                  {error && <div className="bb-alert bb-alert-error" style={{ marginBottom: 12 }}>{error}</div>}

                  <div className="bb-form-group">
                    <label className="bb-form-label">Account Name</label>
                    <input
                      type="text"
                      className="bb-input"
                      placeholder="e.g., Harrah's Oklahoma"
                      value={newAccountName}
                      onChange={(e) => setNewAccountName(e.target.value)}
                      autoFocus
                    />
                  </div>

                  <div className="bb-form-group">
                    <label className="bb-form-label">Meta Ad Account ID</label>
                    <input
                      type="text"
                      className="bb-input"
                      placeholder="e.g., 123456789"
                      value={newMetaAccountId}
                      onChange={(e) => setNewMetaAccountId(e.target.value)}
                    />
                    <span className="bb-form-help">The number from Ads Manager. Just the digits — no "act_" needed.</span>
                  </div>

                  <div className="bb-form-group">
                    <label className="bb-form-label">
                      Token Override <span className="bb-muted" style={{ fontWeight: 400 }}>(optional)</span>
                    </label>
                    <input
                      type="password"
                      className="bb-input"
                      placeholder={hasGlobalToken ? 'Leave blank to use global token' : 'EAAb…'}
                      value={newMetaToken}
                      onChange={(e) => setNewMetaToken(e.target.value)}
                    />
                    <span className="bb-form-help">
                      {hasGlobalToken
                        ? `Global token is set (${globalTokenPreview}). Only fill this in if this account uses a different token.`
                        : 'No global token set — paste a token here, or cancel and set one above first.'}
                    </span>
                  </div>

                  <div className="bb-alert bb-alert-info" style={{ fontSize: 12 }}>
                    Active campaigns will be imported automatically after saving.
                  </div>
                </div>
                <div className="bb-modal-foot">
                  <button type="button" className="bb-btn" onClick={() => setShowAdd(false)} disabled={addSaving}>Cancel</button>
                  <button type="submit" className="bb-btn bb-btn-primary" disabled={addSaving}>
                    {addSaving ? <Loader2 size={14} className="bb-spin" /> : null}
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
