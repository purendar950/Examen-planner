# Focus Circle Firestore rule additions

Paste these two `match` blocks **inside** the existing:

```js
match /studyCircles/{circleId} {
  ...
}
```

Do not paste them at the top level.

```js
match /joinRequests/{requestUserId} {
  allow read: if request.auth != null
    && (request.auth.uid == requestUserId
      || get(/databases/$(database)/documents/studyCircles/$(circleId)).data.ownerId == request.auth.uid);

  allow create: if request.auth != null
    && request.auth.uid == requestUserId
    && request.resource.data.uid == requestUserId
    && request.resource.data.status == 'pending';

  allow update: if request.auth != null && (
    // A direct/code join records an approved request in the same batch.
    (request.auth.uid == requestUserId
      && request.resource.data.status == 'approved'
      && getAfter(/databases/$(database)/documents/studyCircles/$(circleId)/members/$(requestUserId)).data.uid == requestUserId)
    ||
    // The owner accepts/rejects without being able to change requester identity.
    (get(/databases/$(database)/documents/studyCircles/$(circleId)).data.ownerId == request.auth.uid
      && request.resource.data.status in ['approved', 'rejected']
      && request.resource.data.uid == resource.data.uid
      && request.resource.data.name == resource.data.name
      && request.resource.data.avatar == resource.data.avatar)
  );

  allow delete: if false;
}

match /messages/{messageId} {
  allow read, list: if request.auth != null
    && exists(/databases/$(database)/documents/studyCircles/$(circleId)/members/$(request.auth.uid));

  allow create: if request.auth != null
    && exists(/databases/$(database)/documents/studyCircles/$(circleId)/members/$(request.auth.uid))
    && request.resource.data.uid == request.auth.uid
    && request.resource.data.text is string
    && request.resource.data.text.size() > 0
    && request.resource.data.text.size() <= 1000;

  allow update, delete: if false;
}
```

Add this top-level (or nested under your existing user/root) rule so the per-user stat can be written and read:

```js
match /focusStats/{userId} {
  allow read: if request.auth != null && request.auth.uid == userId;
  allow write: if request.auth != null
    && request.auth.uid == userId
    && request.resource.data.weekKey is string
    && request.resource.data.totalFocusMinutes is int
    && request.resource.data.weeklyFocusMinutes is int;
}
```

No new composite index is required for join requests. Keep the existing `visibility + createdAt` index for public discovery.
