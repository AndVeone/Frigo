import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, onSnapshot, arrayUnion }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getMessaging, getToken, isSupported }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";

const $ = s => document.querySelector(s);
const C = window.FRIGO_CONFIG || {};
const SCREENS = ["scrSetup", "scrLoading", "scrLogin", "scrHome", "scrApp"];
const show = id => SCREENS.forEach(s => { $("#" + s).hidden = s !== id; });

const state = { fridge: [], shopping: [], house: { alertDays: 3, memberNames: {}, members: [] }, loc: "all" };
let auth, db, me = null, hid = null, unsubs = [];
let editingId = null, fromShopId = null;

/* ---------------- utilities ---------------- */
const pad = n => String(n).padStart(2, "0");
const toISO = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const today = () => toISO(new Date());
const parse = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (iso, n) => { const d = parse(iso); d.setDate(d.getDate() + n); return toISO(d); };
const daysLeft = iso => iso ? Math.round((parse(iso) - parse(today())) / 86400000) : null;
const fmt = iso => iso ? parse(iso).toLocaleDateString("it-IT", { day: "numeric", month: "short" }) : "";
const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
const ls = {
  get: k => { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (_) {} }
};

function el(tag, attrs, ...kids){
  const n = document.createElement(tag);
  for (const k in (attrs || {})){
    if (k === "class") n.className = attrs[k];
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), attrs[k]);
    else n.setAttribute(k, attrs[k]);
  }
  for (const c of kids) if (c != null) n.append(c);
  return n;
}

