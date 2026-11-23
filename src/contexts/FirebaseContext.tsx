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
  firebaseProjectId,
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
  connectionOffline: boolean;
  connectionMessage: string | null;
  signingIn: boolean;
  vaultAuthError: string | null;
  signInWithGoogle: () => Promise<void>;
  signOutFirebase: () => Promise<void>;
  clearVaultAuthError: () => void;
}

const FirebaseContext = createContext<FirebaseContextValue | null>(null);

const syncInFlight = new Map<string, Promise<void>>();

async function syncUserProfileToFirestore(user: User): Promise<void> {
  const existingRun = syncInFlight.get(user.uid);
  if (existingRun) {
    return existingRun;
  }

  const run = (async () => {
    if (!user.emailVerified || !user.email) {
      throw new Error('Verified Google email address is required for Firestore Backup Vault access.');
    }

    await user.getIdToken();

    const profilePath = `users/${user.uid}`;
    const profileRef = doc(db, 'users', user.uid);
    const safeName = (user.displayName || user.email.split('@')[0] || 'User').slice(0, 160);

    let existingProfile;
    try {
      existingProfile = await getDoc(profileRef);
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, profilePath);
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
        handleFirestoreError(err, OperationType.CREATE, profilePath);
      }
    } else if (existingProfile.data()?.displayName !== safeName) {
      try {
        await updateDoc(profileRef, {
          displayName: safeName,
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, profilePath);
      }
    }

    const piiPath = `users/${user.uid}/private/info`;
    const piiRef = doc(db, 'users', user.uid, 'private', 'info');
    const safeEmail = user.email.slice(0, 320);

    let existingPii;
    try {
      existingPii = await getDoc(piiRef);
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, piiPath);
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
        handleFirestoreError(err, OperationType.CREATE, piiPath);
      }
    } else if (existingPii.data()?.email !== safeEmail) {
      try {
        await updateDoc(piiRef, {
          email: safeEmail,
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
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
  const [signingIn, setSigningIn] = useState(false);
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
      if (user && user.emailVerified) {
        void syncUserProfileToFirestore(user).catch((err) => {
          setVaultAuthError(
            err instanceof Error ? err.message : 'Failed to initialize Firestore user vault profile.'
          );
        });
      }
    });
    return () => unsubscribe();
  }, []);

  const signInWithGoogle = useCallback(async () => {
    setSigningIn(true);
    setVaultAuthError(null);
    try {
      const domainCheck = await isHostnameAuthorizedForFirebase();
      if (!domainCheck.authorized) {
        const host = typeof window !== 'undefined' ? window.location.hostname : 'this domain';
        throw new Error(
          `Domain "${host}" is not authorized in Firebase Authentication for project "${firebaseProjectId}". Add "${host}" under Firebase Console → Authentication → Settings → Authorized domains, or sign in via your authorized preview URL.`
        );
      }

      const cred = await signInWithPopup(auth, googleProvider);
      if (!cred.user.emailVerified) {
        await signOut(auth);
        throw new Error('Your Google account email must be verified to use the Cloud Backup Vault.');
      }
      await syncUserProfileToFirestore(cred.user);
    } catch (err: any) {
      const code = typeof err?.code === 'string' ? err.code : '';
      let msg = err instanceof Error ? err.message : 'Google sign-in failed';
      if (code === 'auth/unauthorized-domain') {
        const host = typeof window !== 'undefined' ? window.location.hostname : 'this domain';
        msg = `Domain "${host}" is not authorized in Firebase Authentication for project "${firebaseProjectId}". Add it in Firebase Console → Authentication → Settings → Authorized domains.`;
      } else if (code === 'auth/popup-blocked') {
        msg = 'Google sign-in popup was blocked by your browser. Please allow popups for this site and try again.';
      } else if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        msg = 'Google sign-in popup was closed before completing authentication.';
      }
      setVaultAuthError(msg);
      throw err;
    } finally {
      setSigningIn(false);
    }
  }, []);

  const signOutFirebase = useCallback(async () => {
    setVaultAuthError(null);
    await signOut(auth);
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
        signingIn,
        vaultAuthError,
        signInWithGoogle,
        signOutFirebase,
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
