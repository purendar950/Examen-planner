# Cloud Functions for Leaderboard Caching

## Overview

These Cloud Functions handle leaderboard caching to improve performance and ensure accurate, real-time leaderboard updates.

## Functions

### Triggered Functions

| Function | Trigger | Description |
|----------|---------|-------------|
| `onGroupStatsUpdate` | `groupStats/{statId}` onWrite | Updates group leaderboard cache when stats change |
| `onGroupWrite` | `groups/{groupId}` onWrite | Updates global leaderboard when group changes |

### Scheduled Functions

| Function | Schedule | Description |
|----------|----------|-------------|
| `hourlyLeaderboardRefresh` | Every hour (minute 0) | Refreshes all leaderboard caches |
| `dailyLeaderboardArchive` | Daily at 00:05 IST | Archives previous week leaderboards on Monday |

### Callable Functions

| Function | Purpose |
|----------|---------|
| `refreshGroupLeaderboard` | Manually refresh a group's leaderboard |
| `getUserRanks` | Get user's rank across all their groups |

## Deploy

### Prerequisites

1. Firebase CLI installed:
   ```bash
   npm install -g firebase-tools
   ```

2. Login to Firebase:
   ```bash
   firebase login
   ```

3. Initialize Firebase (if not already done):
   ```bash
   firebase init
   ```

### Deploy Commands

```bash
# Deploy all functions
firebase deploy --only functions

# Deploy specific function
firebase deploy --only functions:hourlyLeaderboardRefresh

# View logs
firebase functions:log
```

### Local Testing

```bash
# Start emulators
cd functions
npm run serve

# Or from project root:
firebase emulators:start --only functions,firestore
```

## Firestore Indexes

Required indexes are defined in `firestore.indexes.json`. Deploy with:

```bash
firebase deploy --only firestore:indexes
```

## Environment Variables

No environment variables required. The functions use the default Firebase project configuration.

## Monitoring

View function logs:
```bash
firebase functions:log
```

In Firebase Console:
- Go to Functions → Logs
- View real-time execution logs and errors

## Cost Optimization

- **Scheduled Functions**: `hourlyLeaderboardRefresh` runs once per hour (24 invocations/day)
- **Triggered Functions**: Only run when data changes
- **Callable Functions**: Only run when explicitly called from client

Estimated invocations per day (for a moderate-sized app):
- Hourly refresh: 24
- Stats updates: ~1000 (depends on user activity)
- Total: ~1024 invocations/day

This stays well within Firebase's free tier (125,000 invocations/month).

## Security

Functions use Firebase Admin SDK which bypasses security rules. Ensure:
1. Only authenticated users can call callable functions
2. Function triggers are idempotent
3. Error handling prevents infinite retry loops
