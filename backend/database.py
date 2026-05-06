from flask_sqlalchemy import SQLAlchemy
from datetime import datetime
from sqlalchemy.orm import validates

db = SQLAlchemy()


class User(db.Model):
    __tablename__ = 'users'

    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(255), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    # Shared Meta access token used by all accounts unless overridden per-account.
    global_meta_token = db.Column(db.String(1000), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    accounts = db.relationship('Account', backref='user', lazy=True, cascade='all, delete-orphan')

    def to_dict(self):
        tok = self.global_meta_token or ''
        return {
            'id': self.id,
            'email': self.email,
            'has_global_token': bool(tok),
            'global_token_preview': (tok[:6] + '…' + tok[-4:]) if len(tok) > 10 else ('set' if tok else ''),
            'created_at': self.created_at.isoformat()
        }


class Account(db.Model):
    __tablename__ = 'accounts'

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    account_name = db.Column(db.String(255), nullable=False)
    meta_account_id = db.Column(db.String(255), nullable=False)
    # Per-account token override. Leave blank to fall back to the user's global_meta_token.
    meta_token = db.Column(db.String(1000), nullable=False, default='')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    @property
    def effective_meta_token(self):
        """Account-level token if set; otherwise the owning user's global token."""
        if self.meta_token and self.meta_token.strip():
            return self.meta_token.strip()
        return (self.user.global_meta_token or '').strip() if self.user else ''

    campaigns = db.relationship('Campaign', backref='account', lazy=True, cascade='all, delete-orphan')
    settings = db.relationship('AccountSettings', backref='account', lazy=True, uselist=False, cascade='all, delete-orphan')
    pacing_runs = db.relationship('PacingRun', backref='account', lazy=True, cascade='all, delete-orphan')

    def to_dict(self):
        # Only count tracked campaigns. "Remove" in the UI sets is_active=False (not a hard
        # delete), so without this filter the dashboard reports stale campaigns the user
        # already removed.
        active_campaigns = [c for c in self.campaigns if c.is_active]
        total_monthly_budget = sum((c.monthly_budget or 0) for c in active_campaigns)

        on_track = over_pacing = under_pacing = 0
        for c in active_campaigns:
            # Sort by (date, id) — relationship order is not guaranteed, and same-day re-runs
            # were tying on date alone.
            rows = sorted(
                (p for p in (c.pacing_data or [])),
                key=lambda r: (r.date or datetime.min.date(), r.id or 0),
            )
            latest = rows[-1] if rows else None
            status = getattr(latest, 'status', None)
            if status == 'ON_PACE':
                on_track += 1
            elif status == 'INCREASE':
                under_pacing += 1
            elif status == 'DECREASE':
                over_pacing += 1

        if over_pacing:
            status_category = 'over_pacing'
        elif under_pacing:
            status_category = 'under_pacing'
        elif on_track:
            status_category = 'on_track'
        else:
            status_category = 'on_track'  # no data yet → neutral

        return {
            'id': self.id,
            'user_id': self.user_id,
            'account_name': self.account_name,
            'meta_account_id': self.meta_account_id,
            'created_at': self.created_at.isoformat(),
            'campaign_count': len(active_campaigns),
            'total_monthly_budget': round(total_monthly_budget, 2),
            'status_category': status_category,
            'pacing_status': {
                'on_track': on_track,
                'over_pacing': over_pacing,
                'under_pacing': under_pacing,
            },
            'settings': self.settings.to_dict() if self.settings else None,
        }


class Campaign(db.Model):
    __tablename__ = 'campaigns'

    id = db.Column(db.Integer, primary_key=True)
    account_id = db.Column(db.Integer, db.ForeignKey('accounts.id'), nullable=False)
    campaign_name = db.Column(db.String(255), nullable=False)
    meta_campaign_id = db.Column(db.String(255), nullable=False)
    monthly_budget = db.Column(db.Float, nullable=False)
    flight_type = db.Column(db.String(50), default='ALWAYS_ON')  # ALWAYS_ON or LIMITED
    flight_start_date = db.Column(db.Date)
    flight_end_date = db.Column(db.Date)
    is_active = db.Column(db.Boolean, default=True)
    # Budget mode: CBO = budget set on the campaign itself (single Meta daily_budget),
    # ABO = budget set on each adset (campaign has no daily_budget, adsets carry it).
    # Defaults to CBO for backward compat with existing rows; new rows are detected at sync time.
    budget_mode = db.Column(db.String(10), default='CBO', nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    pacing_data = db.relationship('PacingData', backref='campaign', lazy=True, cascade='all, delete-orphan')
    adjustments = db.relationship('BudgetAdjustment', backref='campaign', lazy=True, cascade='all, delete-orphan')
    adsets = db.relationship('AdSet', backref='campaign', lazy=True, cascade='all, delete-orphan')

    @property
    def flight_status(self):
        """Calculate if campaign is active based on flight dates."""
        if self.flight_type == 'ALWAYS_ON':
            return 'active'

        today = datetime.utcnow().date()
        if self.flight_start_date and self.flight_end_date:
            if today < self.flight_start_date:
                return 'pending'
            elif today > self.flight_end_date:
                return 'ended'
            else:
                return 'active'
        return 'pending'

    def to_dict(self):
        # For ABO campaigns, latest_pacing should be a roll-up across the campaign's adsets,
        # not just the most recent PacingData row (which may be one ad set's row).
        # Callers that want per-adset detail should call get_campaign and look at .adsets.
        latest = None
        if self.budget_mode == 'ABO':
            # Sum the most-recent ad-set rows for the *same date* into a roll-up.
            adset_ids = [a.id for a in self.adsets if a.is_active]
            if adset_ids and self.pacing_data:
                # Latest date across this campaign's pacing rows that belong to adsets
                rows_for_adsets = [p for p in self.pacing_data if p.adset_id in adset_ids]
                if rows_for_adsets:
                    last_date = max((p.date for p in rows_for_adsets if p.date), default=None)
                    if last_date:
                        # Pacing may be run multiple times per day — keep only the highest-id
                        # (most recently written) row per adset so we don't double-count spend.
                        latest_per_adset = {}
                        for p in rows_for_adsets:
                            if p.date == last_date:
                                if p.adset_id not in latest_per_adset or p.id > latest_per_adset[p.adset_id].id:
                                    latest_per_adset[p.adset_id] = p
                        same_day = list(latest_per_adset.values())
                        actual = sum(p.actual_spend or 0 for p in same_day)
                        expected = sum(p.expected_spend or 0 for p in same_day)
                        rec = sum(p.recommended_daily_budget or 0 for p in same_day)
                        cur = sum(p.current_daily_budget or 0 for p in same_day)
                        ratio = (actual / expected) if expected > 0 else 1.0
                        # Pick the worst status across ad sets (DECREASE > INCREASE > ON_PACE)
                        statuses = {p.status for p in same_day}
                        if 'DECREASE' in statuses:
                            roll_status = 'DECREASE'
                        elif 'INCREASE' in statuses:
                            roll_status = 'INCREASE'
                        else:
                            roll_status = 'ON_PACE'
                        change_pct = ((rec - cur) / cur * 100) if cur > 0 else 0.0
                        latest = {
                            'date': last_date.isoformat(),
                            'current_daily_budget': round(cur, 2),
                            'actual_spend': round(actual, 2),
                            'expected_spend': round(expected, 2),
                            'pace_ratio': round(ratio, 3),
                            'recommended_daily_budget': round(rec, 2),
                            'change_percent': round(change_pct, 1),
                            'status': roll_status,
                        }
        else:
            # CBO: most recent campaign-level PacingData row (adset_id IS NULL).
            # Sort explicitly — relationship-list order is not guaranteed, and same-day
            # re-runs were tying on date alone.
            campaign_rows = sorted(
                (p for p in self.pacing_data if p.adset_id is None),
                key=lambda r: (r.date or datetime.min.date(), r.id or 0),
            )
            latest = campaign_rows[-1].to_dict() if campaign_rows else None

        return {
            'id': self.id,
            'account_id': self.account_id,
            'campaign_name': self.campaign_name,
            'meta_campaign_id': self.meta_campaign_id,
            'monthly_budget': self.monthly_budget,
            'flight_type': self.flight_type,
            'flight_start_date': self.flight_start_date.isoformat() if self.flight_start_date else None,
            'flight_end_date': self.flight_end_date.isoformat() if self.flight_end_date else None,
            'flight_status': self.flight_status,
            'is_active': self.is_active,
            'budget_mode': self.budget_mode,
            'adset_count': len(self.adsets),
            'created_at': self.created_at.isoformat(),
            'latest_pacing': latest,
        }


class AdSet(db.Model):
    __tablename__ = 'adsets'

    id = db.Column(db.Integer, primary_key=True)
    campaign_id = db.Column(db.Integer, db.ForeignKey('campaigns.id'), nullable=False)
    meta_adset_id = db.Column(db.String(255), nullable=False)
    adset_name = db.Column(db.String(255), nullable=False)
    # Percent of the campaign's monthly_budget allocated to this adset (0-100).
    # Sum across a campaign's active adsets should be ~100. Used only for ABO campaigns.
    allocation_pct = db.Column(db.Float, default=100.0, nullable=False)
    is_active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    pacing_data = db.relationship(
        'PacingData', backref='adset', lazy=True,
        primaryjoin='PacingData.adset_id == AdSet.id',
    )
    adjustments = db.relationship(
        'BudgetAdjustment', backref='adset', lazy=True,
        primaryjoin='BudgetAdjustment.adset_id == AdSet.id',
    )

    def to_dict(self):
        # Find the most recent ad-set-level PacingData row for this adset.
        # Sort by (date, id) so that when pacing is run multiple times on the same
        # day, the highest-id (most recently written) row wins.
        latest = None
        if self.pacing_data:
            sorted_rows = sorted(
                self.pacing_data,
                key=lambda r: (r.date or datetime.min.date(), r.id),
            )
            latest = sorted_rows[-1].to_dict() if sorted_rows else None
        return {
            'id': self.id,
            'campaign_id': self.campaign_id,
            'meta_adset_id': self.meta_adset_id,
            'adset_name': self.adset_name,
            'allocation_pct': round(self.allocation_pct, 2),
            'is_active': self.is_active,
            'latest_pacing': latest,
        }


class PacingData(db.Model):
    __tablename__ = 'pacing_data'

    id = db.Column(db.Integer, primary_key=True)
    campaign_id = db.Column(db.Integer, db.ForeignKey('campaigns.id'), nullable=False)
    # Nullable: NULL means campaign-level row (CBO); set means ad-set-level row (ABO).
    adset_id = db.Column(db.Integer, db.ForeignKey('adsets.id'), nullable=True)
    date = db.Column(db.Date, nullable=False)
    current_daily_budget = db.Column(db.Float)
    actual_spend = db.Column(db.Float, nullable=False)
    expected_spend = db.Column(db.Float, nullable=False)
    pace_ratio = db.Column(db.Float, nullable=False)
    recommended_daily_budget = db.Column(db.Float)
    change_percent = db.Column(db.Float)
    status = db.Column(db.String(50))  # ON_PACE, INCREASE, DECREASE

    def to_dict(self):
        # Use `is not None` for budget fields — `if self.current_daily_budget` would clobber
        # legitimate $0.00 readings (which can occur when a campaign is paused mid-month).
        return {
            'id': self.id,
            'campaign_id': self.campaign_id,
            'adset_id': self.adset_id,
            'date': self.date.isoformat() if self.date else None,
            'current_daily_budget': round(self.current_daily_budget, 2) if self.current_daily_budget is not None else None,
            'actual_spend': round(self.actual_spend, 2),
            'expected_spend': round(self.expected_spend, 2),
            'pace_ratio': round(self.pace_ratio, 3),
            'recommended_daily_budget': round(self.recommended_daily_budget, 2) if self.recommended_daily_budget is not None else None,
            'change_percent': round(self.change_percent, 1) if self.change_percent is not None else None,
            'status': self.status,
        }


class BudgetAdjustment(db.Model):
    __tablename__ = 'budget_adjustments'

    id = db.Column(db.Integer, primary_key=True)
    campaign_id = db.Column(db.Integer, db.ForeignKey('campaigns.id'), nullable=False)
    # Nullable: NULL means a campaign-level (CBO) adjustment; set means an ad-set-level (ABO) one.
    adset_id = db.Column(db.Integer, db.ForeignKey('adsets.id'), nullable=True)
    old_budget = db.Column(db.Float, nullable=False)
    new_budget = db.Column(db.Float, nullable=False)
    change_percent = db.Column(db.Float, nullable=False)
    reason = db.Column(db.String(255))
    applied_by = db.Column(db.String(255))
    applied_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            'id': self.id,
            'campaign_id': self.campaign_id,
            'adset_id': self.adset_id,
            'old_budget': round(self.old_budget, 2),
            'new_budget': round(self.new_budget, 2),
            'change_percent': round(self.change_percent, 2),
            'reason': self.reason,
            'applied_by': self.applied_by,
            'applied_at': self.applied_at.isoformat()
        }


class PacingRun(db.Model):
    __tablename__ = 'pacing_runs'

    id = db.Column(db.Integer, primary_key=True)
    account_id = db.Column(db.Integer, db.ForeignKey('accounts.id'), nullable=False)
    run_type = db.Column(db.String(50))           # MANUAL, AUTO
    triggered_by = db.Column(db.String(255))      # user email
    campaigns_processed = db.Column(db.Integer)
    adjustments_made = db.Column(db.Integer)
    status = db.Column(db.String(50))             # COMPLETED, PARTIAL, FAILED
    error_message = db.Column(db.Text)
    run_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            'id': self.id,
            'account_id': self.account_id,
            'run_type': self.run_type,
            'triggered_by': self.triggered_by,
            'campaigns_processed': self.campaigns_processed,
            'adjustments_made': self.adjustments_made,
            'status': self.status,
            'error_message': self.error_message,
            'run_at': self.run_at.isoformat() if self.run_at else None,
        }


class AccountSettings(db.Model):
    __tablename__ = 'account_settings'

    id = db.Column(db.Integer, primary_key=True)
    account_id = db.Column(db.Integer, db.ForeignKey('accounts.id'), nullable=False, unique=True)
    min_daily_budget = db.Column(db.Float, default=5.0)
    max_daily_change_percent = db.Column(db.Float, default=25.0)
    pace_tolerance_percent = db.Column(db.Float, default=5.0)
    auto_adjust_enabled = db.Column(db.Boolean, default=False)
    google_sheet_id = db.Column(db.String(500), nullable=True)
    # Send the user a digest email after each automated pacing run for this account.
    # Default off — opt-in only, since SMTP credentials are also opt-in on the server.
    daily_digest_enabled = db.Column(db.Boolean, default=False, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            'id': self.id,
            'account_id': self.account_id,
            'min_daily_budget': self.min_daily_budget,
            'max_daily_change_percent': self.max_daily_change_percent,
            'pace_tolerance_percent': self.pace_tolerance_percent,
            'auto_adjust_enabled': self.auto_adjust_enabled,
            'google_sheet_id': self.google_sheet_id or '',
            'daily_digest_enabled': bool(self.daily_digest_enabled),
            'created_at': self.created_at.isoformat()
        }