let toastTimer;
function toast(msg){
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

async function safe(fn){
  try { await fn(); }
  catch (e){
    console.error(e);
    toast(e && e.code === "permission-denied" ? "Non hai i permessi per questa modifica." : "Modifica non salvata, riprova.");
  }
}

const col = name => collection(db, "households", hid, name);
const myName = () => (me && state.house.memberNames && state.house.memberNames[me.uid]) || "";
const who = uid => (me && uid === me.uid) ? "te" : ((state.house.memberNames || {})[uid] || "");

/* ---------------- boot ---------------- */
const configured = C.firebase && C.firebase.apiKey && !String(C.firebase.apiKey).startsWith("INCOLLA");
if (!configured){
  show("scrSetup");
} else {
  const app = initializeApp(C.firebase);
  auth = getAuth(app);
  auth.languageCode = "it";
  try {
    db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  } catch (_) {
    db = initializeFirestore(app, {});
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(console.error);
  onAuthStateChanged(auth, onUser);
}

async function onUser(u){
  stopSubs(); me = u; hid = null;
  if (!u){ show("scrLogin"); return; }
  show("scrLoading");
  try {
    const s = await getDoc(doc(db, "users", u.uid));
    hid = s.exists() ? (s.data().household || null) : null;
  } catch (e){ console.error(e); hid = null; }
  if (hid) startHousehold(); else openHome();
}

function stopSubs(){ unsubs.forEach(f => f()); unsubs = []; }

/* ---------------- login ---------------- */
const authMsg = code => ({
  "auth/invalid-credential": "Email o password errate.",
  "auth/wrong-password": "Email o password errate.",
  "auth/user-not-found": "Nessun account con questa email: usa Crea account.",
  "auth/email-already-in-use": "Esiste già un account con questa email: usa Entra.",
  "auth/weak-password": "La password deve avere almeno 6 caratteri.",
  "auth/invalid-email": "L’email non è valida.",
  "auth/unauthorized-domain": "Questo indirizzo non è autorizzato in Firebase: segui il passo 7 della guida.",
  "auth/operation-not-allowed": "Questo metodo di accesso non è attivo in Firebase: segui il passo 3 della guida.",
  "auth/network-request-failed": "Nessuna connessione. Riprova quando sei online.",
  "auth/popup-blocked": "Il browser ha bloccato la finestra di accesso: consenti i popup e riprova."
}[code] || "Accesso non riuscito, riprova.");

function loginError(e){
  if (e && (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request")) return;
  const p = $("#loginErr"); p.textContent = authMsg(e && e.code); p.hidden = false;
}

$("#googleBtn").addEventListener("click", () => {
  $("#loginErr").hidden = true;
  signInWithPopup(auth, new GoogleAuthProvider()).catch(loginError);
});
let emailMode = "in";
document.querySelectorAll("#emailForm [data-mode]").forEach(b => b.addEventListener("click", () => { emailMode = b.dataset.mode; }));
$("#emailForm").addEventListener("submit", e => {
  e.preventDefault(); $("#loginErr").hidden = true;
  const f = e.target, email = f.email.value.trim(), pw = f.password.value;
  (emailMode === "up" ? createUserWithEmailAndPassword(auth, email, pw) : signInWithEmailAndPassword(auth, email, pw)).catch(loginError);
});

/* ---------------- household (create / join) ---------------- */
function openHome(msg){
  show("scrHome");
  const n = $("#myName");
  if (!n.value) n.value = (me.displayName || "").split(" ")[0] || ls.get("frigo.name") || "";
  const err = $("#homeErr"); err.textContent = msg || ""; err.hidden = !msg;
}
function homeError(msg){ const err = $("#homeErr"); err.textContent = msg; err.hidden = false; }
function nameOrAsk(){
  const n = $("#myName").value.trim();
  if (!n){ homeError("Scrivi prima il tuo nome, così la famiglia sa chi ha aggiunto cosa."); $("#myName").focus(); return null; }
  ls.set("frigo.name", n); return n;
}
function newCode(){
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", b = new Uint32Array(10);
  crypto.getRandomValues(b); return Array.from(b, x => A[x % A.length]).join("");
}

$("#createForm").addEventListener("submit", async e => {
  e.preventDefault();
  const name = nameOrAsk(); if (!name) return;
  const code = newCode();
  try {
    await setDoc(doc(db, "households", code), {
      name: $("#houseNameIn").value.trim() || "Frigo di casa",
      members: [me.uid], memberNames: { [me.uid]: name },
      createdBy: me.uid, alertDays: 3, createdAt: Date.now()
    });
    await setDoc(doc(db, "users", me.uid), { household: code }, { merge: true });
    hid = code; startHousehold();
    setTimeout(() => { openSettings(); toast("Condividi il codice invito con la famiglia."); }, 400);
  } catch (err){ console.error(err); homeError("Non sono riuscito a creare la famiglia. Controlla le regole di Firestore (passo 4 della guida)."); }
});

$("#joinForm").addEventListener("submit", async e => {
  e.preventDefault();
  const name = nameOrAsk(); if (!name) return;
  const code = $("#joinCode").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length < 6){ homeError("Il codice invito è di 10 caratteri."); return; }
  try {
    await updateDoc(doc(db, "households", code), { members: arrayUnion(me.uid), ["memberNames." + me.uid]: name });
    await setDoc(doc(db, "users", me.uid), { household: code }, { merge: true });
    hid = code; startHousehold();
  } catch (err){
    console.error(err);
    homeError(err.code === "unavailable" ? "Serve la connessione per entrare in una famiglia." : "Codice non valido. Controlla di averlo scritto giusto.");
  }
});

$("#logoutHome").addEventListener("click", () => signOut(auth));

/* ---------------- live data ---------------- */
function startHousehold(){
  show("scrApp");
  const lost = err => {
    console.error(err);
    if (err.code === "permission-denied"){ stopSubs(); hid = null; openHome("Non fai più parte di questa famiglia. Entra con un nuovo codice."); }
  };
  unsubs.push(onSnapshot(doc(db, "households", hid), s => {
    if (!s.exists()){ return; }
    state.house = Object.assign({ alertDays: 3, memberNames: {}, members: [] }, s.data());
    $("#houseName").textContent = state.house.name || "Frigo di casa";
    renderAll(); renderSettings();
  }, lost));
  unsubs.push(onSnapshot(col("fridge"), s => { state.fridge = s.docs.map(d => ({ id: d.id, ...d.data() })); renderAll(); }, lost));
  unsubs.push(onSnapshot(col("shopping"), s => { state.shopping = s.docs.map(d => ({ id: d.id, ...d.data() })); renderAll(); }, lost));
  maybeHintNotifications();
}

/* ---------------- render ---------------- */
function status(item){
  const d = daysLeft(item.expiresAt), ad = state.house.alertDays ?? 3;
  if (d === null) return { cls: "none", label: "Senza scadenza", d };
  if (d < 0) return { cls: "bad", label: d === -1 ? "Scaduto ieri" : "Scaduto da " + (-d) + " giorni", d };
  if (d === 0) return { cls: "bad", label: "Scade oggi", d };
  if (d <= ad) return { cls: "soon", label: d === 1 ? "Scade domani" : "Tra " + d + " giorni", d };
  return { cls: "fresh", label: "Tra " + d + " giorni", d };
}
const urgentItems = () => state.fridge.map(i => ({ i, s: status(i) }))
  .filter(x => x.s.cls === "bad" || x.s.cls === "soon").sort((a, b) => a.s.d - b.s.d);

function renderAll(){ renderSummary(); renderAlerts(); renderFridge(); renderShop(); }

function renderSummary(){
  const n = state.fridge.length, s = state.shopping.filter(x => !x.done).length;
  $("#summary").textContent = n === 0 && s === 0 ? "Frigo e lista della spesa condivisi con la famiglia."
    : n + (n === 1 ? " alimento in casa" : " alimenti in casa") + ", " + s + (s === 1 ? " cosa da comprare" : " cose da comprare");
  const b = $("#badgeSpesa"); b.textContent = s; b.hidden = s === 0;
}

function renderAlerts(){
  const u = urgentItems(), box = $("#alerts");
  const badge = $("#badgeFrigo"); badge.textContent = u.length; badge.hidden = u.length === 0;
  if (!u.length){ box.hidden = true; return; }
  const expired = u.filter(x => x.s.d < 0).length;
  box.hidden = false; box.classList.toggle("bad", u.some(x => x.s.cls === "bad"));
  $("#alertsTitle").textContent = expired
    ? (expired === 1 ? "1 alimento è scaduto" : expired + " alimenti sono scaduti") + (u.length > expired ? ", altri " + (u.length - expired) + " scadono a breve" : "")
    : (u.length === 1 ? "1 alimento scade a breve" : u.length + " alimenti scadono a breve");
  $("#alertsList").replaceChildren(...u.map(x => el("li", null, x.i.name + " · " + x.s.label.toLowerCase())));
}

function renderFridge(){
  const key = i => i.expiresAt || "9999-99-99";
  const items = state.fridge.filter(i => state.loc === "all" || i.location === state.loc)
    .sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : String(a.name).localeCompare(String(b.name)));
  const ul = $("#fridgeList");
  if (!items.length){
    ul.replaceChildren(el("li", { class: "empty" }, el("strong", null, state.fridge.length ? "Niente qui" : "Il frigo è vuoto"),
      "Aggiungi quello che metti in frigo, con la data di scadenza."));
    return;
  }
  ul.replaceChildren(...items.map(i => {
    const s = status(i), w = who(i.addedBy);
    const meta = [i.qty, i.location !== "frigo" ? cap(i.location) : null, "entrato " + fmt(i.addedAt),
      i.expiresAt ? "scade " + fmt(i.expiresAt) : null, w ? "da " + w : null].filter(Boolean).join(" · ");
    return el("li", { class: "item " + s.cls },
      el("span", { class: "stripe", "aria-hidden": "true" }),
      el("div", null,
        el("div", { class: "name" }, String(i.name) + " ", el("span", { class: "pill" }, s.label)),
        el("div", { class: "meta" }, meta),
        el("div", { class: "actions" },
          el("button", { class: "btn ghost small", onclick: () => consume(i, false) }, "Finito"),
          el("button", { class: "btn ghost small", onclick: () => consume(i, true) }, "Ricompra"),
          el("button", { class: "btn ghost small", onclick: () => openFridge(i) }, "Modifica"))));
  }));
}

function renderShop(){
  const open = state.shopping.filter(x => !x.done).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const done = state.shopping.filter(x => x.done);
  const row = x => {
    const w = who(x.addedBy);
    const cb = el("input", { type: "checkbox", "aria-label": "Comprato: " + x.name });
    cb.checked = !!x.done;
    cb.addEventListener("change", () => safe(() => updateDoc(doc(col("shopping"), x.id), { done: cb.checked })));
    return el("li", { class: "shop" + (x.done ? " done" : "") }, cb,
      el("div", { class: "txt" }, el("div", { class: "name" }, String(x.name)), w ? el("div", { class: "meta" }, "aggiunto da " + w) : null),
      x.done ? el("button", { class: "btn small", onclick: () => { fromShopId = x.id; openFridge(null, x.name); } }, "Metti in frigo")
        : el("button", { class: "btn ghost small", "aria-label": "Togli " + x.name, onclick: () => safe(() => deleteDoc(doc(col("shopping"), x.id))) }, "Togli"));
  };
  $("#shopList").replaceChildren(...(open.length ? open.map(row)
    : [el("li", { class: "empty" }, el("strong", null, "Lista vuota"), "Scrivi qui sopra cosa manca: tutti in famiglia lo vedono subito.")]));
  $("#doneList").replaceChildren(...done.map(row));
  $("#doneTitle").hidden = !done.length; $("#doneBar").hidden = !done.length;
}

/* ---------------- fridge actions ---------------- */
function openFridge(item, prefill){
  editingId = item ? item.id : null;
  const f = $("#fridgeForm");
  $("#fridgeDialogTitle").textContent = item ? "Modifica alimento" : "Aggiungi alimento";
  f.name.value = item ? item.name : (prefill || "");
  f.qty.value = item ? (item.qty || "") : "";
  f.location.value = item ? (item.location || "frigo") : (state.loc === "all" ? "frigo" : state.loc);
  f.addedAt.value = item ? (item.addedAt || today()) : today();
  f.expiresAt.value = item ? (item.expiresAt || "") : "";
  $("#fridgeDialog").showModal();
  setTimeout(() => (prefill ? f.expiresAt : f.name).focus(), 50);
}

$("#fridgeForm").addEventListener("submit", e => {
  e.preventDefault();
  const f = e.target;
  const data = { name: f.name.value.trim(), qty: f.qty.value.trim(), location: f.location.value,
    addedAt: f.addedAt.value || today(), expiresAt: f.expiresAt.value || "" };
  if (!data.name) return;
  const id = editingId, shopId = fromShopId;
  editingId = null; fromShopId = null;
  $("#fridgeDialog").close();
  // Con la cache offline le scritture vengono applicate subito e sincronizzate dopo
  safe(async () => {
    if (id) await updateDoc(doc(col("fridge"), id), data);
    else {
      await addDoc(col("fridge"), { ...data, addedBy: me.uid, createdAt: Date.now() });
      if (shopId) await deleteDoc(doc(col("shopping"), shopId));
    }
  });
});
$("#cancelFridge").addEventListener("click", () => { fromShopId = null; editingId = null; $("#fridgeDialog").close(); });
document.querySelectorAll("[data-plus]").forEach(b => b.addEventListener("click", () => {
  const f = $("#fridgeForm"); f.expiresAt.value = addDays(f.addedAt.value || today(), Number(b.dataset.plus));
}));
$("#addFridgeBtn").addEventListener("click", () => openFridge(null));

function addToShopping(name){
  if (state.shopping.some(s => !s.done && String(s.name).toLowerCase() === name.toLowerCase())) return Promise.resolve();
  return addDoc(col("shopping"), { name, done: false, addedBy: me.uid, createdAt: Date.now() });
}
function consume(i, rebuy){
  safe(async () => {
    await deleteDoc(doc(col("fridge"), i.id));
    if (rebuy){ await addToShopping(i.name); toast(i.name + " aggiunto alla spesa"); }
  });
}

/* ---------------- shopping actions ---------------- */
$("#shopForm").addEventListener("submit", e => {
  e.preventDefault();
  const inp = $("#shopName"), names = inp.value.split(",").map(s => s.trim()).filter(Boolean);
  if (!names.length) return;
  inp.value = "";
  safe(async () => { for (const n of names) await addToShopping(n); });
});
$("#clearDone").addEventListener("click", () => safe(async () => {
  for (const x of state.shopping.filter(s => s.done)) await deleteDoc(doc(col("shopping"), x.id));
}));

/* ---------------- tabs & filters ---------------- */
document.querySelectorAll("nav.tabs button").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll("nav.tabs button").forEach(x => x.setAttribute("aria-selected", x === b));
  ["frigo", "spesa", "ricette"].forEach(t => { $("#tab-" + t).hidden = t !== b.dataset.tab; });
  if (b.dataset.tab === "ricette") renderRecipeGate();
  window.scrollTo(0, 0);
}));
document.querySelectorAll("#locFilter button").forEach(b => b.addEventListener("click", () => {
  state.loc = b.dataset.loc;
  document.querySelectorAll("#locFilter button").forEach(x => x.setAttribute("aria-pressed", x === b));
  renderFridge();
}));

