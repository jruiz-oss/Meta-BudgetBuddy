import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import './Home.css';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

function Home({ user, onLogout }) {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newAccountName, setNewAccountName] = useState('');
  const [newMetaAccountId, setNewMetaAccountId] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    fetchAccounts();
  }, []);

  const fetchAccounts = async () => {
    try {
      setLoading(true);
      const response = await axios.get(`${API_URL}/accounts`, { withCredentials: true });
      setAccounts(response.data.accounts || []);
    } catch (err) {
      setError('Failed to load accounts');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateAccount = async (e) => {
    e.preventDefault();
    setError('');

    if (!newAccountName || !newMetaAccountId) {
      setError('Please fill in all fields');
      return;
    }

    try {
      const response = await axios.post(
        `${API_URL}/accounts`,
        {
          account_name: newAccountName,
          meta_account_id: newMetaAccountId
        },
        { withCredentials: true }
      );

      setAccounts([...accounts, response.data.account]);
      setNewAccountName('');
      setNewMetaAccountId('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create account');
    }
  };

  const handleLogout = () => {
    onLogout();
    navigate('/login');
  };

  const getCategoryColor = (category) => {
    if (category === 'on_track') return '#28a745';
    if (category === 'over_pacing') return '#dc3545';
    if (category === 'under_pacing') return '#ffc107';
    return '#6c757d';
  };

  const getCategoryEmoji = (category) => {
    if (category === 'on_track') return '✓';
    if (category === 'over_pacing') return '↑';
    if (category === 'under_pacing') return '↓';
    return '○';
  };

  return (
    <div className="page">
      <div className="header">
        <h1>Meta BudgetBuddy</h1>
        <div className="header-actions">
          <span className="header-user">{user.email}</span>
          <button className="btn btn-secondary btn-small" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </div>

      <div className="container">
        <h2 style={{ marginBottom: '24px', color: '#1a1a1a' }}>Your Ad Accounts</h2>

        {error && <div className="alert alert-error">{error}</div>}

        {loading ? (
          <div className="loading" style={{ height: '200px' }}>Loading accounts...</div>
        ) : (
          <>
            {/* Add New Account Form */}
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">Add New Account</h3>
              </div>
              <form onSubmit={handleCreateAccount}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: '12px' }}>
                  <div className="form-group">
                    <label htmlFor="account-name">Account Name</label>
                    <input
                      id="account-name"
                      type="text"
                      className="form-control"
                      placeholder="e.g., Main Account"
                      value={newAccountName}
                      onChange={(e) => setNewAccountName(e.target.value)}
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="meta-account-id">Meta Account ID</label>
                    <input
                      id="meta-account-id"
                      type="text"
                      className="form-control"
                      placeholder="e.g., 123456789"
                      value={newMetaAccountId}
                      onChange={(e) => setNewMetaAccountId(e.target.value)}
                    />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                    <button type="submit" className="btn btn-primary">
                      Add Account
                    </button>
                  </div>
                </div>
              </form>
            </div>

            {/* Accounts Grid */}
            <div className="grid grid-2">
              {accounts.map((account) => (
                <div key={account.id} className="account-card">
                  <div className="account-header">
                    <h3>{account.account_name}</h3>
                    <div
                      className="status-badge"
                      style={{ backgroundColor: getCategoryColor(account.status_category) }}
                    >
                      {getCategoryEmoji(account.status_category)} {account.status_category}
                    </div>
                  </div>

                  <div className="account-meta">
                    <p><strong>Meta ID:</strong> {account.meta_account_id}</p>
                    <p><strong>Campaigns:</strong> {account.campaign_count}</p>
                    <p><strong>Daily Budget:</strong> ${account.total_daily_budget}</p>
                  </div>

                  <div className="pacing-summary">
                    <div className="pacing-stat">
                      <span className="stat-value" style={{ color: '#28a745' }}>
                        {account.pacing_status.on_track}
                      </span>
                      <span className="stat-label">On Track</span>
                    </div>
                    <div className="pacing-stat">
                      <span className="stat-value" style={{ color: '#dc3545' }}>
                        {account.pacing_status.over_pacing}
                      </span>
                      <span className="stat-label">Over Pacing</span>
                    </div>
                    <div className="pacing-stat">
                      <span className="stat-value" style={{ color: '#ffc107' }}>
                        {account.pacing_status.under_pacing}
                      </span>
                      <span className="stat-label">Under Pacing</span>
                    </div>
                  </div>

                  <div className="account-actions">
                    <button
                      className="btn btn-primary btn-small"
                      onClick={() => navigate(`/account/${account.id}`)}
                    >
                      View Dashboard
                    </button>
                    <button
                      className="btn btn-secondary btn-small"
                      onClick={() => navigate(`/account/${account.id}/settings`)}
                    >
                      Settings
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {accounts.length === 0 && (
              <div className="card" style={{ textAlign: 'center', padding: '40px' }}>
                <p style={{ color: '#666', marginBottom: '16px' }}>No accounts yet. Add one above to get started.</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default Home;
