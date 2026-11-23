# StructIQ Firestore Security & Zero-Data-Loss Specification

## Security Invariants (Phase 0)
1. **Default-Deny Catch-All**: `match /{document=**} { allow read, write: if false; }` is placed first inside `match /databases/{database}/documents`.
2. **Verified Email Identity**: Every authenticated read/write requires `request.auth != null && request.auth.token.email_verified == true`.
3. **Zero-Data-Loss Protection**: Hard deletes (`allow delete: if false`) are disabled on `/uploads/{uploadId}`, `/uploads/{uploadId}/sheets/{sheetId}`, `/uploads/{uploadId}/rowChunks/{chunkId}`, `/users/{userId}`, and `/users/{userId}/private/{docId}`. Archive uses validated `isArchived` update on `/uploads/{uploadId}`.
4. **Row Chunks Immutability**: Once written, `/uploads/{uploadId}/rowChunks/{chunkId}` documents cannot be updated or deleted (`allow update, delete: if false`), preserving immutable raw Excel source data.
5. **Strict Ownership & Parent Master Gate**:
   - Single-document `get`/`create`/`update` on subcollections `/sheets` and `/rowChunks` verify parent `/uploads/{uploadId}` `ownerUid == request.auth.uid` via `get()`.
   - `allow list` queries evaluate `resource.data.ownerUid == request.auth.uid` directly without cross-document `get()` or `exists()`.
6. **PII Isolation**: User email is isolated into `/users/{userId}/private/{docId}` readable only by `isOwner(userId) || isAdmin()`.
7. **Strict Shape, Size & Timestamp Proofs**:
   - Every schema field checked via `hasAll` + `hasOnly`.
   - Every string and list checked with `.size()` bounds matching `firebase-blueprint.json`.
   - `createdAt == request.time` on create; `updatedAt == request.time` on create/update; immutable fields (`ownerUid`, `uploadId`, `fileSha256`, `createdAt`) cannot be altered on update.

## Dirty Dozen Adversarial Payloads (Verified Denied)
1. Unauthenticated read/list on `/uploads` -> Denied (`isSignedIn()` requires verified auth).
2. Unverified email user writing `/uploads/{id}` -> Denied (`email_verified == true` check).
3. Cross-tenant user reading/modifying another user's `/uploads/{id}` or `/sheets/{sheetId}` -> Denied (`ownerUid == request.auth.uid`).
4. Cross-tenant query `collection(db, 'uploads')` without owner filter -> Denied (`allow list` checks `resource.data.ownerUid == request.auth.uid`).
5. Attempt to `deleteDoc` on `/uploads/{id}`, `/sheets/{sheetId}`, or `/rowChunks/{chunkId}` -> Denied (`allow delete: if false`).
6. Attempt to tamper with `/rowChunks/{chunkId}` via `updateDoc` -> Denied (`allow update: if false`).
7. Escalating role to `'admin'` on `/users/{uid}` create or update -> Denied (`incoming().role == 'user'` on create; `affectedKeys().hasOnly(['displayName', 'updatedAt'])` on update).
8. Path traversal ID `../other` in document ID -> Denied (`isValidId` regex `^[a-zA-Z0-9_\\-]+$`).
9. Oversized array (>500 headers or >80 rows per chunk) or oversized string (>200 chars filename) -> Denied (`.size()` checks).
10. Backdated or forged `createdAt` / `updatedAt` timestamps -> Denied (`== request.time`).
11. Mutating `fileSha256` or `ownerUid` during `/uploads/{id}` update -> Denied (`affectedKeys().hasOnly(['localStatus', 'isArchived', 'chunkCount', 'updatedAt'])`).
12. Reading `/users/{otherUid}/private/info` -> Denied (`isOwner(userId) || isAdmin()`).