/* ---------------- settings ---------------- */
function renderSettings(){
  $("#inviteCode").textContent = hid || "";
  const names = (state.house.members || []).map(uid => who(uid)).filter(Boolean);
  $("#membersLine").textContent = names.length ? "In famiglia: " + names.join(", ") : "";
  if (document.activeElement !== $("#alertDays")) $("#alertDays").value = state.house.alertDays ?? 3;
}
function openSettings(){
  renderSettings(); renderNotifStatus();
  $("#apiKey").value = ls.get("frigo.anthropicKey") || "";
  $("#settingsDialog").showModal();
}
$("#settingsBtn").addEventListener("click", openSettings);
$("#closeSettings").addEventListener("click", () => {
  const k = $("#apiKey").value.trim(); ls.set("frigo.anthropicKey", k || null);
  $("#settingsDialog").close(); renderRecipeGate();
});
$("#logoutBtn").addEventListener("click", () => { $("#settingsDialog").close(); stopSubs(); signOut(auth); });
$("#shareCode").addEventListener("click", async () => {
  const text = "Entra nella nostra lista del frigo! Apri " + location.href.split("#")[0] + " e usa il codice invito " + hid;
  try {
    if (navigator.share) await navigator.share({ title: "Frigo di casa", text });
    else { await navigator.clipboard.writeText(text); toast("Messaggio copiato: incollalo su WhatsApp."); }
  } catch (_) {}
});
let adTimer;
$("#alertDays").addEventListener("input", e => {
  const v = Math.max(0, Math.min(30, Number(e.target.value) || 0));
  clearTimeout(adTimer);
  adTimer = setTimeout(() => { if (v !== state.house.alertDays) safe(() => updateDoc(doc(db, "households", hid), { alertDays: v })); }, 600);
});

