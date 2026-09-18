// Replace with your own Firebase web-app config (Firebase console → Project
// settings → Your apps → Web app). These values are not secrets; access is
// governed by firestore.rules and storage.rules.
export const firebaseConfig = {
  apiKey: "REPLACE_ME",
  authDomain: "REPLACE_ME.firebaseapp.com",
  projectId: "REPLACE_ME",
  storageBucket: "REPLACE_ME.firebasestorage.app",
  appId: "REPLACE_ME",
};

// Google Cloud OAuth *web* client id, used only for the incremental Google
// Health consent. Its authorised origin must include this app's URL.
export const googleOAuthClientId = "REPLACE_ME.apps.googleusercontent.com";
