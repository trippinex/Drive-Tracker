/**
 * DriveTracker — auth.js
 *
 * Firebase Authentication with Google Sign-In.
 * Access is restricted to a single allowed email address.
 *
 * ── Setup ────────────────────────────────────────────────────────────────────
 * 1. Go to console.firebase.google.com
 * 2. Add project → select drive-tracker-497900
 * 3. Build → Authentication → Get started → Google → Enable
 * 4. Authentication → Settings → Authorized domains → add your custom domain
 * 5. Project settings → Your apps → Add web app → copy firebaseConfig below
 */

'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
// All secrets are loaded from window.DRIVETRACKER_CONFIG, which is injected by
// config.js at runtime. config.js is never committed to source control:
//   Local dev:   run generate-config.ps1 to create config.js from .env
//   Production:  Cloud Build generates config.js from GCP Secret Manager
const _cfg = window.DRIVETRACKER_CONFIG || {};

const ALLOWED_EMAIL  = _cfg.ALLOWED_EMAIL  || '';
const firebaseConfig = {
  apiKey:            _cfg.FIREBASE_API_KEY,
  authDomain:        _cfg.FIREBASE_AUTH_DOMAIN,
  projectId:         _cfg.FIREBASE_PROJECT_ID,
  storageBucket:     _cfg.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: _cfg.FIREBASE_MESSAGING_SENDER_ID,
  appId:             _cfg.FIREBASE_APP_ID,
};

// ── Guard: don't crash if the config hasn't been filled in yet ────────────────
if (firebaseConfig.apiKey.startsWith('PASTE_')) {
  console.error(
    '[Auth] Firebase config not set. Open auth.js and replace the PASTE_YOUR_* placeholders ' +
    'with your real Firebase project values.'
  );
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('auth-error')?.classList.remove('hidden');
    const el = document.getElementById('auth-error');
    if (el) el.textContent = 'App not configured — see auth.js setup instructions.';
  });
} else {
  initFirebase();
}

function initFirebase() {
  firebase.initializeApp(firebaseConfig);

  const auth     = firebase.auth();
  const provider = new firebase.auth.GoogleAuthProvider();

  // Force the Google account picker every time so switching accounts is easy.
  provider.setCustomParameters({ prompt: 'select_account' });

  // ── Sign in ─────────────────────────────────────────────────────────────────
  function signInWithGoogle() {
    clearAuthError();
    auth.signInWithPopup(provider).catch(err => {
      console.error('[Auth] Sign-in failed:', err.message);
      if (err.code !== 'auth/popup-closed-by-user') {
        showAuthError('Sign-in was cancelled or failed. Please try again.');
      }
    });
  }

  // ── Sign out ────────────────────────────────────────────────────────────────
  function signOutUser() {
    window.stopRealtimeSync?.();   // detach Firestore listeners before signing out
    auth.signOut().then(() => {
      // Clear user info from the header.
      const avatar = document.getElementById('user-avatar');
      const name   = document.getElementById('user-name');
      if (avatar) { avatar.src = ''; avatar.classList.add('hidden'); }
      if (name)   name.textContent = '';
      closeMenu?.();
    });
  }

  // ── Auth state observer ─────────────────────────────────────────────────────
  auth.onAuthStateChanged(user => {
    if (!user) {
      showLoginScreen();
      return;
    }

    // Email restriction — reject accounts that aren't on the allow list.
    if (user.email !== ALLOWED_EMAIL) {
      showLoginScreen();
      showAuthError(`Access denied for ${user.email}. This app is private.`);
      auth.signOut();
      return;
    }

    // Authorised — reveal the app, bootstrap, then sync with Firestore.
    hideLoginScreen(user);
    if (typeof window.initApp === 'function') window.initApp(user);
    if (typeof window.initSync === 'function') {
      window.initSync(user.uid);
      // Initial pull/push to get both devices in sync.
      window.syncOnSignIn?.();
      // Then keep listening for real-time changes from other devices.
      window.startRealtimeSync?.();
    }
  });

  // ── Wire up buttons ─────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('google-signin-btn')
      ?.addEventListener('click', signInWithGoogle);

    document.getElementById('menu-signout-btn')
      ?.addEventListener('click', signOutUser);
  });
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function showLoginScreen() {
  document.getElementById('login-overlay')?.classList.remove('auth-hidden');
  // Make sure the main app UI is non-interactive while logged out.
  document.getElementById('cta-btn')?.setAttribute('disabled', '');
}

function hideLoginScreen(user) {
  document.getElementById('login-overlay')?.classList.add('auth-hidden');
  document.getElementById('cta-btn')?.removeAttribute('disabled');

  // Populate header avatar + first name.
  const userInfo = document.getElementById('user-info');
  const avatar   = document.getElementById('user-avatar');
  const menuName = document.getElementById('user-name');

  if (avatar && user.photoURL) avatar.src = user.photoURL;

  // Full name in the menu dropdown only (first name removed from header).
  if (menuName) menuName.textContent = user.displayName || user.email;

  if (userInfo) userInfo.classList.replace('hidden', 'flex');
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  if (el) { el.textContent = msg; el.classList.remove('hidden'); }
}

function clearAuthError() {
  const el = document.getElementById('auth-error');
  if (el) { el.textContent = ''; el.classList.add('hidden'); }
}
