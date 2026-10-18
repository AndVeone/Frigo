// Invia ogni giorno a ogni famiglia una notifica con gli alimenti in scadenza.
// Eseguito da GitHub Actions (.github/workflows/notifiche.yml).
import admin from "firebase-admin";

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) { console.error("Manca il secret FIREBASE_SERVICE_ACCOUNT (vedi GUIDA.md, passo 8)."); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
const db = admin.firestore();

let APP_URL = (process.env.APP_URL || "").trim();
if (APP_URL && !APP_URL.endsWith("/")) APP_URL += "/";

// "Oggi" secondo l'ora italiana, in formato AAAA-MM-GG
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome" }).format(new Date());
const dayMs = 86400000;
const daysLeft = iso => Math.round((Date.parse(iso + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / dayMs);
const label = i => i.d < 0 ? `${i.name} (scaduto)` : i.d === 0 ? `${i.name} (oggi)`
  : i.d === 1 ? `${i.name} (domani)` : `${i.name} (tra ${i.d} giorni)`;
const DEAD = new Set(["messaging/registration-token-not-registered", "messaging/invalid-registration-token", "messaging/invalid-argument"]);

let sent = 0;
const households = await db.collection("households").get();
for (const h of households.docs) {
  const alertDays = Number.isFinite(h.get("alertDays")) ? h.get("alertDays") : 3;
  const fridge = await h.ref.collection("fridge").get();
  const items = fridge.docs.map(d => d.data())
    .filter(i => i.expiresAt)
    .map(i => ({ name: i.name, d: daysLeft(i.expiresAt) }))
    .filter(i => i.d <= alertDays)
    .sort((a, b) => a.d - b.d);
  if (!items.length) continue;

  const expired = items.filter(i => i.d < 0).length;
  const soon = items.length - expired;
  const title = expired && soon ? `${soon} in scadenza, ${expired} scadut${expired === 1 ? "o" : "i"}`
    : expired ? (expired === 1 ? "1 alimento scaduto" : `${expired} alimenti scaduti`)
    : (soon === 1 ? "1 alimento in scadenza" : `${soon} alimenti in scadenza`);
  const body = items.slice(0, 6).map(label).join(", ") + (items.length > 6 ? ` e altri ${items.length - 6}` : "");

  const targets = [];
  for (const uid of h.get("members") || []) {
    const u = await db.doc(`users/${uid}`).get();
    for (const t of u.get("tokens") || []) targets.push({ uid, token: t });
  }
  if (!targets.length) continue;

  const webpush = {
    notification: { tag: "frigo-scadenze", renotify: true },
    ...(APP_URL ? { fcmOptions: { link: APP_URL } } : {})
  };
  if (APP_URL) { webpush.notification.icon = APP_URL + "icons/icon-192.png"; webpush.notification.badge = APP_URL + "icons/badge-96.png"; }

  const res = await admin.messaging().sendEachForMulticast({
    tokens: targets.map(t => t.token), notification: { title, body }, webpush
  });
  sent += res.successCount;
  // Pulisce i token di telefoni disinstallati o con notifiche disattivate
  await Promise.all(res.responses.map((r, i) => (!r.success && DEAD.has(r.error?.code))
    ? db.doc(`users/${targets[i].uid}`).update({ tokens: admin.firestore.FieldValue.arrayRemove(targets[i].token) }).catch(() => {})
    : null));
  console.log(`Famiglia ${h.id}: ${items.length} alimenti, ${res.successCount}/${targets.length} notifiche inviate`);
}
console.log(`Fatto (${today}). Notifiche inviate: ${sent}.`);
