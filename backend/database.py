from flask_sqlalchemy import SQLAlchemy
from datetime import datetime
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
    meta_token = db.Column(db.String(1000), nullable=False)  # Meta API access token
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    campaigns = db.relationship('Campaign', backref='account', lazy=True, cascade='all, delete-orphan')
    settings = db.relationship('AccountSettings', backref='account', lazy=True, uselist=False, cascade='all, delete-orphan')
    pacing_runs = db.relationship('PacingRun', backref='account', lazy=True, cascade='all, delete-orphan')

    def to_dict(self):
        total_monthly_budget = sum((c.monthly_budget or 0) for c in self.campaigns)

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
            status_category = 'on_track'  # no data yet → neutral

        return {
            'id': self.id,
            'user_id': self.user_id,
            'account_name': self.account_name,
            'meta_account_id': self.meta_account_id,
            'created_at': self.created_at.isoformat(),
            'campaign_count': len(self.campaigns),
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
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    pacing_data = db.relationship('PacingData', backref='campaign', lazy=True, cascade='all, delete-orphan')
    adjustments = db.relationship('BudgetAdjustment', backref='campaign', lazy=True, cascade='all, delete-orphan')

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
            'created_at': self.created_at.isoformat(),
            'latest_pacing': self.pacing_data[-1].to_dict() if self.pacing_data else None,
        }


class PacingData(db.Model):
    __tablename__ = 'pacing_data'

    id = db.Column(db.Integer, primary_key=True)
    campaign_id = db.Column(db.Integer, db.ForeignKey('campaigns.id'), nullable=False)
    date = db.Column(db.Date, nullable=False)
    current_daily_budget = db.Column(db.Float)
    actual_spend = db.Column(db.Float, nullable=False)
    expected_spend = db.Column(db.Float, nullable=False)
    pace_ratio = db.Column(db.Float, nullable=False)
    recommended_daily_budget = db.Column(db.Float)
    change_percent = db.Column(db.Float)
    status = db.Column(db.String(50))  # ON_PACE, INCREASE, DECREASE

    def to_dict(self):
        return {
            'id': self.id,
            'campaign_id': self.campaign_id,
            'date': self.date.isoformat() if self.date else None,
            'current_daily_budget': round(self.current_daily_budget, 2) if self.current_daily_budget else None,
            'actual_spend': round(self.actual_spend, 2),
            'expected_spend': round(self.expected_spend, 2),
            'pace_ratio': round(self.pace_ratio, 3),
            'recommended_daily_budget': round(self.recommended_daily_budget, 2) if self.recommended_daily_budget else None,
            'change_percent': round(self.change_percent, 1) if self.change_percent is not None else None,
            'status': self.status,
        }


class BudgetAdjustment(db.Model):
    __tablename__ = 'budget_adjustments'

    id = db.Column(db.Integer, primary_key=True)
    campaign_id = db.Column(db.Integer, db.ForeignKey('campaigns.id'), nullable=False)
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
