// Stands in for every Firebase SDK module app.js imports from gstatic.com, so
// the app can be loaded under jsdom with no network and no real browser.
import { vi } from "vitest";

export const initializeApp = vi.fn(() => ({}));

export const getAuth = vi.fn(() => ({ currentUser: null }));
export class GoogleAuthProvider {}
export const signInWithPopup = vi.fn(() => new Promise(() => {}));
export const signInWithRedirect = vi.fn(() => new Promise(() => {}));
export const getRedirectResult = vi.fn(async () => null);
export const signOut = vi.fn(async () => {});
export const onAuthStateChanged = vi.fn();

export const getFirestore = vi.fn(() => ({}));
export const collection = vi.fn();
export const query = vi.fn();
export const orderBy = vi.fn();
export const limit = vi.fn();
export const where = vi.fn();
export const getDocs = vi.fn(async () => ({ empty: true, docs: [] }));

export const getStorage = vi.fn(() => ({}));
export const ref = vi.fn();
export const getBlob = vi.fn();
