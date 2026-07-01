# Study Groups & Leaderboards Feature

## Overview

This feature allows students preparing for the same exam to form study groups, compete on weekly leaderboards, and stay motivated through social accountability.

## Architecture

### Firestore Collections

| Collection | Description |
|------------|-------------|
| `groups` | Study groups with name, examId, members, settings |
| `groupStats` | Per-user weekly stats for leaderboard calculation |
| `leaderboardCache` | Precomputed leaderboards (Cloud Functions write) |
| `groupInvites` | Invite codes for private groups |
| `globalLeaderboard` | Global exam-wide leaderboards |

### Files Structure

```
js/social/
├── groups-core.js     # Group CRUD, membership, invites
├── social-sync.js     # Stats sync to Firestore
├── leaderboard.js     # Leaderboard calculation & display
└── groups-ui.js       # UI components, modals, rendering
```

## Usage

### Creating a Group

```javascript
await createGroup({
  name: 'UPSC 2026 Grind',
  examId: 'upsc',
  targetYear: 2026,
  isPublic: true,
  description: 'Daily study accountability group',
  maxMembers: 50
});
```

### Joining a Group

```javascript
// Join public group
await joinGroup(groupId);

// Join private group with invite code
await joinGroup(groupId, 'ABC123');

// Join by invite code only
await joinGroupByInviteCode('ABC123');
```

### Leaderboard Scoring

| Metric | Points |
|--------|--------|
| Tasks completed | 2 pts each |
| Streak days | 5 pts per day |
| Mock test average | 1 pt per mark |
| Study hours | 1 pt per hour |
| Consistency bonus | 10 pts (all 7 days active) |

## Firestore Security Rules

The `firestore.rules` file includes:

- **groups**: Public groups readable by all auth users; members can update; creator can delete
- **groupStats**: Users can only write their own stats
- **leaderboardCache**: Read-only for auth users; written by Cloud Functions

## UI Components

### Groups Page

Accessed via the "Groups" tab in the navigation bar.

Features:
- Browse public groups by exam
- Create new groups
- Join via invite code
- View group leaderboard
- Real-time rank updates

### Dashboard Widget

Shows:
- User's groups
- Mini leaderboard (top 5)
- Quick access to groups page

## Real-time Updates

Leaderboards update in real-time via Firestore `onSnapshot` listeners:

```javascript
subscribeToLeaderboard(groupId);
```

Stats are synced:
- On every progress save (debounced 3s)
- Every 5 minutes
- On page visibility change
- Before page unload

## Best Practices

1. **Group Size**: Recommended 10-30 members for optimal engagement
2. **Private vs Public**: Use private groups for coaching batches
3. **Leaderboard Reset**: Weekly (Monday 00:00 IST)
4. **Abuse Prevention**: Report mechanism (future enhancement)

## Future Enhancements

- [ ] Group chat integration
- [ ] Badge/achievement system
- [ ] Group challenges
- [ ] Cloud Functions for leaderboard caching
- [ ] Push notifications for rank changes
- [ ] Anonymous leaderboard option

## Testing

1. Create a Firebase project with Firestore
2. Update `firestore.rules` in Firebase Console
3. Create test groups with different exams
4. Verify leaderboard updates on task completion
