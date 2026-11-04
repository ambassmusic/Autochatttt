import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  GoogleAuthProvider, 
  signInWithPopup, 
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  signOut,
  onAuthStateChanged,
  User as FirebaseUser
} from 'firebase/auth';
import { 
  initializeFirestore,
  doc, 
  getDoc, 
  setDoc, 
  updateDoc, 
  deleteDoc, 
  collection, 
  getDocs, 
  onSnapshot,
  getDocFromServer,
  query,
  where
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import { Product, Order, BotSettings, CustomerLead, AppointmentBooking, AuthUser, BusinessIndustry, PlanTier } from '../types';

// Initialize Firebase App
const app = initializeApp(firebaseConfig);

// CRITICAL: Initialize Firestore with explicit database ID and long polling to prevent WebChannel streaming timeouts
export const db = initializeFirestore(app, {
  experimentalForceLongPolling: true,
}, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export { onAuthStateChanged };
export type { FirebaseUser };

// Error Handling Specification
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
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.warn('Firestore Operation Notice: ', JSON.stringify(errInfo));
  return errInfo;
}

// Test initial connection as required by specification
export async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.warn("Please check your Firebase configuration or internet connection.");
    }
  }
}
testConnection();

// ================= REAL FIREBASE AUTHENTICATION =================

export function isSuperAdminEmail(email?: string | null): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  return (
    normalized === 'musicben92@gmail.com' ||
    normalized === 'weightlosstipsinside@gmail.com' ||
    normalized === 'didyndiadan@gmail.com'
  );
}

export async function registerWithEmail(
  email: string, 
  pass: string, 
  displayName: string, 
  storeName?: string, 
  industry?: BusinessIndustry,
  country?: string
) {
  try {
    const cred = await createUserWithEmailAndPassword(auth, email.trim(), pass);
    if (displayName) {
      try {
        await updateProfile(cred.user, { displayName });
      } catch {
        // non-blocking
      }
    }
    const isSuperAdmin = isSuperAdminEmail(cred.user.email);
    const profile = await syncUserProfile(cred.user, {
      name: displayName,
      storeName: storeName || `${displayName}'s Store`,
      industry: industry || 'fashion',
      role: isSuperAdmin ? 'superadmin' : 'merchant'
    });
    return { user: cred.user, profile, source: 'firebase' as const };
  } catch (firebaseErr: any) {
    // If Firebase Auth Email/Password is not enabled (auth/operation-not-allowed)
    // or if the provider is disabled in Firebase console,
    // seamlessly register via real fullstack backend merchant API!
    if (
      firebaseErr?.code === 'auth/operation-not-allowed' || 
      firebaseErr?.message?.includes('operation-not-allowed')
    ) {
      console.warn('Firebase Email/Password provider disabled in console. Seamlessly registering via backend store API...');
      const resp = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          password: pass,
          name: displayName,
          businessName: storeName || `${displayName}'s Store`,
          industry: industry || 'fashion',
          country: country || 'United States'
        })
      });

      const data = await resp.json();
      if (!resp.ok || !data.success) {
        throw new Error(data.error || 'Registration failed');
      }

      // Also try to persist user profile to Firestore if accessible
      try {
        const userRef = doc(db, 'users', data.user.id);
        await setDoc(userRef, {
          uid: data.user.id,
          id: data.user.id,
          email: data.user.email,
          name: data.user.name,
          businessName: data.user.businessName,
          industry: data.user.industry,
          role: data.user.role,
          planTier: data.user.planTier,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }, { merge: true });
      } catch {
        // non-blocking Firestore sync
      }

      return {
        user: { uid: data.user.id, email: data.user.email, displayName: data.user.name } as any,
        profile: data.user as AuthUser,
        source: 'backend' as const,
        firebaseEmailDisabled: true
      };
    }
    throw firebaseErr;
  }
}

