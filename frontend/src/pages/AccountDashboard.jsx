/* eslint-disable react-hooks/exhaustive-deps */
import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
import './Dashboard.css';

function AccountDashboard({ user, onLogout }) {
  const { accountId } = useParams();
  const navigate = useNavigate();
  const [account, setAccount] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pacingRunning, setPacingRunning] = useState(false);

  // Import-from-Meta modal state
  const [showImport, setShowImport] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState('');
  const [importSaving, setImportSaving] = useState(false);
  const [metaCampaigns, setMetaCampaigns] = useState([]); // raw list from /sync GET
  const [importSelections, setImportSelections] = useState({}); // { meta_id: { selected, monthly_budget } }

  // Latest pacing run details (for showing recommendations + Apply button)
  const [lastRun, setLastRun] = useState(null);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    fetchAccountData();
  }, [accountId]);

  const fetchAccountData = async () => {
    try {
      const [accountRes, campaignsRes] = await Promise.all([
        axios.get(`/api/accounts/${accountId}`),
        axios.get(`/api/campaigns/${accountId}`)
      ]);
      setAccount(accountRes.data);
      setCampaigns(campaignsRes.data.campaigns);
      setLoading(false);
    } catch (err) {
      setError('Failed to load account data');
      setLoading(false);
    }
  };

  const handleRunPacing = async () => {
    setPacingRunning(true);
    setError('');
    setApplyResult(null);
    try {
      const response = await axios.post(`/api/pacing/${accountId}/run`, {
        run_type: 'MANUAL'
      });
      setLastRun(response.data);
      // Refresh campaigns so the badges update
      fetchAccountData();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to run pacing calculations');
    } finally {
      setPacingRunning(false);
    }
  };

  const handleApplyAll = async () => {
    if (!lastRun || !lastRun.recommendations) return;
    const adjustments = lastRun.recommendations
      .filter(r => r.action !== 'ON_PACE')
      .map(r => ({
        campaign_id: r.campaign_id,
        current_daily_budget: r.current_daily_budget,
        recommended_daily_budget: r.recommended_daily_budget,
        change_percent: r.change_percent,
        action: r.action,
      }));

    if (adjustments.length === 0) {
      setApplyResult({ message: 'Nothing to apply — everything is on pace.' });
      return;
    }

    setApplying(true);
    setError('');
    try {
      const response = await axios.post(`/api/pacing/${accountId}/apply`, { adjustments });
      setApplyResult(response.data);
      fetchAccountData();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to apply recommendations');
    } finally {
      setApplying(false);
    }
  };

  const openImport = async () => {
    setShowImport(true);
    setImportLoading(true);
    setImportError('');
    setMetaCampaigns([]);
    setImportSelections({});
    try {
      const response = await axios.get(`/api/campaigns/${accountId}/sync`);
      const list = response.data.campaigns || [];
      setMetaCampaigns(list);
      // Pre-select campaigns already tracked
      const seed = {};
      list.forEach(c => {
        seed[c.meta_campaign_id] = {
          selected: !!c.already_tracked,
          monthly_budget: c.current_daily_budget ? Math.round(c.current_daily_budget * 30) : '',
        };
      });
      setImportSelections(seed);
    } catch (err) {
      setImportError(
        err.response?.data?.error ||
          'Could not fetch campaigns from Meta. Check the access token + ad account ID on this account.'
      );
    } finally {
      setImportLoading(false);
    }
  };

  const closeImport = () => {
    setShowImport(false);
    setImportError('');
  };

  const toggleImportSelection = (metaId) => {
    setImportSelections(prev => ({
      ...prev,
      [metaId]: { ...prev[metaId], selected: !prev[metaId]?.selected },
    }));
  };

  const updateImportBudget = (metaId, value) => {
    setImportSelections(prev => ({
      ...prev,
      [metaId]: { ...prev[metaId], monthly_budget: value },
    }));
  };

  const saveImport = async () => {
    const chosen = metaCampaigns
      .filter(c => importSelections[c.meta_campaign_id]?.selected)
      .map(c => {
        const sel = importSelections[c.meta_campaign_id];
        return {
          meta_campaign_id: c.meta_campaign_id,
          campaign_name: c.name,
          monthly_budget: parseFloat(sel.monthly_budget) || 0,
          flight_type: 'ALWAYS_ON',
        };
      })
      .filter(c => c.monthly_budget > 0);

    if (chosen.length === 0) {
      setImportError('Pick at least one campaign and give it a monthly budget.');
      return;
    }

    setImportSaving(true);
    setImportError('');
    try {
      await axios.post(`/api/campaigns/${accountId}/sync`, { campaigns: chosen });
      closeImport();
      fetchAccountData();
    } catch (err) {
      setImportError(err.response?.data?.error || 'Failed to save campaigns');
    } finally {
      setImportSaving(false);
    }
  };

  const handleLogout = async () => {
    try {
      await axios.post('/api/auth/logout');
      onLogout();
      navigate('/login');
    } catch (err) {
      console.error('Logout failed');
    }
  };

  if (loading) {
    return (
      <div className="app-container">
        <div className="navbar">
          <h1>Meta BudgetBuddy</h1>
          <div className="navbar-right">
            <button className="logout-btn" onClick={handleLogout}>Logout</button>
          </div>
        </div>
        <div className="main-content">Loading account...</div>
      </div>
    );
  }

  if (!account) {
    return (
      <div className="app-container">
        <div className="navbar">
          <h1>Meta BudgetBuddy</h1>
          <div className="navbar-right">
            <button className="logout-btn" onClick={handleLogout}>Logout</button>
          </div>
        </div>
        <div className="main-content">Account not found</div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <div className="navbar">
        <div>
          <h1>Meta BudgetBuddy</h1>
          <p className="breadcrumb">
            <Link to="/">Dashboard</Link> / {account.account_name}
          </p>
        </div>
        <div className="navbar-right">
          <button className="logout-btn" onClick={handleLogout}>Logout</button>
        </div>
      </div>

      <div className="main-content">
        <div className="dashboard-header">
          <div>
            <h2>{account.account_name}</h2>
            <p className="meta-id">ID: {account.meta_account_id}</p>
          </div>
          <div className="dashboard-actions">
            <button className="btn btn-secondary" onClick={openImport}>
              Import from Meta
            </button>
            <Link to={`/account/${accountId}/settings`} className="btn btn-secondary">
              Settings
            </Link>
            <Link to={`/account/${accountId}/history`} className="btn btn-secondary">
              History
            </Link>
            <button
              className="btn btn-primary"
              onClick={handleRunPacing}
              disabled={pacingRunning}
            >
              {pacingRunning ? 'Running...' : 'Run Pacing'}
            </button>
          </div>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        {lastRun && (
          <div className="card">
            <div className="card-header">
              <h3>
                Latest run — {lastRun.campaigns_processed} campaigns, {lastRun.adjustments_needed} need adjusting
              </h3>
              <button
                className="btn btn-primary"
                onClick={handleApplyAll}
                disabled={applying || lastRun.adjustments_needed === 0}
              >
                {applying ? 'Applying...' : 'Apply all to Meta'}
              </button>
            </div>
            {lastRun.failures && lastRun.failures.length > 0 && (
              <div className="alert alert-error">
                {lastRun.failures.length} campaign(s) failed:&nbsp;
                {lastRun.failures.map(f => `${f.campaign_name}: ${f.error}`).join(' — ')}
              </div>
            )}
            {applyResult && (
              <div className="alert alert-success">
                {applyResult.message}
              </div>
            )}
            {lastRun.recommendations && lastRun.recommendations.length > 0 && (
              <table className="table">
                <thead>
                  <tr>
                    <th>Campaign</th>
                    <th>MTD spend</th>
                    <th>Expected</th>
                    <th>Pace</th>
                    <th>Current daily</th>
                    <th>Recommended</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {lastRun.recommendations.map(r => (
                    <tr key={r.campaign_id}>
                      <td>{r.campaign_name}</td>
                      <td>${r.actual_spend.toFixed(2)}</td>
                      <td>${r.expected_spend.toFixed(2)}</td>
                      <td>
                        <span className={r.pace_ratio > 1.05 ? 'over-spending' : r.pace_ratio < 0.95 ? 'under-spending' : ''}>
                          {r.pace_ratio.toFixed(2)}x
                        </span>
                      </td>
                      <td>${r.current_daily_budget.toFixed(2)}</td>
                      <td>${r.recommended_daily_budget.toFixed(2)}</td>
                      <td>
                        <span className={`status-badge status-${r.action.toLowerCase()}`}>
                          {r.action}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        <div className="card">
          <div className="card-header">
            <h3>Tracked campaigns ({campaigns.length})</h3>
          </div>

          {campaigns.length === 0 ? (
            <p className="no-data">
              No campaigns tracked yet. Click <strong>Import from Meta</strong> above to pull them in.
            </p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Campaign Name</th>
                  <th>Status</th>
                  <th>Monthly Budget</th>
                  <th>Pace Ratio</th>
                  <th>Recommendation</th>
                  <th>Flight</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map(campaign => (
                  <tr key={campaign.id}>
                    <td className="campaign-name">{campaign.campaign_name}</td>
                    <td>
                      {campaign.latest_pacing && (
                        <span className={`status-badge status-${campaign.latest_pacing.status.toLowerCase()}`}>
                          {campaign.latest_pacing.status}
                        </span>
                      )}
                    </td>
                    <td>${campaign.monthly_budget.toFixed(2)}</td>
                    <td>
                      {campaign.latest_pacing ? (
                        <span className={campaign.latest_pacing.pace_ratio > 1.05 ? 'over-spending' : campaign.latest_pacing.pace_ratio < 0.95 ? 'under-spending' : ''}>
                          {campaign.latest_pacing.pace_ratio.toFixed(2)}x
                        </span>
                      ) : (
                        '–'
                      )}
                    </td>
                    <td>
                      {campaign.latest_pacing && (
                        <span className={`change-${campaign.latest_pacing.status.toLowerCase()}`}>
                          {campaign.latest_pacing.change_percent > 0 ? '+' : ''}{campaign.latest_pacing.change_percent.toFixed(1)}%
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`flight-badge flight-${campaign.flight_status.toLowerCase()}`}>
                        {campaign.flight_status}
                      </span>
                    </td>
                    <td>
                      <Link
                        to={`/account/${accountId}/campaign/${campaign.id}`}
                        className="link"
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {showImport && (
        <div className="modal-backdrop" onClick={closeImport}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Import campaigns from Meta</h3>
              <button className="close-btn" onClick={closeImport}>×</button>
            </div>

            <div className="modal-body">
              {importLoading && <p>Fetching campaigns from Meta...</p>}
              {importError && <div className="alert alert-error">{importError}</div>}

              {!importLoading && metaCampaigns.length > 0 && (
                <>
                  <p className="muted">
                    Pick the campaigns you want to track and set a monthly budget for each.
                    The default monthly budget is <em>current daily × 30</em>; edit as needed.
                  </p>
                  <table className="table">
                    <thead>
                      <tr>
                        <th></th>
                        <th>Campaign</th>
                        <th>Status</th>
                        <th>CBO?</th>
                        <th>Current daily</th>
                        <th>Monthly budget</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metaCampaigns.map(c => {
                        const sel = importSelections[c.meta_campaign_id] || {};
                        return (
                          <tr key={c.meta_campaign_id}>
                            <td>
                              <input
                                type="checkbox"
                                checked={!!sel.selected}
                                onChange={() => toggleImportSelection(c.meta_campaign_id)}
                              />
                            </td>
                            <td>
                              {c.name}
                              {c.already_tracked && <span className="muted"> (tracked)</span>}
                            </td>
                            <td>{c.effective_status || c.status}</td>
                            <td>{c.is_cbo ? 'Yes' : 'No'}</td>
                            <td>{c.current_daily_budget ? `$${c.current_daily_budget.toFixed(2)}` : '–'}</td>
                            <td>
                              <input
                                type="number"
                                step="1"
                                min="0"
                                placeholder="0.00"
                                value={sel.monthly_budget ?? ''}
                                onChange={e => updateImportBudget(c.meta_campaign_id, e.target.value)}
                                disabled={!sel.selected}
                                style={{ width: '110px' }}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </>
              )}

              {!importLoading && !importError && metaCampaigns.length === 0 && (
                <p>No active campaigns found in this Meta ad account.</p>
              )}
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={closeImport} disabled={importSaving}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={saveImport} disabled={importSaving || importLoading}>
                {importSaving ? 'Saving...' : 'Save selections'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AccountDashboard;
