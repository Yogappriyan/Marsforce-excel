import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { doc, getDocFromServer, getFirestore } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const firebaseProjectId = firebaseConfig.projectId;
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: Array<{
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }>;
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData.map((provider) => ({
          providerId: provider.providerId,
          displayName: provider.displayName,
          email: provider.email,
          photoUrl: provider.photoURL,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error:', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testFirestoreConnection(): Promise<{
  ok: boolean;
  offline: boolean;
  message?: string;
}> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return { ok: true, offline: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes('the client is offline')) {
      console.error('Please check your Firebase configuration: client is offline.');
      return {
        ok: false,
        offline: true,
        message: 'Cloud Firestore is unreachable (client is offline). Check network or Firebase config.',
      };
    }
    // Permission-denied or not-found means Firestore server responded cleanly
    return { ok: true, offline: false };
  }
}

export async function isHostnameAuthorizedForFirebase(): Promise<{
  authorized: boolean;
  authorizedDomains?: string[];
}> {
  if (typeof window === 'undefined') return { authorized: true };
  const hostname = window.location.hostname.toLowerCase();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(
      `https://www.googleapis.com/identitytoolkit/v3/relyingparty/getProjectConfig?key=${encodeURIComponent(firebaseConfig.apiKey)}`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    if (!res.ok) return { authorized: true };
    const data = (await res.json()) as { authorizedDomains?: string[] };
    const domains = Array.isArray(data.authorizedDomains)
      ? data.authorizedDomains.map((d) => d.toLowerCase())
      : [];
    if (domains.length === 0) return { authorized: true };
    const authorized = domains.some((d) => hostname === d || hostname.endsWith(`.${d}`));
    return { authorized, authorizedDomains: domains };
  } catch {
    return { authorized: true };
  }
}
