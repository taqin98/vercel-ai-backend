/**
 * Firebase Admin SDK helper for Push Notifications.
 *
 * Env vars required:
 *   FCM_PROJECT_ID        – Firebase project ID
 *   FCM_CLIENT_EMAIL      – Service-account client email
 *   FCM_PRIVATE_KEY       – Service-account private key (with \n line-breaks)
 */

import admin from "firebase-admin";
import { createHttpError } from "./_auth.js";

let _app = null;

function getFirebaseApp() {
  if (_app) return _app;

  const projectId = String(process.env.FCM_PROJECT_ID || "").trim();
  const clientEmail = String(process.env.FCM_CLIENT_EMAIL || "").trim();
  // Vercel stores env vars with literal \n – convert them back
  const privateKey = String(process.env.FCM_PRIVATE_KEY || "")
    .replace(/\\n/g, "\n")
    .trim();

  if (!projectId || !clientEmail || !privateKey) {
    throw createHttpError(
      "Firebase env vars belum lengkap (FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY).",
      500
    );
  }

  _app = admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });
  return _app;
}

/**
 * Send a push notification to a single FCM token.
 * Returns true on success, false if token is invalid/expired (so caller can clean up).
 */
export async function sendPush(token, title, body, data = {}) {
  const app = getFirebaseApp();
  const messaging = admin.messaging(app);

  const message = {
    token,
    notification: { title, body },
    data: {
      ...data,
      click_action: data.click_action || "./jadwal.html",
    },
    webpush: {
      notification: {
        icon: "./assets/icons/icon-192.png",
        badge: "./assets/icons/icon-192.png",
        vibrate: [200, 100, 200],
        requireInteraction: true,
      },
      fcmOptions: {
        link: data.click_action || "./jadwal.html",
      },
    },
  };

  try {
    await messaging.send(message);
    return true;
  } catch (error) {
    const code = error?.code || "";
    // Token is invalid / unregistered – caller should remove it
    if (
      code === "messaging/invalid-registration-token" ||
      code === "messaging/registration-token-not-registered"
    ) {
      console.warn("[fcm] Token invalid, should be removed:", token.slice(0, 20));
      return false;
    }
    console.error("[fcm] sendPush error:", error);
    throw error;
  }
}

/**
 * Send a push notification to multiple tokens (batch).
 * Returns { success: number, failure: number, invalidTokens: string[] }
 */
export async function sendPushBatch(tokens, title, body, data = {}) {
  const results = { success: 0, failure: 0, invalidTokens: [] };
  if (!tokens || tokens.length === 0) return results;

  for (const token of tokens) {
    try {
      const ok = await sendPush(token, title, body, data);
      if (ok) {
        results.success += 1;
      } else {
        results.failure += 1;
        results.invalidTokens.push(token);
      }
    } catch (_) {
      results.failure += 1;
    }
  }

  return results;
}