/* ---------------- notifications ---------------- */
function renderNotifStatus(){
  const s = $("#notifStatus"), b = $("#notifBtn");
  if (!("Notification" in window)){ s.textContent = "Questo browser non supporta le notifiche. Installa l’app da Chrome."; b.disabled = true; return; }
  if (Notification.permission === "denied"){ s.textContent = "Notifiche bloccate: riattivale dalle impostazioni di Android per questa app."; b.disabled = true; return; }
  const on = Notification.permission === "granted" && ls.get("frigo.pushToken");
  b.disabled = false;
  b.textContent = on ? "Aggiorna notifiche su questo telefono" : "Attiva notifiche su questo telefono";
  s.textContent = on ? "Attive: ricevi ogni mattina il riepilogo delle scadenze." : "Ogni mattina un riepilogo di cosa sta per scadere.";
}
async function enableNotifications(){
  const s = $("#notifStatus");
  try {
    if (!C.vapidKey || String(C.vapidKey).startsWith("INCOLLA")){ s.textContent = "Manca la vapidKey in config.js (passo 5 della guida)."; return; }
    if (!(await isSupported())){ s.textContent = "Notifiche non supportate qui. Installa l’app da Chrome su Android."; return; }
    const perm = await Notification.requestPermission();
    if (perm !== "granted"){ renderNotifStatus(); return; }
    s.textContent = "Attivazione…";
    const reg = await navigator.serviceWorker.ready;
    const token = await getToken(getMessaging(), { vapidKey: C.vapidKey, serviceWorkerRegistration: reg });
    if (!token) throw new Error("no token");
    await setDoc(doc(db, "users", me.uid), { tokens: arrayUnion(token) }, { merge: true });
    ls.set("frigo.pushToken", token);
    $("#notifHint").hidden = true;
    renderNotifStatus(); toast("Notifiche attive su questo telefono.");
  } catch (e){
    console.error(e);
    s.textContent = "Attivazione non riuscita. Controlla la vapidKey e riprova.";
  }
}
$("#notifBtn").addEventListener("click", enableNotifications);
function maybeHintNotifications(){
  const h = $("#notifHint");
  const need = "Notification" in window && Notification.permission !== "denied" && !(Notification.permission === "granted" && ls.get("frigo.pushToken"));
  if (!need){ h.hidden = true; return; }
  h.replaceChildren("Vuoi un avviso ogni mattina con gli alimenti in scadenza? ",
    el("button", { class: "btn small", style: "margin-left:6px", onclick: enableNotifications }, "Attiva notifiche"));
  h.hidden = false;
}