export async function loginWithEmail(email: string, pass: string) {
  try {
    const cred = await signInWithEmailAndPassword(auth, email.trim(), pass);
    const isSuperAdmin = isSuperAdminEmail(cred.user.email);
    const profile = await syncUserProfile(cred.user, {
      name: cred.user.displayName || email.split('@')[0],
      role: isSuperAdmin ? 'superadmin' : 'merchant'
    });
    return { user: cred.user, profile, source: 'firebase' as const };
  } catch (firebaseErr: any) {
    if (
      firebaseErr?.code === 'auth/operation-not-allowed' ||
      firebaseErr?.code === 'auth/user-not-found' ||
      firebaseErr?.code === 'auth/invalid-credential' ||
      firebaseErr?.message?.includes('operation-not-allowed')
    ) {
      // Try backend authentication
      try {
        const resp = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim(), password: pass })
        });
        const data = await resp.json();
        if (resp.ok && data.success) {
          return {
            user: { uid: data.user.id, email: data.user.email, displayName: data.user.name } as any,
            profile: data.user as AuthUser,
            source: 'backend' as const
          };
        }
      } catch {
        // fallback
      }
    }
    throw firebaseErr;
  }
}

export async function loginWithGoogle() {
  const cred = await signInWithPopup(auth, googleProvider);
  const isSuperAdmin = isSuperAdminEmail(cred.user.email);
  const profile = await syncUserProfile(cred.user, {
    name: cred.user.displayName || 'Google Merchant',
    role: isSuperAdmin ? 'superadmin' : 'merchant'
  });
  return { user: cred.user, profile, source: 'firebase' as const };
}

export async function logoutUser() {
  try {
    await signOut(auth);
  } catch {
    // ignore
  }
  try {
    localStorage.removeItem('omnichat_session');
    localStorage.removeItem('omnichat_whatsapp_session');
  } catch {
    // ignore
  }
}

// ================= MULTI-TENANT CLOUD REPOSITORY =================

/**
 * Sync or update merchant profile in Firestore
 */
