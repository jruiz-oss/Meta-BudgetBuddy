from flask_sqlalchemy import SQLAlchemy
from datetime import datetime, timedelta
from sqlalchemy.orm import validates

db = SQLAlchemy()

class User(db.Model):
    __tablename__ = 'users'

    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(255), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    accounts = db.relationship('Account', backref='user', lazy=True, cascade='all, delete-orphan')

    def to_dict(self):
        return {
            'id': self.id,
            'email': self.email,
            'created_at': self.created_at.isoformat()
        }

class Account(db.Model):
    __tablename__ = 'accounts'

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    account_name = db.Column(db.String(255), nullable=False)
    meta_account_id = db.Column(db.String(255), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    campaigns = db.relationship('Campaign', backref='account', lazy=True, cascade='all, delete-orphan')
    settings = db.relationship('AccountSettings', backref='account', lazy=True, uselist=False, cascade='all, delete-orphan')
    pacing_runs = db.relationship('PacingRun', backref='account', lazy=True, cascade='all, delete-orphan')

    def to_dict(self):
        # Aggregate fields the dashboard expects. For now these are computed
        # from local DB only (no live Meta data); pacing_status counts come
        # from the latest PacingData row per campaign when available.
        total_daily_budget = sum((c.daily_budget or 0) for c in self.campaigns)

        on_track = over_pacing = under_pacing = 0
        for c in self.campaigns:
            latest = c.pacing_data[-1] if getattr(c, 'pacing_data', None) else None
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
            status_category = 'on_track'  # no data yet → neutral/green

        return {
            'id': self.id,
            'user_id': self.user_id,
            'account_name': self.account_name,
            'meta_account_id': self.meta_account_id,
            'created_at': self.created_at.isoformat(),
            'campaign_count': len(self.campaigns),
            'total_daily_budget': round(total_daily_budget, 2),
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
    daily_budget = db.Column(db.Float, nullable=False)
    flight_type = db.Column(db.String(50), default='ALWAYS_ON')  # ALWAYS_ON or LIMITED
    flight_start_date = db.Column(db.DateTime)
    flight_end_date = db.Column(db.DateTime)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    pacing_data = db.relationship('PacingData', backref='campaign', lazy=True, cascade='all, delete-orphan')
    adjustments = db.relationship('BudgetAdjustment', backref='campaign', lazy=True, cascade='all, delete-orphan')

    @property
    def flight_status(self):
        """Calculate if campaign is active based on flight dates."""
        if self.flight_type == 'ALWAYS_ON':
            return 'active'

        now = datetime.utcnow()
        if self.flight_start_date and self.flight_end_date:
            if now < self.flight_start_date:
                return 'pending'
            elif now > self.flight_end_date:
                return 'ended'
            else:
                return 'active'
        return 'pending'

    def to_dict(self):
        return {
            'id': self.id,
            'account_id': self.account_id,
            'campaign_name': self.campaign_name,
            'meta_campaign_id': self.meta_campaign_id,
            'daily_budget': self.daily_budget,
            'flight_type': self.flight_type,
            'flight_start_date': self.flight_start_date.isoformat() if self.flight_start_date else None,
            'flight_end_date': self.flight_end_date.isoformat() if self.flight_end_date else None,
            'flight_status': self.flight_status,
            'created_at': self.created_at.isoformat(),
            'latest_pacing': self.pacing_data[-1].to_dict() if self.pacing_data else None
        }

class PacingData(db.Model):
    __tablename__ = 'pacing_data'

    id = db.Column(db.Integer, primary_key=True)
    campaign_id = db.Column(db.Integer, db.ForeignKey('campaigns.id'), nullable=False)
    date = db.Column(db.DateTime, default=datetime.utcnow)
    actual_spend = db.Column(db.Float, nullable=False)
    expected_spend = db.Column(db.Float, nullable=False)
    pace_ratio = db.Column(db.Float, nullable=False)
    recommended_daily_budget = db.Column(db.Float)
    recommendation = db.Column(db.String(50))  # on_track, over_pacing, under_pacing

    def to_dict(self):
        return {
            'id': self.id,
            'campaign_id': self.campaign_id,
            'date': self.date.isoformat(),
            'actual_spend': round(self.actual_spend, 2),
            'expected_spend': round(self.expected_spend, 2),
            'pace_ratio': round(self.pace_ratio, 3),
            'recommended_daily_budget': round(self.recommended_daily_budget, 2) if self.recommended_daily_budget else None,
            'recommendation': self.recommendation
        }

class BudgetAdjustment(db.Model):
    __tablename__ = 'budget_adjustments'

    id = db.Column(db.Integer, primary_key=True)
    campaign_id = db.Column(db.Integer, db.ForeignKey('campaigns.id'), nullable=False)
    previous_budget = db.Column(db.Float, nullable=False)
    new_budget = db.Column(db.Float, nullable=False)
    change_percent = db.Column(db.Float, nullable=False)
    reason = db.Column(db.String(255))
    applied_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            'id': self.id,
            'campaign_id': self.campaign_id,
            'previous_budget': round(self.previous_budget, 2),
            'new_budget': round(self.new_budget, 2),
            'change_percent': round(self.change_percent, 2),
            'reason': self.reason,
            'applied_at': self.applied_at.isoformat()
        }

class PacingRun(db.Model):
    __tablename__ = 'pacing_runs'

    id = db.Column(db.Integer, primary_key=True)
    account_id = db.Column(db.Integer, db.ForeignKey('accounts.id'), nullable=False)
    run_type = db.Column(db.String(50))  # 'calculate' or 'apply'
    campaigns_checked = db.Column(db.Integer)
    adjustments_made = db.Column(db.Integer)
    errors = db.Column(db.Text)
    executed_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            'id': self.id,
            'account_id': self.account_id,
            'run_type': self.run_type,
            'campaigns_checked': self.campaigns_checked,
            'adjustments_made': self.adjustments_made,
            'errors': self.errors,
            'executed_at': self.executed_at.isoformat()
        }

class AccountSettings(db.Model):
    __tablename__ = 'account_settings'

    id = db.Column(db.Integer, primary_key=True)
    account_id = db.Column(db.Integer, db.ForeignKey('accounts.id'), nullable=False, unique=True)
    min_daily_budget = db.Column(db.Float, default=5.0)
    max_daily_change_percent = db.Column(db.Float, default=25.0)
    pace_tolerance_percent = db.Column(db.Float, default=5.0)
    auto_adjust_enabled = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            'id': self.id,
            'account_id': self.account_id,
            'min_daily_budget': self.min_daily_budget,
            'max_daily_change_percent': self.max_daily_change_percent,
            'pace_tolerance_percent': self.pace_tolerance_percent,
            'auto_adjust_enabled': self.auto_adjust_enabled,
            'created_at': self.created_at.isoformat()
        }
