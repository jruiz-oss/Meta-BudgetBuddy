import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';
import { X, Plus, Inbox, Loader2 } from 'lucide-react';
import Sidebar from '../components/Sidebar';
import { SkeletonStatTile, SkeletonTable } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';
import SpendChart from '../components/SpendChart';
import { useToast } from '../components/Toast';
import { getCached, isStale, setCached, invalidateCache } from '../cache';

/**
 * Single-account dashboard.
 *
 * Top:    4 stat tiles (On Pace / Need Increase / Need Decrease / Total Spend)
 * Then:   Spend-vs-target chart for the whole account
 * Middle: latest pacing run summary (when present) with Apply All button
 * Bottom: tracked campaigns table with current daily, recommended daily, and change indicator
 * Modal:  Import campaigns from Meta
 */
function AccountDashboard({ user, onLogout }) {
  const { accountId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [accounts, setAccounts] = useState([]);
  const [account, setAccount] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [hiddenCampaigns, setHiddenCampaigns] = useState([]);
  const [showHidden, setShowHidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Aggregated pacing history for the spend chart (sum of MTD-actual across this account's campaigns)
  const [accountHistory, setAccountHistory] = useState([]);

  const [pacingRunning, setPacingRunning] = useState(false);
  const [lastRun, setLastRun] = useState(null);
  const [applying, setApplying] = useState(false);

  // Remove-campaign confirmation modal (replaces window.confirm)
  const [removeTarget, setRemoveTarget] = useState(null);

  // Import-from-Meta modal state
  const [showImport, setShowImport] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState('');
  const [importSaving, setImportSaving] = useState(false);
  const [metaCampaigns, setMetaCampaigns] = useState([]);
  const [importSelections, setImportSelections] = useState({});

  useEffect(() => {
    // Clear stale data from the previous account so it never flashes on screen
    setCampaigns([]);
    setHiddenCampaigns([]);
    setAccountHistory([]);
    setLastRun(null);
    setAccount(null);
    setError('');
    fetchAll();
    // fetchAll is intentionally omitted — it closes over `accountId` and we
    // re-create it on every render. Re-running on accountId change is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  const fetchAll = async (force = false) => {
    const cacheKey = `dashboard-${accountId}`;
    const cached = getCached(cacheKey);

    if (cached && !force) {
      setAccounts(cached.accounts);
      setAccount(cached.account);
      setCampaigns(cached.campaigns);
      setHiddenCampaigns(cached.hiddenCampaigns || []);
      setAccountHistory(cached.history || []);
      setLoading(false);
      if (!isStale(cacheKey)) return;
      // stale — fall through and refresh silently
    }

    if (!cached) setLoading(true);

    try {
      const [accountsRes, accountRes, campaignsRes] = await Promise.all([
        axios.get('/api/accounts'),
        axios.get(`/api/accounts/${accountId}`),
        axios.get(`/api/campaigns/${accountId}`),
      ]);
      setAccounts(accountsRes.data.accounts || accountsRes.data || []);
      setAccount(accountRes.data.account || accountRes.data);
      const camps = campaignsRes.data.campaigns || [];
      const hiddenCamps = campaignsRes.data.hidden_campaigns || [];
      setCampaigns(camps);
      setHiddenCampaigns(hiddenCamps);

      // Fetch aggregated pacing history for the spend chart — one request instead
      // of one per campaign (the old N+1 pattern was the main cause of slow loads).
      try {
        const histRes = await axios.get(`/api/campaigns/${accountId}/history-aggregate`).catch(() => null);
        const aggregated = histRes?.data?.history || [];
        setAccountHistory(aggregated);

        // Cache the full set so navigating away and back is instant
        setCached(`dashboard-${accountId}`, {
          accounts: accountsRes.data.accounts || accountsRes.data || [],
          account: accountRes.data.account || accountRes.data,
          campaigns: camps,
          hiddenCampaigns: hiddenCamps,
          history: aggregated,
        });
      } catch {
        setAccountHistory([]);
      }
    } catch (err) {
      if (!cached) setError('Failed to load account data');
    } finally {
      setLoading(false);
    }
  };

  /** After a successful Meta apply, align lastRun recommendations with new dailies (no /run needed). */
  const mergeLastRunAfterApply = (results) => {
    setLastRun((lr) => {
      if (!lr?.recommendations?.length) return lr;
      const adsetMap = new Map();
      const campMap = new Map();
      for (const r of results || []) {
        if (r.error || r.skipped || r.applied_new_daily == null) continue;
        if (r.level === 'adset' && r.campaign_id != null && r.adset_id != null) {
          adsetMap.set(`${r.campaign_id}:${r.adset_id}`, r.applied_new_daily);
        } else if (r.level === 'campaign' && r.campaign_id != null) {
          campMap.set(r.campaign_id, r.applied_new_daily);
        }
      }
      if (!adsetMap.size && !campMap.size) return lr;
      const recommendations = lr.recommendations.map((rec) => {
        const cId = rec.campaign_id;
        if ((rec.budget_mode || 'CBO') === 'ABO') {
          const adset_level = (rec.adset_level || []).map((a) => {
            const nv = adsetMap.get(`${cId}:${a.adset_id}`);
            if (nv == null) return a;
            return {
              ...a,
              current_daily_budget: nv,
              recommended_daily_budget: nv,
              change_percent: 0,
              action: 'ON_PACE',
            };
          });
          return { ...rec, adset_level };
        }
        const nv = campMap.get(cId);
        if (nv == null) return rec;
        return {
          ...rec,
          current_daily_budget: nv,
          recommended_daily_budget: nv,
          change_percent: 0,
          action: 'ON_PACE',
        };
      });
      let adjustments_needed = 0;
      for (const rec of recommendations) {
        if ((rec.budget_mode || 'CBO') === 'ABO') {
          adjustments_needed += (rec.adset_level || []).filter((a) => a.action !== 'ON_PACE').length;
        } else if (rec.action !== 'ON_PACE') {
          adjustments_needed += 1;
        }
      }
      return { ...lr, recommendations, adjustments_needed };
    });
  };

  const handleRunPacing = async () => {
    setPacingRunning(true);
    setError('');
    try {
      // 3-minute timeout — pacing calls the Meta API once per campaign (now in
      // parallel), but a large account or slow Meta response can still take >60s.
      const response = await axios.post(
        `/api/pacing/${accountId}/run`,
        { run_type: 'MANUAL' },
        { timeout: 180000 },
      );
      setLastRun(response.data);
      toast.success(
        `${response.data.campaigns_processed || 0} campaigns processed, ${response.data.adjustments_needed || 0} need adjusting.`,
        { title: 'Pacing complete' }
      );
      if (response.data.failures && response.data.failures.length > 0) {
        toast.warn(`${response.data.failures.length} campaign(s) had errors.`);
      }

      // Surface sheet sync (pre-run pull from sheet → DB)
      const ss = response.data.sheet_sync;
      if (ss && !ss.error) {
        const parts = [];
        if (ss.updated_count > 0) parts.push(`${ss.updated_count} budget(s)`);
        if (ss.allocations_updated_count > 0) parts.push(`${ss.allocations_updated_count} allocation(s)`);
        if (parts.length > 0) {
          toast.info(`Pulled ${parts.join(' + ')} from "${ss.sheet_tab}".`, { title: 'Sheet → App' });
        }
      } else if (ss && ss.error) {
        toast.warn(`Could not read sheet before run: ${ss.error}`, { title: 'Sheet sync skipped' });
      }

      // Bust cache so the post-run fetch gets live data
      // Surface sheet writeback result so the user can see what happened
      const sw = response.data.sheet_writeback;
      if (sw) {
        if (sw.error) {
          toast.error(`Sheet sync failed: ${sw.error}`, { title: 'Sheet not updated' });
        } else if (sw.written_count > 0) {
          const skipNote = sw.skipped_count > 0 ? ` (${sw.skipped_count} skipped)` : '';
          toast.success(`Wrote spend to ${sw.written_count} row(s) in "${sw.sheet_tab}"${skipNote}.`, { title: 'Sheet updated' });
        } else {
          // 0 written — find the most informative skip reason (prefer "No matching"
          // or "No pacing data" over the generic prefix-mismatch that fires for every
          // other account's rows and would otherwise always show up first).
          let shownReason = '';
          if (sw.skipped && sw.skipped.length > 0) {
            const priority = sw.skipped.find(s =>
              s.reason && (s.reason.includes('No matching') || s.reason.includes('No pacing'))
            ) || sw.skipped[0];
            shownReason = ` Reason: ${priority.reason}`;
          }
          toast.warn(`Sheet: nothing written — ${sw.skipped_count || 0} row(s) skipped.${shownReason}`, { title: 'Sheet not updated' });
        }
      }

      invalidateCache(`dashboard-${accountId}`, 'home-data');
      fetchAll(true);
    } catch (err) {
      const msg = err.response?.data?.error || 'Failed to run pacing calculations';
      setError(msg);
      toast.error(msg, { title: 'Pacing failed' });
    } finally {
      setPacingRunning(false);
    }
  };

  const handleRemoveCampaign = async () => {
    if (!removeTarget) return;
    const { id, name } = removeTarget;
    setRemoveTarget(null);
    try {
      await axios.put(`/api/campaigns/${accountId}/${id}`, { is_active: false });
      toast.success(`Removed "${name}" from pacing.`);
      fetchAll();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to remove campaign');
    }
  };

  const handleApplyAll = async () => {
    if (!lastRun || !lastRun.recommendations) return;
    const adjustments = [];
    lastRun.recommendations.forEach((r) => {
      if ((r.budget_mode || 'CBO') === 'ABO') {
        (r.adset_level || []).forEach((a) => {
          if (a.action === 'ON_PACE') return;
          adjustments.push({
            level: 'adset',
            campaign_id: r.campaign_id,
            campaign_name: r.campaign_name,
            adset_id: a.adset_id,
            adset_name: a.adset_name,
            current_daily_budget: a.current_daily_budget,
            recommended_daily_budget: a.recommended_daily_budget,
            change_percent: a.change_percent,
            action: a.action,
          });
        });
      } else {
        if (r.action === 'ON_PACE') return;
        adjustments.push({
          level: 'campaign',
          campaign_id: r.campaign_id,
          campaign_name: r.campaign_name,
          current_daily_budget: r.current_daily_budget,
          recommended_daily_budget: r.recommended_daily_budget,
          change_percent: r.change_percent,
          action: r.action,
        });
      }
    });

    if (adjustments.length === 0) {
      toast.info('Nothing to apply — everything is on pace.');
      return;
    }
    setApplying(true);
    setError('');
    try {
      const response = await axios.post(`/api/pacing/${accountId}/apply`, { adjustments });
      const { applied_count: applied = 0, results = [] } = response.data;
      const failures = results.filter((r) => r.error);
      const skipped = results.filter((r) => r.skipped);
      if (failures.length && applied === 0) {
        const msg = failures[0].error || 'Failed to apply recommendations';
        setError(msg);
        toast.error(msg, { title: 'Apply failed' });
      } else if (failures.length) {
        if (applied > 0) mergeLastRunAfterApply(results);
        invalidateCache(`dashboard-${accountId}`, 'home-data');
        toast.warn(
          `${applied} applied; ${failures.length} failed. ${failures[0].error || ''}`,
          { title: 'Partial apply' },
        );
        fetchAll(true);
      } else if (skipped.length && applied === 0) {
        invalidateCache(`dashboard-${accountId}`, 'home-data');
        toast.info('No budget changes sent — items were already on pace or unchanged.', { title: 'Nothing to apply' });
        fetchAll(true);
      } else {
        mergeLastRunAfterApply(results);
        invalidateCache(`dashboard-${accountId}`, 'home-data');
        toast.success(
          `${applied} budget change${applied === 1 ? '' : 's'} pushed to Meta.`,
          { title: 'Applied' },
        );
        fetchAll(true);
      }
    } catch (err) {
      const data = err.response?.data;
      const fromResults = data?.results?.find((r) => r.error)?.error;
      const msg = fromResults || data?.error || 'Failed to apply recommendations';
      setError(msg);
      toast.error(msg, { title: 'Apply failed' });
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
      const seed = {};
      list.forEach((c) => {
        const adsetSeed = {};
        (c.adsets || []).forEach((a) => {
          adsetSeed[a.meta_adset_id] = {
            name: a.name,
            current_daily_budget: a.current_daily_budget,
            allocation_pct: a.allocation_pct,
          };
        });
        seed[c.meta_campaign_id] = {
          selected: !!c.already_tracked,
          monthly_budget: c.saved_monthly_budget != null
            ? c.saved_monthly_budget
            : (c.current_daily_budget ? Math.round(c.current_daily_budget * 30) : ''),
          adsets: adsetSeed,
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

  const closeImport = () => { setShowImport(false); setImportError(''); };

  const toggleImportSelection = (metaId) => {
    setImportSelections((prev) => ({
      ...prev,
      [metaId]: { ...prev[metaId], selected: !prev[metaId]?.selected },
    }));
  };

  const updateImportBudget = (metaId, value) => {
    setImportSelections((prev) => ({
      ...prev,
      [metaId]: { ...prev[metaId], monthly_budget: value },
    }));
  };

  const updateAdsetAllocation = (metaCampaignId, metaAdsetId, value) => {
    setImportSelections((prev) => {
      const c = prev[metaCampaignId] || {};
      const adsets = { ...(c.adsets || {}) };
      adsets[metaAdsetId] = { ...(adsets[metaAdsetId] || {}), allocation_pct: value };
      return { ...prev, [metaCampaignId]: { ...c, adsets } };
    });
  };

  const allocationSumFor = (metaCampaignId) => {
    const sel = importSelections[metaCampaignId];
    if (!sel || !sel.adsets) return 0;
    return Object.values(sel.adsets).reduce((sum, a) => {
      const n = parseFloat(a.allocation_pct);
      return sum + (Number.isFinite(n) ? n : 0);
    }, 0);
  };

  const evenSplitAllocations = (metaCampaignId) => {
    setImportSelections((prev) => {
      const c = prev[metaCampaignId] || {};
      const adsets = { ...(c.adsets || {}) };
      const keys = Object.keys(adsets);
      if (keys.length === 0) return prev;
      const even = Math.round((100 / keys.length) * 100) / 100;
      const remainder = 100 - even * keys.length;
      keys.forEach((k, i) => {
        adsets[k] = { ...adsets[k], allocation_pct: i === 0 ? +(even + remainder).toFixed(2) : even };
      });
      return { ...prev, [metaCampaignId]: { ...c, adsets } };
    });
  };

  const saveImport = async () => {
    const chosen = [];
    const validationErrors = [];
    metaCampaigns.forEach((c) => {
      const sel = importSelections[c.meta_campaign_id];
      if (!sel?.selected) return;
      const monthly = parseFloat(sel.monthly_budget) || 0;
      if (monthly <= 0) {
        validationErrors.push(`${c.name}: missing monthly budget`);
        return;
      }
      const mode = c.budget_mode || (c.is_cbo ? 'CBO' : 'ABO');
      const entry = {
        meta_campaign_id: c.meta_campaign_id,
        campaign_name: c.name,
        monthly_budget: monthly,
        flight_type: 'ALWAYS_ON',
        budget_mode: mode,
        adsets: [],
      };
      if (mode === 'ABO') {
        const liveAdsets = c.adsets || [];
        if (liveAdsets.length === 0) {
          validationErrors.push(`${c.name} (ABO): no ad sets returned by Meta`);
          return;
        }
        let total = 0;
        liveAdsets.forEach((a) => {
          const pctRaw = sel.adsets?.[a.meta_adset_id]?.allocation_pct;
          const pct = parseFloat(pctRaw);
          if (!Number.isFinite(pct) || pct < 0) {
            validationErrors.push(`${c.name}: ${a.name} has invalid allocation %`);
            return;
          }
          total += pct;
          entry.adsets.push({
            meta_adset_id: a.meta_adset_id,
            name: a.name,
            allocation_pct: pct,
          });
        });
        if (Math.abs(total - 100) > 1.5) {
          validationErrors.push(`${c.name} (ABO): allocations sum to ${total.toFixed(2)}%, must be ~100%`);
          return;
        }
      }
      chosen.push(entry);
    });

    if (validationErrors.length > 0) {
      setImportError(validationErrors.join(' • '));
      return;
    }
    if (chosen.length === 0) {
      setImportError('Pick at least one campaign and give it a monthly budget.');
      return;
    }

    setImportSaving(true);
    setImportError('');
    try {
      const seen_meta_ids = metaCampaigns.map((c) => c.meta_campaign_id);
      await axios.post(`/api/campaigns/${accountId}/sync`, { campaigns: chosen, seen_meta_ids });
      toast.success(`Imported ${chosen.length} campaign${chosen.length === 1 ? '' : 's'}.`, { title: 'Saved' });
      closeImport();
      fetchAll();
    } catch (err) {
      const msg = err.response?.data?.error || 'Failed to save campaigns';
      const details = err.response?.data?.details;
      if (Array.isArray(details) && details.length > 0) {
        setImportError(`${msg}: ${details.map((d) => d.error || JSON.stringify(d)).join(' • ')}`);
      } else {
        setImportError(msg);
      }
    } finally {
      setImportSaving(false);
    }
  };

  const handleLogout = async () => {
    try { await axios.post('/api/auth/logout'); } catch {}
    onLogout();
    navigate('/login');
  };

  // Pull a read-only health snapshot of this account from the backend and
  // trigger a JSON download. Used to debug accounts whose dashboard looks
  // off without having to crack open the DB. Pure read — never mutates.
  const handleDownloadDiagnostic = async () => {
    try {
      const response = await axios.get(`/api/accounts/${accountId}/diagnostic`);
      const data = response.data;
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const safeName = (data?.account?.name || 'account')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
      a.href = url;
      a.download = `diagnostic-${safeName}-${stamp}.json`;
      a.click();
      URL.revokeObjectURL(url);
      const counts = data?.summary?.by_health || {};
      const orphans = counts.orphan_no_adsets || 0;
      toast.success(
        orphans > 0
          ? `Diagnostic downloaded — ${orphans} orphan ABO campaign${orphans === 1 ? '' : 's'} found`
          : 'Diagnostic downloaded'
      );
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not generate diagnostic');
    }
  };

  // Derived stats
  const stats = useMemo(() => {
    const s = { onPace: 0, needIncrease: 0, needDecrease: 0, totalSpend: 0, monthlyBudget: 0 };
    campaigns.forEach((c) => {
      s.monthlyBudget += c.monthly_budget || 0;
      if (c.latest_pacing) {
        const status = (c.latest_pacing.status || '').toUpperCase();
        if (status === 'ON_PACE') s.onPace += 1;
        else if (status === 'INCREASE') s.needIncrease += 1;
        else if (status === 'DECREASE') s.needDecrease += 1;
        s.totalSpend += c.latest_pacing.actual_spend || 0;
      }
    });
    return s;
  }, [campaigns]);

  // ── Inline SVG icons for new design ──
  const IPlay = () => <svg width={13} height={13} viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8z"/></svg>;
  const ILogout = () => <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>;
  const IDownloadCloud = () => <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>;
  const IHistory = () => <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>;
  const ISettings = () => <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>;
  const IDiagnostic = () => <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>;
  const ICheck = () => <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>;
  const ITrendUp = () => <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m3 17 6-6 4 4 8-8"/><path d="M14 7h7v7"/></svg>;
  const ITrendDown = () => <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m3 7 6 6 4-4 8 8"/><path d="M14 17h7v-7"/></svg>;
  const IDownload = () => <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>;

  const statusTone = (status, paceRatio) => {
    const s = (status || '').toUpperCase();
    if (s === 'ON_PACE') return 'var(--bb-ok)';
    if (s === 'INCREASE') return 'var(--bb-warn-cool)';
    if (s === 'DECREASE') return 'var(--bb-warn)';
    return 'var(--bb-mute)';
  };
  const statusLabel = (status, paceRatio) => {
    const s = (status || '').toUpperCase();
    const ratio = paceRatio || 0;
    const pct = Math.round(Math.abs((ratio - 1) * 100));
    if (s === 'ON_PACE') return 'On pace';
    if (s === 'INCREASE') return `${pct}% under`;
    if (s === 'DECREASE') return `${pct}% over`;
    return '—';
  };
  const StatusPill = ({ status, paceRatio }) => {
    const tone = statusTone(status, paceRatio);
    const label = statusLabel(status, paceRatio);
    const s = (status || '').toUpperCase();
    const Icon = s === 'ON_PACE' ? ICheck : s === 'INCREASE' ? ITrendUp : ITrendDown;
    return <span className="bb-status" style={{ '--bb-tone': tone }}><Icon />{label}</span>;
  };

  if (loading) {
    return (
      <div className="bb-app">
        <Sidebar user={user} accounts={accounts} />
        <main className="bb-main">
          <div className="bb-header">
            <div><h1 className="bb-h1">Loading…</h1></div>
          </div>
          <div className="bb-state-grid-4" style={{ marginBottom: 20 }}>
            <SkeletonStatTile /><SkeletonStatTile /><SkeletonStatTile /><SkeletonStatTile />
          </div>
          <SkeletonTable rows={5} cols={8} />
        </main>
      </div>
    );
  }

  if (!account) {
    return (
      <div className="bb-app">
        <Sidebar user={user} accounts={accounts} />
        <main className="bb-main">
          <div className="bb-alert bb-alert-error">Account not found.</div>
        </main>
      </div>
    );
  }

  const spendPct = stats.monthlyBudget > 0 ? Math.min(100, (stats.totalSpend / stats.monthlyBudget) * 100) : 0;
  const expectedSoFar = stats.monthlyBudget > 0 ? (stats.monthlyBudget / new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate()) * new Date().getDate() : 0;
  const spendDelta = expectedSoFar > 0 ? ((stats.totalSpend - expectedSoFar) / expectedSoFar) * 100 : 0;
  const acctHueVal = ((parseInt(accountId, 10) || 0) * 137 + 43) % 360;

  return (
    <div className="bb-app">
      <Sidebar user={user} accounts={accounts} />

      <main className="bb-main">
        {/* Breadcrumb */}
        <div style={{ fontSize: 'var(--bb-text-sm)', color: 'var(--bb-mute)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Link to="/accounts" style={{ color: 'var(--bb-fg-2)', textDecoration: 'none' }}>Accounts</Link>
          <span>/</span>
          <span style={{ color: 'var(--bb-fg)' }}>{account.account_name}</span>
        </div>

        {/* Header */}
        <div className="bb-header">
          <div>
            <h1 className="bb-h1">{account.account_name}</h1>
            <div className="bb-sub">
              Meta account ID: <span style={{ fontFamily: 'var(--bb-font-mono)' }}>{account.meta_account_id || '—'}</span>
            </div>
          </div>
          <div className="bb-header-actions">
            <button className="bb-btn" onClick={openImport}><IDownloadCloud /> Import from Meta</button>
            <Link to={`/account/${accountId}/history`} className="bb-btn"><IHistory /> History</Link>
            <Link to={`/account/${accountId}/settings`} className="bb-btn"><ISettings /> Settings</Link>
            <button className="bb-btn bb-btn-ghost" onClick={handleDownloadDiagnostic} title="Download diagnostic JSON">
              <IDiagnostic /> Diagnostic
            </button>
            <button className="bb-btn bb-btn-primary" onClick={handleRunPacing} disabled={pacingRunning}>
              {pacingRunning ? <Loader2 size={13} className="bb-spin" /> : <IPlay />}
              {pacingRunning ? 'Running…' : 'Run Pacing'}
            </button>
            <button className="bb-btn bb-btn-ghost" onClick={handleLogout}><ILogout /> Log out</button>
          </div>
        </div>

        {error && <div className="bb-alert bb-alert-error">{error}</div>}

        {/* Status cards */}
        <div className="bb-state-grid-4">
          <div className="bb-state-card is-ok">
            <div className="bb-state-label"><ICheck /> On Pace</div>
            <div className="bb-state-value">{stats.onPace}</div>
            <div className="bb-state-meta">campaigns hitting target</div>
          </div>
          <div className="bb-state-card is-cool">
            <div className="bb-state-label"><ITrendUp /> Need Increase</div>
            <div className="bb-state-value">{stats.needIncrease}</div>
            <div className="bb-state-meta">spending below pace</div>
          </div>
          <div className="bb-state-card is-warn">
            <div className="bb-state-label"><ITrendDown /> Need Decrease</div>
            <div className="bb-state-value">{stats.needDecrease}</div>
            <div className="bb-state-meta">spending above pace</div>
          </div>
          <div className="bb-state-card">
            <div className="bb-state-label">Total Spend (MTD)</div>
            <div className="bb-state-value">${stats.totalSpend.toLocaleString('en-US', { maximumFractionDigits: 0 })}</div>
            <div className="bb-progress" style={{ marginTop: 8 }}>
              <div className="bb-progress-fill" style={{ width: spendPct + '%' }} />
            </div>
            <div className="bb-state-meta" style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>of ${stats.monthlyBudget.toLocaleString('en-US', { maximumFractionDigits: 0 })} monthly</span>
              <span style={{ color: spendDelta > 0 ? 'var(--bb-warn)' : 'var(--bb-warn-cool)', fontVariantNumeric: 'tabular-nums' }}>
                {spendDelta > 0 ? '+' : ''}{spendDelta.toFixed(1)}% vs. expected
              </span>
            </div>
          </div>
        </div>

        {/* Pacing-in-progress banner */}
        {pacingRunning && (
          <div className="bb-acct" style={{ marginBottom: 16 }}>
            <div style={{ padding: '16px 20px' }}>
              <div className="bb-pacing-banner-inner">
                <Loader2 size={22} className="bb-spin" style={{ color: 'var(--bb-accent)' }} />
                <div>
                  <div className="bb-pacing-banner-title">Running pacing calculations…</div>
                  <div className="bb-pacing-banner-sub">Pulling MTD spend from Meta and computing recommendations for all tracked campaigns.</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Spend chart */}
        {stats.monthlyBudget > 0 && (
          <div className="bb-acct" style={{ padding: '18px 20px 12px', marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div className="bb-summary-label" style={{ marginBottom: 0 }}>
                <ITrendUp /> Account spend vs. target
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 'var(--bb-text-sm)', color: 'var(--bb-fg-2)' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 16, height: 2.5, background: 'var(--bb-accent)', borderRadius: 2, display: 'inline-block' }} /> Actual
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 16, height: 0, borderTop: '1.5px dashed var(--bb-mute)', display: 'inline-block' }} /> Expected
                </span>
              </div>
            </div>
            <SpendChart
              monthlyBudget={stats.monthlyBudget}
              history={accountHistory}
              currentMtd={stats.totalSpend}
              height={260}
              title=""
            />
          </div>
        )}

        {/* Latest run summary */}
        {lastRun && (
          <div className="bb-acct" style={{ marginBottom: 16 }}>
            <div className="bb-acct-head" style={{ cursor: 'default' }}>
              <div className="bb-acct-bar" style={{ '--acct-hue': acctHueVal }} />
              <div className="bb-flex-col">
                <div className="bb-acct-title">Latest pacing run — {lastRun.campaigns_processed} campaigns, {lastRun.adjustments_needed} need adjusting</div>
                <div className="bb-acct-meta">Recommendations from the most recent calculation.</div>
              </div>
              <div className="bb-acct-spacer" />
              <button className="bb-btn bb-btn-sm" onClick={() => {
                const blob = new Blob([JSON.stringify(lastRun, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = `pacing-run-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.json`;
                a.click(); URL.revokeObjectURL(url);
              }}>
                <IDownload /> Download Run Log
              </button>
              <button className="bb-apply" onClick={handleApplyAll} disabled={applying || lastRun.adjustments_needed === 0}>
                {applying ? <Loader2 size={13} className="bb-spin" /> : <ICheck />}
                {applying ? 'Applying…' : 'Apply all to Meta'}
              </button>
            </div>

            {lastRun.failures && lastRun.failures.length > 0 && (
              <div className="bb-alert bb-alert-error" style={{ margin: '8px 18px 0' }}>
                {lastRun.failures.length} campaign(s) failed: {lastRun.failures.map(f => `${f.campaign_name}: ${f.error}`).join(' — ')}
              </div>
            )}

            {lastRun.recommendations && lastRun.recommendations.length > 0 && (
              <table className="bb-table">
                <thead>
                  <tr>
                    <th>Campaign / Ad set</th><th>Mode</th><th className="num">MTD Spend</th>
                    <th className="num">Expected</th><th className="num">Pace</th>
                    <th className="num">Current Daily</th><th className="num">Recommended</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {lastRun.recommendations.flatMap(r => {
                    const mode = r.budget_mode || 'CBO';
                    if (mode === 'ABO') {
                      const parentRow = (
                        <tr key={`c-${r.campaign_id}`} style={{ background: 'var(--bb-surface-2)' }}>
                          <td style={{ fontWeight: 600 }}>{r.campaign_name}</td>
                          <td><span className="bb-mode bb-mode-abo">ABO</span></td>
                          <td className="num">${(r.actual_spend || 0).toFixed(2)}</td>
                          <td className="num">${(r.expected_spend || 0).toFixed(2)}</td>
                          <td className="num">{(r.pace_ratio || 0).toFixed(2)}x</td>
                          <td className="num" style={{ color: 'var(--bb-mute)' }}>—</td>
                          <td className="num" style={{ color: 'var(--bb-mute)' }}>—</td>
                          <td><span className="bb-status" style={{ '--bb-tone': 'var(--bb-mute)' }}>rollup</span></td>
                        </tr>
                      );
                      const adsetRows = (r.adset_level || []).map(a => {
                        const action = (a.action || '').toUpperCase();
                        return (
                          <tr key={`a-${a.adset_id}`} className="bb-row-adset">
                            <td>
                              <div className="bb-row-name">
                                <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="bb-arrow"><path d="M5 4v8a3 3 0 0 0 3 3h11"/><path d="m15 11 4 4-4 4"/></svg>
                                {a.adset_name}
                                <span className="bb-row-weight">{a.allocation_pct}%</span>
                              </div>
                            </td>
                            <td><span className="bb-mode bb-mode-adset">ad set</span></td>
                            <td className="num">${(a.actual_spend || 0).toFixed(2)}</td>
                            <td className="num">${(a.expected_spend || 0).toFixed(2)}</td>
                            <td className="num"><span style={{ color: statusTone(action, a.pace_ratio), fontWeight: 600 }}>{(a.pace_ratio || 0).toFixed(2)}x</span></td>
                            <td className="num">${(a.current_daily_budget || 0).toFixed(2)}</td>
                            <td className="num">
                              <div className="bb-rec-cell">
                                <span>${(a.recommended_daily_budget || 0).toFixed(2)}</span>
                                {a.change_percent != null && Math.abs(a.change_percent) >= 0.5 && (
                                  <span className={a.change_percent > 0 ? 'bb-delta up' : 'bb-delta down'}>
                                    {a.change_percent > 0 ? '↑' : '↓'}{Math.abs(a.change_percent).toFixed(1)}%
                                  </span>
                                )}
                              </div>
                            </td>
                            <td><StatusPill status={action} paceRatio={a.pace_ratio} /></td>
                          </tr>
                        );
                      });
                      return [parentRow, ...adsetRows];
                    }
                    const action = (r.action || '').toUpperCase();
                    return [(
                      <tr key={`c-${r.campaign_id}`}>
                        <td style={{ fontWeight: 600 }}>{r.campaign_name}</td>
                        <td><span className="bb-mode bb-mode-cbo">CBO</span></td>
                        <td className="num">${(r.actual_spend || 0).toFixed(2)}</td>
                        <td className="num">${(r.expected_spend || 0).toFixed(2)}</td>
                        <td className="num"><span style={{ color: statusTone(action, r.pace_ratio), fontWeight: 600 }}>{(r.pace_ratio || 0).toFixed(2)}x</span></td>
                        <td className="num">${(r.current_daily_budget || 0).toFixed(2)}</td>
                        <td className="num">
                          <div className="bb-rec-cell">
                            <span>${(r.recommended_daily_budget || 0).toFixed(2)}</span>
                            {r.change_percent != null && Math.abs(r.change_percent) >= 0.5 && (
                              <span className={r.change_percent > 0 ? 'bb-delta up' : 'bb-delta down'}>
                                {r.change_percent > 0 ? '↑' : '↓'}{Math.abs(r.change_percent).toFixed(1)}%
                              </span>
                            )}
                          </div>
                        </td>
                        <td><StatusPill status={action} paceRatio={r.pace_ratio} /></td>
                      </tr>
                    )];
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* Tracked campaigns table */}
        <div className="bb-acct">
          <div className="bb-acct-head" style={{ cursor: 'default' }}>
            <div className="bb-acct-bar" style={{ '--acct-hue': acctHueVal }} />
            <div className="bb-flex-col">
              <div className="bb-acct-title">Tracked campaigns ({campaigns.length})</div>
              <div className="bb-acct-meta">
                Pulled from Meta via the Import button above.
                {hiddenCampaigns.length > 0 && (
                  <span>
                    {' · '}{hiddenCampaigns.length} hidden (no spend this month)
                    <button className="bb-btn bb-btn-ghost bb-btn-sm" style={{ marginLeft: 6 }} onClick={() => setShowHidden(h => !h)}>
                      {showHidden ? 'Hide ended' : 'Show anyway'}
                    </button>
                  </span>
                )}
              </div>
            </div>
            <div className="bb-acct-spacer" />
            <button className="bb-btn bb-btn-sm" onClick={openImport}>+ Add campaign</button>
          </div>

          {campaigns.length === 0 && hiddenCampaigns.length === 0 ? (
            <EmptyState
              icon={null}
              title="No campaigns tracked yet"
              body="Click Import from Meta to pull in your campaigns and start pacing."
              action={{ label: 'Import from Meta', onClick: openImport }}
            />
          ) : campaigns.length === 0 && !showHidden ? (
            <EmptyState
              icon={null}
              title="No active campaigns this month"
              body={`${hiddenCampaigns.length} campaign${hiddenCampaigns.length !== 1 ? 's are' : ' is'} hidden — they show no spend this month.`}
              action={{ label: 'Show ended campaigns', onClick: () => setShowHidden(true) }}
            />
          ) : (
            <table className="bb-table">
              <thead>
                <tr>
                  <th>Campaign</th><th>Mode</th><th>Flight</th>
                  <th className="num">Monthly Budget</th><th className="num">Current Daily</th>
                  <th className="num">Pace</th><th className="num">Recommended Daily</th>
                  <th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {[...(showHidden ? [...campaigns, ...hiddenCampaigns] : campaigns)].map(c => {
                  const lp = c.latest_pacing;
                  const status = lp ? (lp.status || '').toUpperCase() : null;
                  const mode = c.budget_mode || 'CBO';
                  if (mode === 'ABO') {
                    const parentRow = (
                      <tr key={`c-${c.id}`} style={{ background: 'var(--bb-surface-2)' }}>
                        <td>
                          <div className="bb-row-name" style={{ fontWeight: 600 }}>
                            <Link to={`/account/${accountId}/campaign/${c.id}`} style={{ color: 'var(--bb-fg)', textDecoration: 'none' }}>
                              {c.campaign_name}
                            </Link>
                          </div>
                        </td>
                        <td><span className="bb-mode bb-mode-abo">ABO</span></td>
                        <td><span className="bb-mode bb-mode-adset">{c.flight_type || 'ALWAYS_ON'}</span></td>
                        <td className="num">${(c.monthly_budget || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}</td>
                        <td className="num" style={{ color: 'var(--bb-mute)' }}>—</td>
                        <td className="num">{lp ? <span style={{ color: statusTone(status, lp.pace_ratio), fontWeight: 600 }}>{(lp.pace_ratio || 0).toFixed(2)}x</span> : '—'}</td>
                        <td className="num" style={{ color: 'var(--bb-mute)' }}>—</td>
                        <td>{lp && status ? <StatusPill status={status} paceRatio={lp.pace_ratio} /> : <span style={{ color: 'var(--bb-mute)' }}>rollup</span>}</td>
                        <td>
                          <div className="bb-actions">
                            <Link to={`/account/${accountId}/campaign/${c.id}`} className="bb-skip" style={{ textDecoration: 'none' }}>View →</Link>
                            <button className="bb-skip" style={{ color: 'var(--bb-warn-hot)' }} onClick={() => setRemoveTarget({ id: c.id, name: c.campaign_name })}>Remove</button>
                          </div>
                        </td>
                      </tr>
                    );
                    const adsetRows = (c.adsets || []).map(a => (
                      <tr key={`a-${a.id}`} className="bb-row-adset">
                        <td>
                          <div className="bb-row-name">
                            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="bb-arrow"><path d="M5 4v8a3 3 0 0 0 3 3h11"/><path d="m15 11 4 4-4 4"/></svg>
                            {a.adset_name}
                            <span className="bb-row-weight">{(a.allocation_pct || 0).toFixed(0)}%</span>
                          </div>
                        </td>
                        <td><span className="bb-mode bb-mode-adset">ad set</span></td>
                        <td></td>
                        <td className="num">${(c.monthly_budget * (a.allocation_pct || 0) / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}</td>
                        <td className="num">{a.latest_pacing?.current_daily_budget != null ? `$${a.latest_pacing.current_daily_budget.toFixed(2)}` : '—'}</td>
                        <td className="num">{a.latest_pacing ? <span style={{ color: statusTone(a.latest_pacing.status, a.latest_pacing.pace_ratio), fontWeight: 600 }}>{(a.latest_pacing.pace_ratio || 0).toFixed(2)}x</span> : '—'}</td>
                        <td className="num">{a.latest_pacing?.recommended_daily_budget != null ? `$${a.latest_pacing.recommended_daily_budget.toFixed(2)}` : '—'}</td>
                        <td>{a.latest_pacing ? <StatusPill status={(a.latest_pacing.action || a.latest_pacing.status || '').toUpperCase()} paceRatio={a.latest_pacing.pace_ratio} /> : <span style={{ color: 'var(--bb-mute)' }}>No data</span>}</td>
                        <td></td>
                      </tr>
                    ));
                    return [parentRow, ...adsetRows];
                  }
                  // CBO
                  return (
                    <tr key={`c-${c.id}`}>
                      <td>
                        <div className="bb-row-name" style={{ fontWeight: 600 }}>
                          <Link to={`/account/${accountId}/campaign/${c.id}`} style={{ color: 'var(--bb-fg)', textDecoration: 'none' }}>
                            {c.campaign_name}
                          </Link>
                        </div>
                      </td>
                      <td><span className="bb-mode bb-mode-cbo">CBO</span></td>
                      <td><span className="bb-mode bb-mode-adset">{c.flight_type || 'ALWAYS_ON'}</span></td>
                      <td className="num">${(c.monthly_budget || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}</td>
                      <td className="num">{lp?.current_daily_budget != null ? `$${lp.current_daily_budget.toFixed(2)}` : '—'}</td>
                      <td className="num">{lp ? <span style={{ color: statusTone(status, lp.pace_ratio), fontWeight: 600 }}>{(lp.pace_ratio || 0).toFixed(2)}x</span> : '—'}</td>
                      <td className="num">
                        {lp?.recommended_daily_budget != null ? (
                          <div className="bb-rec-cell">
                            <span>${lp.recommended_daily_budget.toFixed(2)}</span>
                            {lp.change_percent != null && Math.abs(lp.change_percent) >= 0.5 && (
                              <span className={lp.change_percent > 0 ? 'bb-delta up' : 'bb-delta down'}>
                                {lp.change_percent > 0 ? '↑' : '↓'}{Math.abs(lp.change_percent).toFixed(1)}%
                              </span>
                            )}
                          </div>
                        ) : '—'}
                      </td>
                      <td>{lp && status ? <StatusPill status={status} paceRatio={lp.pace_ratio} /> : <span style={{ color: 'var(--bb-mute)' }}>No data</span>}</td>
                      <td>
                        <div className="bb-actions">
                          <Link to={`/account/${accountId}/campaign/${c.id}`} className="bb-skip" style={{ textDecoration: 'none' }}>View →</Link>
                          <button className="bb-skip" style={{ color: 'var(--bb-warn-hot)' }} onClick={() => setRemoveTarget({ id: c.id, name: c.campaign_name })}>Remove</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {removeTarget && (
          <div className="bb-modal-backdrop" onClick={() => setRemoveTarget(null)}>
            <div className="bb-modal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
              <div className="bb-modal-head">
                <div className="bb-modal-title">Remove from pacing?</div>
                <button className="bb-icon-btn" onClick={() => setRemoveTarget(null)} aria-label="Close">
                  <X size={18} aria-hidden="true" />
                </button>
              </div>
              <div className="bb-modal-body">
                <p style={{ margin: 0 }}>
                  Stop pacing <strong>{removeTarget.name}</strong>?
                </p>
                <p className="bb-muted" style={{ fontSize: 13, marginTop: 8 }}>
                  This won't change anything in Meta — it just stops BudgetBuddy from including
                  the campaign in future pacing runs. You can re-add it via Import from Meta.
                </p>
              </div>
              <div className="bb-modal-foot">
                <button className="bb-btn" onClick={() => setRemoveTarget(null)}>Cancel</button>
                <button className="bb-btn bb-btn-danger" onClick={handleRemoveCampaign}>
                  Remove
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Import-from-Meta modal */}
        {showImport && (
          <div className="bb-modal-backdrop" onClick={closeImport}>
            <div className="bb-modal" onClick={(e) => e.stopPropagation()}>
              <div className="bb-modal-head">
                <div className="bb-modal-title">Import campaigns from Meta</div>
                <button className="bb-icon-btn" onClick={closeImport} aria-label="Close">
                  <X size={18} aria-hidden="true" />
                </button>
              </div>

              <div className="bb-modal-body">
                {importLoading && (
                  <p className="bb-muted" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Loader2 size={14} className="bb-spin" /> Fetching campaigns from Meta…
                  </p>
                )}
                {importError && <div className="bb-alert bb-alert-error">{importError}</div>}

                {!importLoading && metaCampaigns.length > 0 && (
                  <>
                    <p className="bb-muted" style={{ marginBottom: 12 }}>
                      Pick the campaigns you want to track and set a monthly budget for each.
                      The default monthly budget is current daily × 30.
                    </p>
                    <table className="bb-table">
                      <thead>
                        <tr>
                          <th></th>
                          <th>Campaign</th>
                          <th>Status</th>
                          <th>Mode</th>
                          <th>Current Daily</th>
                          <th>Monthly Budget</th>
                        </tr>
                      </thead>
                      <tbody>
                        {metaCampaigns.flatMap((c) => {
                          const sel = importSelections[c.meta_campaign_id] || {};
                          const mode = c.budget_mode || (c.is_cbo ? 'CBO' : 'ABO');
                          const liveAdsets = c.adsets || [];
                          const allocSum = allocationSumFor(c.meta_campaign_id);
                          const allocOk = Math.abs(allocSum - 100) <= 1.5;

                          const mainRow = (
                            <tr key={c.meta_campaign_id}>
                              <td>
                                <input type="checkbox"
                                  checked={!!sel.selected}
                                  onChange={() => toggleImportSelection(c.meta_campaign_id)}
                                />
                              </td>
                              <td>
                                <div>{c.name}</div>
                                {c.already_tracked && <div className="bb-muted" style={{ fontSize: 11 }}>tracked</div>}
                              </td>
                              <td>{c.effective_status || c.status}</td>
                              <td>
                                <span className={`bb-mode-badge ${mode === 'ABO' ? 'bb-mode-abo' : 'bb-mode-cbo'}`}>
                                  {mode}
                                </span>
                              </td>
                              <td className="num">{c.current_daily_budget ? `$${c.current_daily_budget.toFixed(2)}` : '—'}</td>
                              <td>
                                <input
                                  type="number"
                                  step="1" min="0"
                                  className="bb-input"
                                  placeholder="0"
                                  value={sel.monthly_budget ?? ''}
                                  onChange={(e) => updateImportBudget(c.meta_campaign_id, e.target.value)}
                                  disabled={!sel.selected}
                                  style={{ width: 110 }}
                                />
                              </td>
                            </tr>
                          );

                          if (mode !== 'ABO' || !sel.selected || liveAdsets.length === 0) {
                            return [mainRow];
                          }

                          const allocRow = (
                            <tr key={`${c.meta_campaign_id}-alloc`}>
                              <td colSpan={6} style={{ padding: 0, background: '#fafbfb' }}>
                                <div style={{ padding: '12px 16px 16px 48px' }}>
                                  <div className="bb-row-between" style={{ marginBottom: 8 }}>
                                    <div className="bb-section-meta">
                                      Set how much of <strong>${(parseFloat(sel.monthly_budget) || 0).toFixed(0)}</strong> /mo
                                      goes to each ad set. Total must equal 100%.
                                    </div>
                                    <button
                                      type="button"
                                      className="bb-btn bb-btn-ghost"
                                      onClick={() => evenSplitAllocations(c.meta_campaign_id)}
                                      style={{ fontSize: 12 }}
                                    >
                                      Split evenly
                                    </button>
                                  </div>
                                  <table className="bb-table" style={{ marginBottom: 4 }}>
                                    <thead>
                                      <tr>
                                        <th style={{ width: '60%' }}>Ad set</th>
                                        <th>Current Daily</th>
                                        <th>Allocation %</th>
                                        <th>Allocated /mo</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {liveAdsets.map((a) => {
                                        const pct = parseFloat(sel.adsets?.[a.meta_adset_id]?.allocation_pct);
                                        const monthly = parseFloat(sel.monthly_budget) || 0;
                                        const allocated = Number.isFinite(pct) ? (monthly * pct / 100) : 0;
                                        return (
                                          <tr key={a.meta_adset_id}>
                                            <td>{a.name} {a.status !== 'ACTIVE' && <span className="bb-muted">({a.status})</span>}</td>
                                            <td className="num">{a.current_daily_budget ? `$${a.current_daily_budget.toFixed(2)}` : '—'}</td>
                                            <td>
                                              <input
                                                type="number"
                                                step="0.5" min="0" max="100"
                                                className="bb-input"
                                                value={sel.adsets?.[a.meta_adset_id]?.allocation_pct ?? ''}
                                                onChange={(e) => updateAdsetAllocation(c.meta_campaign_id, a.meta_adset_id, e.target.value)}
                                                style={{ width: 90 }}
                                              />
                                            </td>
                                            <td className="num">${allocated.toFixed(0)}</td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                  <div style={{ textAlign: 'right', fontSize: 12, marginTop: 6 }}>
                                    Total:{' '}
                                    <span style={{
                                      fontWeight: 700,
                                      color: allocOk ? '#0f5132' : '#b45309',
                                    }}>
                                      {allocSum.toFixed(2)}%
                                    </span>
                                    {!allocOk && <span className="bb-muted"> — must be 100%</span>}
                                  </div>
                                </div>
                              </td>
                            </tr>
                          );

                          return [mainRow, allocRow];
                        })}
                      </tbody>
                    </table>
                  </>
                )}

                {!importLoading && !importError && metaCampaigns.length === 0 && (
                  <EmptyState
                    icon={Inbox}
                    title="No active campaigns found"
                    body="There are no active campaigns in this Meta ad account."
                  />
                )}
              </div>

              <div className="bb-modal-foot">
                <button className="bb-btn" onClick={closeImport} disabled={importSaving}>Cancel</button>
                <button className="bb-btn bb-btn-primary" onClick={saveImport} disabled={importSaving || importLoading}>
                  {importSaving ? <Loader2 size={14} className="bb-spin" /> : <Plus size={14} aria-hidden="true" />}
                  {importSaving ? 'Saving…' : 'Save selections'}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default AccountDashboard;
