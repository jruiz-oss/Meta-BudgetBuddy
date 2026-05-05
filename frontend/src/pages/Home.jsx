import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import Sidebar from '../components/Sidebar';

/**
 * Home dashboard — shows every account the user has, grouped by pacing status.
 *
 * Layout: sidebar + main. Main has a strip of 5 stat tiles (totals, on-pace,
 * overspending, underspending, daily-budget total) followed by a filter
 * pill row and a 3-column grid of account cards.
 */
function Home({ user, onLogout }) {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newAccountName, setNewAccountName] = useState('');
  const [newMetaAccountId, setNewMetaAccountId] = useState('');
  const [newMetaToken, setNewMetaToken] = useState('');
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const navigate = useNavigate();

  useEffect(() => {
    fetchAccounts();
  }, []);

  const fetchAccounts = async () => {
    try {
      setLoading(true);
      const response = await axios.get('/api/accounts');
      setAccounts(response.data.accounts || response.data || []);
    } catch (err) {
      setError('Failed to load accounts');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateAccount = async (e) => {
    e.preventDefault();
    setError('');
    if (!newAccountName || !newMetaAccountId || !newMetaToken) {
      setError('All three fields are required.');
      return;
    }
    try {
      const response = await axios.post('/api/accounts', {
        account_name: newAccountName,
        meta_account_id: newMetaAccountId,
        meta_token: newMetaToken,
      });
      const created = response.data.account || response.data;
      setAccounts([...accounts, created]);
      setNewAccountName('');
      setNewMetaAccountId('');
      setNewMetaToken('');
      setShowAdd(false);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create account');
    }
  };

  const handleLogout = async () => {
    try {
      await axios.post('/api/auth/logout');
    } catch { /* ignore */ }
    onLogout();
    navigate('/login');
  };

  // ---- Status counts ----
  const totals = useMemo(() => {
    const t = { all: accounts.length, on: 0, under: 0, over: 0, dailyBudget: 0, campaigns: 0 };
    accounts.forEach((a) => {
      t.dailyBudget += a.total_monthly_budget || 0;
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
      <Sidebar
        user={user}
        accounts={accounts}
        onAddAccount={() => setShowAdd(true)}
        variant="home"
      />

      <main className="bb-main">
        <div className="bb-row-between" style={{ marginBottom: 18 }}>
          <div>
            <div className="bb-page-title">Your Accounts</div>
            <div className="bb-page-subtitle">All Meta ad accounts you're managing.</div>
          </div>
          <div className="bb-row">
            <button className="bb-btn bb-btn-primary" onClick={() => setShowAdd(true)}>
              + Add Account
            </button>
            <button className="bb-btn bb-btn-ghost" onClick={handleLogout}>Log out</button>
          </div>
        </div>

        {error && <div className="bb-alert bb-alert-error">{error}</div>}

        {/* 5 stat tiles */}
        <div className="bb-grid bb-grid-5" style={{ marginBottom: 20 }}>
          <button className="bb-stat" onClick={() => setFilter('all')} style={{ textAlign: 'left', cursor: 'pointer' }}>
            <span className="bb-stat-label">Accounts</span>
            <span className="bb-stat-value">{totals.all}</span>
            <span className="bb-stat-sub">{totals.campaigns} campaigns total</span>
          </button>
          <button className="bb-stat bb-stat-on" onClick={() => setFilter('on')} style={{ textAlign: 'left', cursor: 'pointer' }}>
            <span className="bb-stat-label">On Pace</span>
            <span className="bb-stat-value">{totals.on}</span>
            <span className="bb-stat-sub">campaigns within tolerance</span>
          </button>
          <button className="bb-stat bb-stat-under" onClick={() => setFilter('under')} style={{ textAlign: 'left', cursor: 'pointer' }}>
            <span className="bb-stat-label">Underspending</span>
            <span className="bb-stat-value">{totals.under}</span>
            <span className="bb-stat-sub">need to spend more</span>
          </button>
          <button className="bb-stat bb-stat-over" onClick={() => setFilter('over')} style={{ textAlign: 'left', cursor: 'pointer' }}>
            <span className="bb-stat-label">Overspending</span>
            <span className="bb-stat-value">{totals.over}</span>
            <span className="bb-stat-sub">need to slow down</span>
          </button>
          <div className="bb-stat">
            <span className="bb-stat-label">Monthly Budget</span>
            <span className="bb-stat-value">${totals.dailyBudget.toFixed(0)}</span>
            <span className="bb-stat-sub">across all accounts</span>
          </div>
        </div>

        {/* Filter row */}
        <div className="bb-filter-bar">
          <button className={`bb-filter-btn ${filter === 'all'   ? 'is-active' : ''}`} onClick={() => setFilter('all')}>All ({totals.all})</button>
          <button className={`bb-filter-btn ${filter === 'on'    ? 'is-active' : ''}`} onClick={() => setFilter('on')}>On Pace ({totals.on})</button>
          <button className={`bb-filter-btn ${filter === 'under' ? 'is-active' : ''}`} onClick={() => setFilter('under')}>Underspending ({totals.under})</button>
          <button className={`bb-filter-btn ${filter === 'over'  ? 'is-active' : ''}`} onClick={() => setFilter('over')}>Overspending ({totals.over})</button>
        </div>

        {loading ? (
          <div className="bb-card bb-section bb-muted">Loading accounts...</div>
        ) : filteredAccounts.length === 0 ? (
          <div className="bb-card bb-section" style={{ textAlign: 'center' }}>
            <p className="bb-muted" style={{ marginBottom: 12 }}>
              {accounts.length === 0
                ? 'No accounts yet. Click + Add Account to get started.'
                : 'No accounts match this filter.'}
            </p>
            {accounts.length === 0 && (
              <button className="bb-btn bb-btn-primary" onClick={() => setShowAdd(true)}>
                + Add Account
              </button>
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
                    <button
                      className="bb-btn bb-btn-primary"
                      onClick={() => navigate(`/account/${account.id}`)}
                    >
                      View Dashboard →
                    </button>
                    <button
                      className="bb-btn"
                      onClick={() => navigate(`/account/${account.id}/settings`)}
                    >
                      Settings
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
                <button className="bb-icon-btn" onClick={() => setShowAdd(false)}>×</button>
              </div>
              <form onSubmit={handleCreateAccount}>
                <div className="bb-modal-body">
                  <div className="bb-form-group">
                    <label className="bb-form-label">Account Name</label>
                    <input
                      type="text"
                      className="bb-input"
                      placeholder="e.g., Acme Resorts"
                      value={newAccountName}
                      onChange={(e) => setNewAccountName(e.target.value)}
                      autoFocus
                    />
                  </div>
                  <div className="bb-form-group">
                    <label className="bb-form-label">Meta Account ID</label>
                    <input
                      type="text"
                      className="bb-input"
                      placeholder="e.g., act_123456789"
                      value={newMetaAccountId}
                      onChange={(e) => setNewMetaAccountId(e.target.value)}
                    />
                    <span className="bb-form-help">From Meta Ads Manager — usually starts with "act_".</span>
                  </div>
                  <div className="bb-form-group">
                    <label className="bb-form-label">Meta Access Token</label>
                    <input
                      type="password"
                      className="bb-input"
                      placeholder="EAAb..."
                      value={newMetaToken}
                      onChange={(e) => setNewMetaToken(e.target.value)}
                    />
                    <span className="bb-form-help">From Meta Business Manager → System Users, or your personal token from developers.facebook.com. Needs ads_management + read_insights permissions.</span>
                  </div>
                </div>
                <div className="bb-modal-foot">
                  <button type="button" className="bb-btn" onClick={() => setShowAdd(false)}>Cancel</button>
                  <button type="submit" className="bb-btn bb-btn-primary">Create</button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default Home;
