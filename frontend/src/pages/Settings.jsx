import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
import Sidebar from '../components/Sidebar';

function Settings({ user, onLogout }) {
  const { accountId } = useParams();
  const navigate = useNavigate();

  const [accounts, setAccounts] = useState([]);
  const [activeTab, setActiveTab] = useState('pacing');
  const [settings, setSettings] = useState(null);
  const [flights, setFlights] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Google Sheets state
  const [sheetUrl, setSheetUrl] = useState('');
  const [sheetSaving, setSheetSaving] = useState(false);
  const [sheetPreview, setSheetPreview] = useState(null);
  const [sheetPreviewLoading, setSheetPreviewLoading] = useState(false);
  const [sheetSyncLoading, setSheetSyncLoading] = useState(false);
  const [sheetWriteLoading, setSheetWriteLoading] = useState(false);

  // ── Data loading ─────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [accountsRes, settingsRes, flightsRes, sheetConfigRes] = await Promise.all([
        axios.get('/api/accounts'),
        axios.get(`/api/settings/${accountId}`),
        axios.get(`/api/settings/${accountId}/flights`),
        axios.get(`/api/sheets/${accountId}/config`).catch(() => ({ data: { google_sheet_id: '' } })),
      ]);
      setAccounts(accountsRes.data.accounts || accountsRes.data || []);
      setSettings(settingsRes.data.settings || settingsRes.data);
      setFlights(flightsRes.data.flights || []);
      setSheetUrl(sheetConfigRes.data.google_sheet_id || '');
    } catch (err) {
      setError('Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Pacing settings ───────────────────────────────────────────────────────

  const handleSettingsChange = (field, value) => {
    setSettings({ ...settings, [field]: value });
  };

  const handleSaveSettings = async () => {
    setError(''); setSuccess('');
    try {
      // auto_adjust_enabled was never wired to any apply path, so the toggle was misleading.
      // The app applies recommendations manually only — see the dashboard's Apply button.
      await axios.put(`/api/settings/${accountId}`, {
        min_daily_budget: parseFloat(settings.min_daily_budget),
        max_daily_change_percent: parseFloat(settings.max_daily_change_percent),
        pace_tolerance_percent: parseFloat(settings.pace_tolerance_percent),
      });
      setSuccess('Settings saved.');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save settings');
    }
  };

  // ── Flight settings ───────────────────────────────────────────────────────

  const handleFlightChange = (flightId, field, value) => {
    setFlights(flights.map((f) => (f.id === flightId ? { ...f, [field]: value } : f)));
  };

  const handleSaveFlights = async () => {
    setError(''); setSuccess('');
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

  // ── Google Sheets handlers ────────────────────────────────────────────────

  const handleSaveSheetUrl = async () => {
    setError(''); setSuccess('');
    setSheetSaving(true);
    try {
      await axios.put(`/api/sheets/${accountId}/config`, { google_sheet_id: sheetUrl });
      setSuccess('Sheet URL saved.');
      setSheetPreview(null);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save Sheet URL');
    } finally {
      setSheetSaving(false);
    }
  };

  const handlePreviewSheet = async () => {
    setError(''); setSuccess('');
    setSheetPreviewLoading(true);
    setSheetPreview(null);
    try {
      const res = await axios.get(`/api/sheets/${accountId}/preview`);
      setSheetPreview(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to preview sheet');
    } finally {
      setSheetPreviewLoading(false);
    }
  };

  const handleSyncBudgets = async () => {
    setError(''); setSuccess('');
    setSheetSyncLoading(true);
    try {
      const res = await axios.post(`/api/sheets/${accountId}/sync-budgets`);
      setSuccess(`${res.data.message} (${res.data.skipped_count} skipped).`);
      setSheetPreview(null);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to sync budgets');
    } finally {
      setSheetSyncLoading(false);
    }
  };

  const handleWriteSpend = async () => {
    setError(''); setSuccess('');
    setSheetWriteLoading(true);
    try {
      const res = await axios.post(`/api/sheets/${accountId}/write-spend`);
      setSuccess(`${res.data.message} (${res.data.skipped_count} skipped).`);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to write spend to sheet');
    } finally {
      setSheetWriteLoading(false);
    }
  };

  // ── Auth ──────────────────────────────────────────────────────────────────

  const handleLogout = async () => {
    try { await axios.post('/api/auth/logout'); } catch { /* ignore */ }
    onLogout();
    navigate('/login');
  };

  // ── Helpers ───────────────────────────────────────────────────────────────

  const flightStatusPill = (status) => {
    const s = (status || '').toLowerCase();
    if (s === 'active' || s === 'live')       return <span className="bb-pill bb-pill-on">{status}</span>;
    if (s === 'scheduled' || s === 'pending') return <span className="bb-pill bb-pill-up">{status}</span>;
    if (s === 'ended')                        return <span className="bb-pill bb-pill-down">{status}</span>;
    return <span className="bb-pill bb-pill-muted">{status || '—'}</span>;
  };

  const matchQualityPill = (type) => {
    if (type === 'exact')            return <span className="bb-pill bb-pill-on">Exact</span>;
    if (type === 'case_insensitive') return <span className="bb-pill bb-pill-up">Case</span>;
    if (type === 'partial')          return <span className="bb-pill bb-pill-muted">Partial</span>;
    return <span className="bb-pill bb-pill-down">No match</span>;
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="bb-app">
      <Sidebar user={user} accounts={accounts} />

      <main className="bb-main">
        {/* Breadcrumb */}
        <div className="bb-breadcrumb">
          <Link to="/">Home</Link>{' / '}
          <Link to={`/account/${accountId}`}>Dashboard</Link>{' / Settings'}
        </div>

        {/* Page header */}
        <div className="bb-row-between" style={{ marginBottom: 18 }}>
          <div>
            <div className="bb-page-title">Account Settings</div>
            <div className="bb-page-subtitle">Pacing parameters, campaign flights, and Google Sheets sync.</div>
          </div>
          <button className="bb-btn bb-btn-ghost" onClick={handleLogout}>Log out</button>
        </div>

        {/* Alerts */}
        {error   && <div className="bb-alert bb-alert-error">{error}</div>}
        {success && <div className="bb-alert bb-alert-success">{success}</div>}

        {/* Tabs */}
        <div className="bb-tabs">
          <button className={`bb-tab-btn ${activeTab === 'pacing'  ? 'is-active' : ''}`} onClick={() => setActiveTab('pacing')}>
            Pacing Parameters
          </button>
          <button className={`bb-tab-btn ${activeTab === 'flights' ? 'is-active' : ''}`} onClick={() => setActiveTab('flights')}>
            Campaign Flights
          </button>
          <button className={`bb-tab-btn ${activeTab === 'sheets'  ? 'is-active' : ''}`} onClick={() => setActiveTab('sheets')}>
            Google Sheets
          </button>
        </div>

        {/* ── Tab: loading ── */}
        {loading ? (
          <div className="bb-card bb-section bb-muted">Loading…</div>

        /* ── Tab: Pacing Parameters ── */
        ) : activeTab === 'pacing' && settings ? (
          <div className="bb-card">
            <div className="bb-section">
              <div style={{ marginBottom: 16 }}>
                <div className="bb-section-title">Pacing Configuration</div>
                <div className="bb-section-meta" style={{ marginTop: 2 }}>
                  How aggressively the auto-pacer adjusts daily budgets.
                </div>
              </div>

              <div className="bb-grid bb-grid-2">
                <div className="bb-form-group">
                  <label className="bb-form-label">Minimum Daily Budget</label>
                  <input
                    type="number"
                    className="bb-input"
                    value={settings.min_daily_budget ?? 0}
                    onChange={(e) => handleSettingsChange('min_daily_budget', e.target.value)}
                    step="0.01" min="0"
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
                    step="0.1" min="0" max="100"
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
                    step="0.1" min="0" max="100"
                  />
                  <span className="bb-form-help">Campaigns within ±X% of ideal pace are "on pace".</span>
                </div>
              </div>

              <div className="bb-alert bb-alert-info" style={{ marginTop: 12 }}>
                Pacing runs nightly and writes recommendations. Budget changes are
                always pushed to Meta manually — review on the dashboard and click Apply.
              </div>

              <div style={{ marginTop: 16 }}>
                <button className="bb-btn bb-btn-primary" onClick={handleSaveSettings}>
                  Save settings
                </button>
              </div>
            </div>
          </div>

        /* ── Tab: Campaign Flights ── */
        ) : activeTab === 'flights' ? (
          <div className="bb-card">
            <div className="bb-section">
              <div style={{ marginBottom: 16 }}>
                <div className="bb-section-title">Campaign Flight Schedules</div>
                <div className="bb-section-meta" style={{ marginTop: 2 }}>
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

        /* ── Tab: Google Sheets ── */
        ) : activeTab === 'sheets' ? (
          <div className="bb-card">

            {/* Setup section */}
            <div className="bb-section">
              <div style={{ marginBottom: 16 }}>
                <div className="bb-section-title">Google Sheets Connection</div>
                <div className="bb-section-meta" style={{ marginTop: 2 }}>
                  Connect your "Social Budget Pacing" sheet to pull monthly budgets and push MTD spend automatically.
                </div>
              </div>

              {/* Info callout */}
              <div className="bb-alert bb-alert-info" style={{ marginBottom: 16 }}>
                <strong>Before you start:</strong> Make sure the service account email from your Google Cloud credentials
                has been added as an <strong>Editor</strong> on the sheet, and that
                {' '}<code>GOOGLE_CREDENTIALS_JSON</code> is set as an environment variable on Railway.
              </div>

              {/* Sheet URL input + buttons */}
              <div className="bb-form-group" style={{ maxWidth: 580 }}>
                <label className="bb-form-label">Sheet URL or ID</label>
                <input
                  type="text"
                  className="bb-input"
                  placeholder="https://docs.google.com/spreadsheets/d/..."
                  value={sheetUrl}
                  onChange={(e) => { setSheetUrl(e.target.value); setSheetPreview(null); }}
                />
                <span className="bb-form-help">
                  Paste the full Google Sheets URL — the ID is extracted automatically.
                </span>
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button
                  className="bb-btn bb-btn-primary"
                  onClick={handleSaveSheetUrl}
                  disabled={sheetSaving || !sheetUrl.trim()}
                >
                  {sheetSaving ? 'Saving…' : 'Save URL'}
                </button>
                <button
                  className="bb-btn bb-btn-secondary"
                  onClick={handlePreviewSheet}
                  disabled={sheetPreviewLoading || !sheetUrl.trim()}
                >
                  {sheetPreviewLoading ? 'Loading…' : 'Preview Matches'}
                </button>
              </div>
            </div>

            {/* Preview table — only shown after a successful preview */}
            {sheetPreview && (
              <div className="bb-section" style={{ borderTop: '1px solid var(--bb-divider)' }}>
                {/* Summary row */}
                <div className="bb-row-between" style={{ marginBottom: 14 }}>
                  <div>
                    <div className="bb-section-title">Match Preview — {sheetPreview.sheet_tab}</div>
                    <div className="bb-section-meta" style={{ marginTop: 2 }}>
                      {sheetPreview.matched} of {sheetPreview.total_sheet_rows} rows matched to a tracked campaign
                      {sheetPreview.unmatched > 0 && (
                        <span style={{ color: '#b45309', marginLeft: 6 }}>
                          · {sheetPreview.unmatched} unmatched
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Action buttons sit top-right of the preview block */}
                  <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                    <button
                      className="bb-btn bb-btn-primary"
                      onClick={handleSyncBudgets}
                      disabled={sheetSyncLoading}
                      title="Read column B budgets from sheet → update DB campaigns"
                    >
                      {sheetSyncLoading ? 'Syncing…' : '↓ Sync Budgets'}
                    </button>
                    <button
                      className="bb-btn bb-btn-secondary"
                      onClick={handleWriteSpend}
                      disabled={sheetWriteLoading}
                      title="Write MTD spend to col C and today's date to col G"
                    >
                      {sheetWriteLoading ? 'Writing…' : '↑ Write Spend'}
                    </button>
                  </div>
                </div>

                <table className="bb-table">
                  <thead>
                    <tr>
                      <th>Sheet Campaign</th>
                      <th>Monthly Budget (sheet)</th>
                      <th>MTD Spend (sheet)</th>
                      <th>Matched Campaign</th>
                      <th>Match</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sheetPreview.matches.map((m, idx) => (
                      <tr key={idx} className={m.match_type === 'none' ? 'bb-table-row-tint-down' : ''}>
                        <td style={{ fontWeight: 600 }}>{m.sheet_name}</td>
                        <td className="num">
                          {m.monthly_budget != null
                            ? `$${Number(m.monthly_budget).toLocaleString()}`
                            : <span className="bb-muted">—</span>}
                        </td>
                        <td className="num">
                          {m.mtd_spend != null
                            ? `$${Number(m.mtd_spend).toLocaleString()}`
                            : <span className="bb-muted">—</span>}
                        </td>
                        <td style={{ color: m.match_type === 'none' ? '#b91c1c' : 'inherit' }}>
                          {m.matched_campaign_name || <span className="bb-muted">No match found</span>}
                        </td>
                        <td>{matchQualityPill(m.match_type)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <div className="bb-form-help" style={{ marginTop: 10 }}>
                  <strong>Sync Budgets</strong> reads column B → updates monthly budget in the DB.{' '}
                  <strong>Write Spend</strong> writes MTD spend to column C and today's date to column G.
                  Run pacing first so there's spend data to write.
                </div>
              </div>
            )}
          </div>

        ) : null}
      </main>
    </div>
  );
}

export default Settings;
