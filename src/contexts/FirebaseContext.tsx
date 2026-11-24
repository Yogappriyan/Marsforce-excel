import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
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
  googleProvider,
  handleFirestoreError,
  isHostnameAuthorizedForFirebase,
  OperationType,
  testFirestoreConnection,
} from '../lib/firebase.ts';

interface FirebaseContextValue {
  firebaseUser: User | null;
  authReady: boolean;
  isVaultConnected: boolean;
  connectingGoogle: boolean;
  connectionOffline: boolean;
  connectionMessage: string | null;
  vaultAuthError: string | null;
  connectGoogleBackup: () => Promise<void>;
  disconnectGoogleBackup: () => Promise<void>;
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
  const [connectingGoogle, setConnectingGoogle] = useState(false);
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

  const ensureVaultProfile = useCallback(async (user: User) => {
    setVaultAuthError(null);
    try {
      await syncUserProfileToFirestore(user);
    } catch (err) {
      if (!isStillSignedInAs(user.uid)) return;
      setVaultAuthError(
        err instanceof Error ? err.message : 'Failed to initialize Firestore backup vault profile.'
      );
    }
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setFirebaseUser(user);
      setAuthReady(true);
      if (user && user.emailVerified) {
        void ensureVaultProfile(user);
      }
    });
    return () => unsubscribe();
  }, [ensureVaultProfile]);

  const connectGoogleBackup = useCallback(async () => {
    setVaultAuthError(null);
    setConnectingGoogle(true);
    try {
      const domainCheck = await isHostnameAuthorizedForFirebase();
      if (!domainCheck.authorized && typeof window !== 'undefined') {
        setVaultAuthError(
          `Add "${window.location.hostname}" to Firebase Auth Authorized Domains to connect Google Backup here. Backend Excel storage still works automatically.`
        );
        return;
      }

      const cred = await signInWithPopup(auth, googleProvider);
      if (!cred.user.emailVerified) {
        setVaultAuthError('Your Google account must have a verified email to sync Cloud Firestore backups.');
        return;
      }
      await ensureVaultProfile(cred.user);
    } catch (err: any) {
      const code = String(err?.code || '');
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        return;
      }
      if (code === 'auth/popup-blocked') {
        setVaultAuthError('Pop-up was blocked by your browser. Allow pop-ups to connect Google Backup.');
      } else if (code === 'auth/unauthorized-domain' && typeof window !== 'undefined') {
        setVaultAuthError(
          `Domain "${window.location.hostname}" is not authorized in Firebase Console yet. Backend Excel storage still works automatically.`
        );
      } else {
        setVaultAuthError(err instanceof Error ? err.message : 'Unable to connect Google Backup.');
      }
    } finally {
      setConnectingGoogle(false);
    }
  }, [ensureVaultProfile]);

  const disconnectGoogleBackup = useCallback(async () => {
    setVaultAuthError(null);
    try {
      await signOut(auth);
    } catch (err) {
      setVaultAuthError(err instanceof Error ? err.message : 'Unable to disconnect Google Backup.');
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
        connectingGoogle,
        connectionOffline,
        connectionMessage,
        vaultAuthError,
        connectGoogleBackup,
        disconnectGoogleBackup,
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
