# Meta BudgetBuddy

A full-stack budget pacing tool for Meta (Facebook) Ads that automatically monitors campaign spend and recommends daily budget adjustments based on pace ratios.

## Features

- **Pace Ratio Monitoring**: Tracks actual vs. expected spend to determine if campaigns are on-track, over-pacing, or under-pacing
- **Smart Budget Adjustments**: Automatically recommends and applies budget changes with safety guards (min floor, max daily change cap)
- **Campaign Flights**: Support for always-on campaigns and time-limited "flights" with automatic activation/deactivation
- **Multi-Account Management**: Manage multiple Meta ad accounts from a single dashboard
- **Activity Logging**: Full audit trail of pacing runs and budget adjustments
- **Real-time Dashboards**: Account-level and campaign-level pacing status with 30-day history charts

## Tech Stack

### Backend
- Flask (Python web framework)
- SQLAlchemy ORM
- PostgreSQL (via Neon)
- Flask-CORS for API access
- Session-based authentication

### Frontend
- React 18
- React Router for navigation
- Axios for API calls
- Chart.js for pacing history visualization
- Responsive CSS design

### Deployment
- Backend: Railway or Render
- Frontend: Vercel
- Database: Neon PostgreSQL

## Setup

### Prerequisites
- Python 3.8+
- Node.js 14+
- PostgreSQL database (or Neon connection string)
- Meta API access token

### Backend Setup

```bash
cd backend
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -r requirements.txt
```

Copy `.env.example` to `.env` and fill in:
- `DATABASE_URL`: Your PostgreSQL connection string
- `SECRET_KEY`: A random secret key for sessions
- `META_API_ACCESS_TOKEN`: Your Meta API access token

Run the development server:
```bash
python app.py
```

Backend runs on `http://localhost:5000`

### Frontend Setup

```bash
cd frontend
npm install
npm start
```

Frontend runs on `http://localhost:3000` (proxy to backend at `:5000`)

## API Endpoints

### Authentication
- `POST /api/auth/register` - Create account
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Current user

### Accounts
- `GET /api/accounts` - List accounts
- `POST /api/accounts` - Create account
- `GET /api/accounts/:id` - Get account details
- `PUT /api/accounts/:id` - Update account
- `DELETE /api/accounts/:id` - Delete account
- `GET /api/accounts/:id/summary` - Account pacing summary

### Campaigns
- `GET /api/campaigns/account/:id` - List campaigns for account
- `POST /api/campaigns/account/:id` - Create campaign
- `GET /api/campaigns/:id` - Get campaign details
- `PUT /api/campaigns/:id` - Update campaign
- `DELETE /api/campaigns/:id` - Delete campaign
- `GET /api/campaigns/:id/pacing-history` - 30-day pacing history

### Pacing
- `POST /api/pacing/:id/run` - Calculate pacing (dry run, no adjustments)
- `POST /api/pacing/:id/apply` - Calculate and apply budget adjustments

### Settings
- `GET /api/settings/:id` - Get account settings
- `PUT /api/settings/:id` - Update pacing parameters
- `GET /api/settings/:id/flights` - List campaign flights
- `PUT /api/settings/:id/flights/:campaign_id` - Update flight config
- `PUT /api/settings/:id/flights/batch` - Batch update flights

### History
- `GET /api/history/:id/summary` - Activity summary
- `GET /api/history/:id/pacing-runs` - Pacing run log
- `GET /api/history/:id/adjustments` - Budget adjustment log

## Pacing Logic

**Pace Ratio** = Actual Spend / Expected Spend

- **On-Track**: Pace ratio within ±tolerance % (default 5%)
- **Over-Pacing**: Pace ratio > (1.0 + tolerance %)
- **Under-Pacing**: Pace ratio < (1.0 - tolerance %)

**Daily Budget Adjustment**:
- Max change limited to ±25% of current budget (configurable)
- Cannot drop below minimum daily budget (default $5, configurable)
- Calculated from recommended budget = current budget / pace ratio

## Environment Variables

```
DATABASE_URL=postgresql://user:password@host:5432/meta_budgetbuddy
SECRET_KEY=your-secret-key-here
META_API_ACCESS_TOKEN=your-meta-api-token-here
FLASK_ENV=development
```

## Deployment

### Backend (Railway/Render)
1. Push code to GitHub
2. Connect repository to Railway/Render
3. Set environment variables
4. Deploy

### Frontend (Vercel)
1. Push code to GitHub
2. Connect frontend directory to Vercel
3. Set `REACT_APP_API_URL` to your deployed backend URL
4. Deploy

## License

Private project