/* ---------------- recipes ---------------- */
function renderRecipeGate(){
  const has = !!ls.get("frigo.anthropicKey");
  $("#noKey").hidden = has; $("#recipeBar").hidden = !has;
}
$("#openKeySettings").addEventListener("click", () => { openSettings(); setTimeout(() => $("#apiKey").focus(), 100); });

let ctl = null;
$("#stopBtn").addEventListener("click", () => ctl && ctl.abort());
$("#suggestBtn").addEventListener("click", async () => {
  const rs = $("#recipeStatus"), out = $("#recipes"), key = ls.get("frigo.anthropicKey");
  if (!key){ renderRecipeGate(); return; }
  if (!state.fridge.length){ rs.hidden = false; rs.textContent = "Aggiungi qualche alimento, poi chiedi le ricette."; return; }
  if (!navigator.onLine){ rs.hidden = false; rs.textContent = "Per le ricette serve la connessione."; return; }
  const inv = state.fridge.map(i => {
    const d = daysLeft(i.expiresAt);
    return "- " + i.name + (i.qty ? " (" + i.qty + ")" : "") + " [" + i.location + "]" + (d === null ? "" : d < 0 ? " SCADUTO" : " scade tra " + d + " giorni");
  }).join("\n");
  const prompt = "Sei un cuoco di casa italiano. Ecco cosa c’è in casa:\n" + inv +
    "\n\nProponi 3 ricette (" + $("#mealType").value + ") che usino soprattutto questi ingredienti, dando priorità a quelli che scadono prima. " +
    "Non usare ingredienti segnati SCADUTO. Dai per scontati sale, olio, pepe e acqua. " +
    "Rispondi SOLO con un array JSON, senza testo prima o dopo, di 3 oggetti con questa forma: " +
    '[{"title":"...","minutes":20,"uses":["ingredienti presenti usati, con lo stesso nome dell\'elenco"],"missing":["ingredienti da comprare, al massimo 3"],"steps":["passo breve"]}]. ' +
    "Massimo 6 passi per ricetta. Testi in italiano.";
  ctl = new AbortController();
  $("#suggestBtn").disabled = true; $("#stopBtn").hidden = false;
  rs.hidden = false; rs.textContent = "Sto pensando a cosa puoi cucinare…"; out.replaceChildren();
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: ctl.signal,
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify({ model: C.recipeModel || "claude-haiku-5-5", max_tokens: 2000, messages: [{ role: "user", content: prompt }] })
    });
    if (!res.ok) throw { status: res.status };
    const data = await res.json();
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const a = text.indexOf("["), z = text.lastIndexOf("]");
    const recipes = JSON.parse(text.slice(a, z + 1));
    if (!Array.isArray(recipes) || !recipes.length) throw { parse: true };
    rs.hidden = true;
    const urgent = new Set(urgentItems().map(x => String(x.i.name).toLowerCase()));
    out.replaceChildren(...recipes.map(r => {
      const uses = (r.uses || []).map(String), miss = (r.missing || []).map(String);
      return el("article", { class: "recipe" },
        el("h3", null, String(r.title || "Ricetta")),
        el("div", { class: "meta" }, r.minutes ? r.minutes + " minuti" : ""),
        el("div", { class: "chips" },
          ...uses.map(u => el("span", { class: "chip" + (urgent.has(u.toLowerCase()) ? " urgent" : "") }, u)),
          ...miss.map(m => el("span", { class: "chip miss" }, "da comprare: " + m))),
        el("ol", null, ...(r.steps || []).map(s => el("li", null, String(s)))),
        miss.length ? el("div", { class: "bar", style: "margin:12px 0 0" }, el("button", { class: "btn ghost small", onclick: ev => {
          ev.target.disabled = true; ev.target.textContent = "Aggiunti alla spesa";
          safe(async () => { for (const m of miss) await addToShopping(m); });
        } }, "Aggiungi i mancanti alla spesa")) : null);
    }));
  } catch (e){
    if (e && e.name === "AbortError"){ rs.hidden = true; }
    else {
      rs.hidden = false;
      rs.textContent = e && e.status === 401 ? "La chiave API non è valida: controllala nelle impostazioni."
        : e && e.status === 429 ? "Troppe richieste ravvicinate: riprova tra un minuto."
        : e && (e.status === 400 || e.status === 404) ? "Richiesta rifiutata: controlla il nome del modello in config.js o il credito del tuo account Anthropic."
        : e && (e.parse || e instanceof SyntaxError) ? "La risposta non era leggibile. Premi di nuovo Suggerisci ricette."
        : "Suggerimenti non disponibili in questo momento. Riprova più tardi.";
    }
  } finally { $("#suggestBtn").disabled = false; $("#stopBtn").hidden = true; }
});

/* ---------------- misc ---------------- */
const net = () => { $("#offline").hidden = navigator.onLine; };
window.addEventListener("online", net); window.addEventListener("offline", net); net();
let lastDay = today();
setInterval(() => { if (today() !== lastDay){ lastDay = today(); renderAll(); } }, 60000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && hid) renderAll(); });
