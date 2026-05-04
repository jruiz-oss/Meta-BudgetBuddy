import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import './Settings.css';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

function Settings({ user, onLogout }) {
  const { accountId } = useParams();
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
      const [settingsRes, flightsRes] = await Promise.all([
        axios.get(`${API_URL}/settings/${accountId}`, { withCredentials: true }),
        axios.get(`${API_URL}/settings/${accountId}/flights`, { withCredentials: true })
      ]);
      setSettings(settingsRes.data.settings);
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
      await axios.put(
        `${API_URL}/settings/${accountId}`,
        {
          min_daily_budget: parseFloat(settings.min_daily_budget),
          max_daily_change_percent: parseFloat(settings.max_daily_change_percent),
          pace_tolerance_percent: parseFloat(settings.pace_tolerance_percent),
          auto_adjust_enabled: settings.auto_adjust_enabled
        },
        { withCredentials: true }
      );
      setSuccess('Settings saved successfully');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save settings');
    }
  };

  const handleFlightChange = (flightId, field, value) => {
    setFlights(flights.map(f =>
      f.id === flightId ? { ...f, [field]: value } : f
    ));
  };

  const handleSaveFlights = async () => {
    setError('');
    setSuccess('');
    try {
      const updates = flights.map(f => ({
        id: f.id,
        flight_type: f.flight_type,
        flight_start_date: f.flight_start_date,
        flight_end_date: f.flight_end_date
      }));

      await axios.put(
        `${API_URL}/settings/${accountId}/flights/batch`,
        { updates },
        { withCredentials: true }
      );
      setSuccess('Flight settings updated successfully');
      await fetchData();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update flights');
    }
  };

  const handleLogout = () => {
    onLogout();
    navigate('/login');
  };

  if (loading) {
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
        <div className="container" style={{ textAlign: 'center', paddingTop: '60px' }}>
          <div className="loading">Loading settings...</div>
        </div>
      </div>
    );
  }

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
        <div className="breadcrumb">
          <button className="link-btn" onClick={() => navigate('/')}>Home</button> /
          <button className="link-btn" onClick={() => navigate(`/account/${accountId}`)}>
            Account
          </button> / Settings
        </div>

        <h2 style={{ marginBottom: '24px', color: '#1a1a1a' }}>Account Settings</h2>

        {error && <div className="alert alert-error">{error}</div>}
        {success && <div className="alert alert-success">{success}</div>}

        <div className="settings-tabs">
          <button
            className={`tab-btn ${activeTab === 'pacing' ? 'active' : ''}`}
            onClick={() => setActiveTab('pacing')}
          >
            Pacing Parameters
          </button>
          <button
            className={`tab-btn ${activeTab === 'flights' ? 'active' : ''}`}
            onClick={() => setActiveTab('flights')}
          >
            Campaign Flights
          </button>
        </div>

        {activeTab === 'pacing' && settings && (
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Pacing Configuration</h3>
            </div>
            <div className="settings-form">
              <div className="form-group">
                <label htmlFor="min-budget">Minimum Daily Budget</label>
                <input
                  id="min-budget"
                  type="number"
                  className="form-control"
                  value={settings.min_daily_budget}
                  onChange={(e) => handleSettingsChange('min_daily_budget', e.target.value)}
                  step="0.01"
                  min="0"
                />
                <small>Prevent budgets from dropping below this amount</small>
              </div>

              <div className="form-group">
                <label htmlFor="max-change">Max Daily Change (%)</label>
                <input
                  id="max-change"
                  type="number"
                  className="form-control"
                  value={settings.max_daily_change_percent}
                  onChange={(e) => handleSettingsChange('max_daily_change_percent', e.target.value)}
                  step="0.1"
                  min="0"
                  max="100"
                />
                <small>Limit daily budget adjustments to ±X%</small>
              </div>

              <div className="form-group">
                <label htmlFor="tolerance">Pace Tolerance (%)</label>
                <input
                  id="tolerance"
                  type="number"
                  className="form-control"
                  value={settings.pace_tolerance_percent}
                  onChange={(e) => handleSettingsChange('pace_tolerance_percent', e.target.value)}
                  step="0.1"
                  min="0"
                  max="100"
                />
                <small>Consider campaigns on-track within ±X% of ideal pace</small>
              </div>

              <div className="form-group">
                <label htmlFor="auto-adjust">
                  <input
                    id="auto-adjust"
                    type="checkbox"
                    checked={settings.auto_adjust_enabled || false}
                    onChange={(e) => handleSettingsChange('auto_adjust_enabled', e.target.checked)}
                  />
                  <span style={{ marginLeft: '8px' }}>Enable auto-adjustments</span>
                </label>
              </div>

              <button className="btn btn-primary" onClick={handleSaveSettings}>
                Save Settings
              </button>
            </div>
          </div>
        )}

        {activeTab === 'flights' && (
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Campaign Flight Settings</h3>
            </div>
            {flights.length === 0 ? (
              <p style={{ color: '#666', margin: '16px 0' }}>No campaigns found</p>
            ) : (
              <div className="flights-list">
                {flights.map((flight) => (
                  <div key={flight.id} className="flight-item">
                    <h4>{flight.campaign_name}</h4>
                    <div className="flight-form">
                      <div className="form-group">
                        <label>Flight Type</label>
                        <select
                          className="form-control"
                          value={flight.flight_type}
                          onChange={(e) => handleFlightChange(flight.id, 'flight_type', e.target.value)}
                        >
                          <option value="ALWAYS_ON">Always On</option>
                          <option value="LIMITED">Limited Time</option>
                        </select>
                      </div>

                      {flight.flight_type === 'LIMITED' && (
                        <>
                          <div className="form-group">
                            <label>Start Date</label>
                            <input
                              type="datetime-local"
                              className="form-control"
                              value={flight.flight_start_date ? flight.flight_start_date.replace('Z', '') : ''}
                              onChange={(e) => handleFlightChange(flight.id, 'flight_start_date', e.target.value)}
                            />
                          </div>
                          <div className="form-group">
                            <label>End Date</label>
                            <input
                              type="datetime-local"
                              className="form-control"
                              value={flight.flight_end_date ? flight.flight_end_date.replace('Z', '') : ''}
                              onChange={(e) => handleFlightChange(flight.id, 'flight_end_date', e.target.value)}
                            />
                          </div>
                        </>
                      )}

                      <span className={`badge badge-${flight.flight_status}`}>
                        {flight.flight_status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {flights.length > 0 && (
              <button className="btn btn-primary" onClick={handleSaveFlights} style={{ marginTop: '20px' }}>
                Save Flight Settings
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default Settings;
