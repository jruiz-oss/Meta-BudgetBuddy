import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
import Sidebar from '../components/Sidebar';

function Settings({ user, onLogout }) {
  const { accountId } = useParams();
  const [accounts, setAccounts] = useState([]);
  const [activeTab, setActiveTab] = useState('pacing');
  const [settings, setSettings] = useState(null);
  const [flights, setFlights] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const navigate = useNavigate();

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [accountsRes, settingsRes, flightsRes] = await Promise.all([
        axios.get('/api/accounts'),
        axios.get(`/api/settings/${accountId}`),
        axios.get(`/api/settings/${accountId}/flights`),
      ]);
      setAccounts(accountsRes.data.accounts || accountsRes.data || []);
      setSettings(settingsRes.data.settings || settingsRes.data);
      setFlights(flightsRes.data.flights || []);
    } catch (err) {
      setError('Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSettingsChange = (field, value) => {
    setSettings({ ...settings, [field]: value });
  };

  const handleSaveSettings = async () => {
    setError('');
    setSuccess('');
    try {
      await axios.put(`/api/settings/${accountId}`, {
        min_daily_budget: parseFloat(settings.min_daily_budget),
        max_daily_change_percent: parseFloat(settings.max_daily_change_percent),
        pace_tolerance_percent: parseFloat(settings.pace_tolerance_percent),
        auto_adjust_enabled: !!settings.auto_adjust_enabled,
      });
      setSuccess('Settings saved.');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save settings');
    }
  };

  const handleFlightChange = (flightId, field, value) => {
    setFlights(flights.map((f) => (f.id === flightId ? { ...f, [field]: value } : f)));
  };

  const handleSaveFlights = async () => {
    setError('');
    setSuccess('');
    try {
      const updates = flights.map((f) => ({
        id: f.id,
        flight_type: f.flight_type,
        flight_start_date: f.flight_start_date,
        flight_end_date: f.flight_end_date,
      }));
      await axios.put(`/api/settings/${accountId}/flights/batch`, { updates });
      setSuccess('Flight settings updated.');
      fetchData();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update flights');
    }
  };

  const handleLogout = async () => {
    try {
      await axios.post('/api/auth/logout');
    } catch { /* ignore */ }
    onLogout();
    navigate('/login');
  };

  const flightStatusPill = (status) => {
    const s = (status || '').toLowerCase();
    if (s === 'active' || s === 'live')      return <span className="bb-pill bb-pill-on">{status}</span>;
    if (s === 'scheduled' || s === 'pending') return <span className="bb-pill bb-pill-up">{status}</span>;
    if (s === 'ended')                        return <span className="bb-pill bb-pill-down">{status}</span>;
    return <span className="bb-pill bb-pill-muted">{status || '—'}</span>;
  };

  return (
    <div className="bb-app">
      <Sidebar user={user} accounts={accounts} variant="account" />

      <main className="bb-main">
        <div className="bb-breadcrumb">
          <Link to="/">Home</Link>
          {' / '}
          <Link to={`/account/${accountId}`}>Dashboard</Link>
          {' / Settings'}
        </div>

        <div className="bb-row-between" style={{ marginBottom: 18 }}>
          <div>
            <div className="bb-page-title">Account Settings</div>
            <div className="bb-page-subtitle">Pacing parameters and campaign flight schedules.</div>
          </div>
          <button className="bb-btn bb-btn-ghost" onClick={handleLogout}>Log out</button>
        </div>

        {error && <div className="bb-alert bb-alert-error">{error}</div>}
        {success && <div className="bb-alert bb-alert-success">{success}</div>}

        <div className="bb-tabs">
          <button
            className={`bb-tab-btn ${activeTab === 'pacing' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('pacing')}
          >
            Pacing Parameters
          </button>
          <button
            className={`bb-tab-btn ${activeTab === 'flights' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('flights')}
          >
            Campaign Flights
          </button>
        </div>

        {loading ? (
          <div className="bb-card bb-section bb-muted">Loading...</div>
        ) : activeTab === 'pacing' && settings ? (
          <div className="bb-card">
            <div className="bb-section">
              <div className="bb-section-head">
                <div className="bb-section-title">Pacing Configuration</div>
                <div className="bb-section-meta">How aggressively the auto-pacer adjusts daily budgets.</div>
              </div>

              <div className="bb-grid bb-grid-2">
                <div className="bb-form-group">
                  <label className="bb-form-label">Minimum Daily Budget</label>
                  <input
                    type="number"
                    className="bb-input"
                    value={settings.min_daily_budget ?? 0}
                    onChange={(e) => handleSettingsChange('min_daily_budget', e.target.value)}
                    step="0.01"
                    min="0"
                  />
                  <span className="bb-form-help">Prevent budgets from dropping below this amount.</span>
                </div>

                <div className="bb-form-group">
                  <label className="bb-form-label">Max Daily Change (%)</label>
                  <input
                    type="number"
                    className="bb-input"
                    value={settings.max_daily_change_percent ?? 25}
                    onChange={(e) => handleSettingsChange('max_daily_change_percent', e.target.value)}
                    step="0.1"
                    min="0"
                    max="100"
                  />
                  <span className="bb-form-help">Cap any single adjustment to ±X% of current budget.</span>
                </div>

                <div className="bb-form-group">
                  <label className="bb-form-label">Pace Tolerance (%)</label>
                  <input
                    type="number"
                    className="bb-input"
                    value={settings.pace_tolerance_percent ?? 5}
                    onChange={(e) => handleSettingsChange('pace_tolerance_percent', e.target.value)}
                    step="0.1"
                    min="0"
                    max="100"
                  />
                  <span className="bb-form-help">Campaigns within ±X% of ideal pace are considered "on pace".</span>
                </div>

                <div className="bb-form-group">
                  <label className="bb-form-label">Auto-adjust</label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                    <input
                      type="checkbox"
                      checked={!!settings.auto_adjust_enabled}
                      onChange={(e) => handleSettingsChange('auto_adjust_enabled', e.target.checked)}
                    />
                    <span>Apply recommendations automatically</span>
                  </label>
                  <span className="bb-form-help">When off, you'll review and apply manually from the dashboard.</span>
                </div>
              </div>

              <div style={{ marginTop: 16 }}>
                <button className="bb-btn bb-btn-primary" onClick={handleSaveSettings}>
                  Save settings
                </button>
              </div>
            </div>
          </div>
        ) : activeTab === 'flights' ? (
          <div className="bb-card">
            <div className="bb-section">
              <div className="bb-section-head">
                <div className="bb-section-title">Campaign Flight Schedules</div>
                <div className="bb-section-meta">
                  Always-on campaigns run continuously. Limited campaigns only pace inside their flight window.
                </div>
              </div>

              {flights.length === 0 ? (
                <div className="bb-muted">No campaigns to configure yet. Import some from the dashboard first.</div>
              ) : (
                <table className="bb-table">
                  <thead>
                    <tr>
                      <th>Campaign</th>
                      <th>Flight Type</th>
                      <th>Start</th>
                      <th>End</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {flights.map((flight) => {
                      const isLimited = flight.flight_type === 'LIMITED';
                      return (
                        <tr key={flight.id}>
                          <td style={{ fontWeight: 600 }}>{flight.campaign_name}</td>
                          <td>
                            <select
                              className="bb-select"
                              value={flight.flight_type || 'ALWAYS_ON'}
                              onChange={(e) => handleFlightChange(flight.id, 'flight_type', e.target.value)}
                            >
                              <option value="ALWAYS_ON">Always On</option>
                              <option value="LIMITED">Limited</option>
                            </select>
                          </td>
                          <td>
                            <input
                              type="datetime-local"
                              className="bb-input"
                              disabled={!isLimited}
                              value={flight.flight_start_date ? flight.flight_start_date.replace('Z', '') : ''}
                              onChange={(e) => handleFlightChange(flight.id, 'flight_start_date', e.target.value)}
                            />
                          </td>
                          <td>
                            <input
                              type="datetime-local"
                              className="bb-input"
                              disabled={!isLimited}
                              value={flight.flight_end_date ? flight.flight_end_date.replace('Z', '') : ''}
                              onChange={(e) => handleFlightChange(flight.id, 'flight_end_date', e.target.value)}
                            />
                          </td>
                          <td>{flightStatusPill(flight.flight_status)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}

              {flights.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <button className="bb-btn bb-btn-primary" onClick={handleSaveFlights}>
                    Save flight settings
                  </button>
                </div>
              )}
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}

export default Settings;
