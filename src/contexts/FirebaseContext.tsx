import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  onAuthStateChanged,
  type User,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import {
  auth,
  db,
  handleFirestoreError,
  OperationType,
  testFirestoreConnection,
} from '../lib/firebase.ts';

interface FirebaseContextValue {
  firebaseUser: User | null;
  authReady: boolean;
  isVaultConnected: boolean;
  connectionOffline: boolean;
  connectionMessage: string | null;
  vaultAuthError: string | null;
  ensureVaultProfile: (user: User) => Promise<void>;
  clearVaultAuthError: () => void;
}

const FirebaseContext = createContext<FirebaseContextValue | null>(null);

const syncInFlight = new Map<string, Promise<void>>();

function isStillSignedInAs(uid: string): boolean {
  return Boolean(auth.currentUser && auth.currentUser.uid === uid && auth.currentUser.emailVerified);
}

async function syncUserProfileToFirestore(user: User): Promise<void> {
  const existingRun = syncInFlight.get(user.uid);
  if (existingRun) {
    return existingRun;
  }

  const run = (async () => {
    if (!user.emailVerified || !user.email) {
      throw new Error('Verified Google email address is required for Firestore Backup Vault access.');
    }
    if (!isStillSignedInAs(user.uid)) {
      return;
    }

    await user.getIdToken();
    if (!isStillSignedInAs(user.uid)) {
      return;
    }

    const profilePath = `users/${user.uid}`;
    const profileRef = doc(db, 'users', user.uid);
    const safeName = (user.displayName || user.email.split('@')[0] || 'User').slice(0, 160);

    let existingProfile;
    try {
      existingProfile = await getDoc(profileRef);
    } catch (err) {
      if (!isStillSignedInAs(user.uid)) return;
      handleFirestoreError(err, OperationType.GET, profilePath);
    }

    if (!isStillSignedInAs(user.uid)) {
      return;
    }

    if (!existingProfile.exists()) {
      try {
        await setDoc(profileRef, {
          uid: user.uid,
          displayName: safeName,
          role: 'user',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        if (!isStillSignedInAs(user.uid)) return;
        handleFirestoreError(err, OperationType.CREATE, profilePath);
      }
    } else if (existingProfile.data()?.displayName !== safeName) {
      try {
        await updateDoc(profileRef, {
          displayName: safeName,
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        if (!isStillSignedInAs(user.uid)) return;
        handleFirestoreError(err, OperationType.UPDATE, profilePath);
      }
    }

    if (!isStillSignedInAs(user.uid)) {
      return;
    }

    const piiPath = `users/${user.uid}/private/info`;
    const piiRef = doc(db, 'users', user.uid, 'private', 'info');
    const safeEmail = user.email.slice(0, 320);

    let existingPii;
    try {
      existingPii = await getDoc(piiRef);
    } catch (err) {
      if (!isStillSignedInAs(user.uid)) return;
      handleFirestoreError(err, OperationType.GET, piiPath);
    }

    if (!isStillSignedInAs(user.uid)) {
      return;
    }

    if (!existingPii.exists()) {
      try {
        await setDoc(piiRef, {
          uid: user.uid,
          email: safeEmail,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        if (!isStillSignedInAs(user.uid)) return;
        handleFirestoreError(err, OperationType.CREATE, piiPath);
      }
    } else if (existingPii.data()?.email !== safeEmail) {
      try {
        await updateDoc(piiRef, {
          email: safeEmail,
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        if (!isStillSignedInAs(user.uid)) return;
        handleFirestoreError(err, OperationType.UPDATE, piiPath);
      }
    }
  })().finally(() => {
    syncInFlight.delete(user.uid);
  });

  syncInFlight.set(user.uid, run);
  return run;
}

export function FirebaseProvider({ children }: { children: React.ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [connectionOffline, setConnectionOffline] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [vaultAuthError, setVaultAuthError] = useState<string | null>(null);

  useEffect(() => {
    void testFirestoreConnection().then((res) => {
      if (!res.ok && res.offline) {
        setConnectionOffline(true);
        setConnectionMessage(res.message || 'Firestore connection is offline.');
      }
    });
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setFirebaseUser(user);
      setAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  const ensureVaultProfile = useCallback(async (user: User) => {
    setVaultAuthError(null);
    try {
      await syncUserProfileToFirestore(user);
    } catch (err) {
      if (!isStillSignedInAs(user.uid)) return;
      setVaultAuthError(
        err instanceof Error ? err.message : 'Failed to initialize Firestore user vault profile.'
      );
    }
  }, []);

  const clearVaultAuthError = useCallback(() => setVaultAuthError(null), []);

  const isVaultConnected = Boolean(firebaseUser && firebaseUser.emailVerified);

  return (
    <FirebaseContext.Provider
      value={{
        firebaseUser,
        authReady,
        isVaultConnected,
        connectionOffline,
        connectionMessage,
        vaultAuthError,
        ensureVaultProfile,
        clearVaultAuthError,
      }}
    >
      {children}
    </FirebaseContext.Provider>
  );
}

export function useFirebase() {
  const ctx = useContext(FirebaseContext);
  if (!ctx) throw new Error('useFirebase must be used inside FirebaseProvider');
  return ctx;
}