export async function syncUserProfile(
  user: FirebaseUser, 
  extra?: { name?: string; storeName?: string; industry?: BusinessIndustry; role?: string }
): Promise<AuthUser | null> {
  const userRef = doc(db, 'users', user.uid);
  const isSuperAdmin = isSuperAdminEmail(user.email);
  const verifiedRole: 'superadmin' | 'merchant' = isSuperAdmin ? 'superadmin' : 'merchant';

  try {
    const existing = await getDoc(userRef);
    if (!existing.exists()) {
      const payload: AuthUser = {
        id: user.uid,
        email: user.email || '',
        name: extra?.name || user.displayName || user.email?.split('@')[0] || 'Merchant',
        businessName: extra?.storeName || `${user.displayName || 'My'} Store`,
        industry: extra?.industry || 'fashion',
        role: verifiedRole,
        planTier: 'starter'
      };
      await setDoc(userRef, {
        ...payload,
        uid: user.uid,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      return payload;
    } else {
      const data = existing.data() as any;
      if (data.role !== verifiedRole) {
        await updateDoc(userRef, { role: verifiedRole, updatedAt: new Date().toISOString() });
        data.role = verifiedRole;
      }
      return {
        id: user.uid,
        email: user.email || data.email || '',
        name: data.name || extra?.name || user.displayName || 'Merchant',
        businessName: data.businessName || data.storeName || `${user.displayName || 'My'} Store`,
        industry: (data.industry as BusinessIndustry) || 'fashion',
        role: verifiedRole,
        planTier: (data.planTier as PlanTier) || 'starter'
      };
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}`);
    return null;
  }
}

/**
 * Seed initial catalog to Firestore if the merchant's store is fresh
 */
export async function seedInitialStoreProducts(storeId: string, initialProducts: Product[]) {
  if (!initialProducts || initialProducts.length === 0) return;
  try {
    for (const prod of initialProducts) {
      const prodRef = doc(db, 'stores', storeId, 'products', prod.id);
      await setDoc(prodRef, {
        ...prod,
        storeId,
        updatedAt: new Date().toISOString()
      }, { merge: true });
    }
  } catch (err) {
    console.warn('[Firestore] Notice during initial seeding:', err);
  }
}

/**
 * Subscribe to merchant store products in Firestore
 */
export function subscribeToStoreProducts(
  storeId: string, 
  onUpdate: (products: Product[]) => void,
  fallbackSeed?: Product[]
) {
  const collRef = collection(db, 'stores', storeId, 'products');
  let hasSeeded = false;

  return onSnapshot(collRef, async (snapshot) => {
    const items: Product[] = [];
    snapshot.forEach(d => {
      items.push(d.data() as Product);
    });

    if (items.length > 0) {
      onUpdate(items);
    } else if (snapshot.empty && fallbackSeed && fallbackSeed.length > 0 && !hasSeeded) {
      hasSeeded = true;
      // Seed initial products so the merchant starts with a rich catalog
      await seedInitialStoreProducts(storeId, fallbackSeed);
      onUpdate(fallbackSeed);
    }
  }, (err) => {
    handleFirestoreError(err, OperationType.LIST, `stores/${storeId}/products`);
  });
}

/**
 * Save product to Firestore for the active merchant store
 */
export async function saveStoreProduct(storeId: string, product: Product) {
  const prodRef = doc(db, 'stores', storeId, 'products', product.id);
  try {
    await setDoc(prodRef, {
      ...product,
      storeId,
      updatedAt: new Date().toISOString()
    }, { merge: true });
    return true;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `stores/${storeId}/products/${product.id}`);
    return false;
  }
}

/**
 * Delete product from Firestore
 */
export async function deleteStoreProduct(storeId: string, productId: string) {
  const prodRef = doc(db, 'stores', storeId, 'products', productId);
  try {
    await deleteDoc(prodRef);
    return true;
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `stores/${storeId}/products/${productId}`);
    return false;
  }
}

/**
 * Subscribe to merchant store orders in Firestore
 */
export function subscribeToStoreOrders(storeId: string, onUpdate: (orders: Order[]) => void) {
  const collRef = collection(db, 'stores', storeId, 'orders');
  return onSnapshot(collRef, (snapshot) => {
    const items: Order[] = [];
    snapshot.forEach(d => {
      items.push(d.data() as Order);
    });
    if (items.length > 0) {
      onUpdate(items);
    }
  }, (err) => {
    handleFirestoreError(err, OperationType.LIST, `stores/${storeId}/orders`);
  });
}

/**
 * Save or update order in Firestore
 */
export async function saveStoreOrder(storeId: string, order: Order) {
  const orderRef = doc(db, 'stores', storeId, 'orders', order.id);
  try {
    await setDoc(orderRef, {
      ...order,
      storeId,
      updatedAt: new Date().toISOString()
    }, { merge: true });
    return true;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `stores/${storeId}/orders/${order.id}`);
    return false;
  }
}

/**
 * Save merchant store settings to Firestore
 */
export async function saveStoreSettings(storeId: string, settings: BotSettings) {
  const setRef = doc(db, 'stores', storeId, 'settings', 'current');
  try {
    await setDoc(setRef, {
      ...settings,
      storeId,
      updatedAt: new Date().toISOString()
    }, { merge: true });
    return true;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `stores/${storeId}/settings/current`);
    return false;
  }
}

/**
 * Load merchant store settings from Firestore
 */
export async function loadStoreSettings(storeId: string): Promise<Partial<BotSettings> | null> {
  const setRef = doc(db, 'stores', storeId, 'settings', 'current');
  try {
    const snap = await getDoc(setRef);
    if (snap.exists()) {
      return snap.data() as Partial<BotSettings>;
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, `stores/${storeId}/settings/current`);
  }
  return null;
}
