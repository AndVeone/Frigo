// Frigo di casa — versione 2
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, onSnapshot, arrayUnion,
  query, where, getDocs, writeBatch, increment }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getMessaging, getToken, isSupported }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";

/* =========================================================
   Costanti e utilità
   ========================================================= */
const $ = s => document.querySelector(s);
const C = window.FRIGO_CONFIG || {};
const CAT = window.FRIGO_CATALOG || { categories: [], products: [] };
const SCREENS = ["scrSetup", "scrLoading", "scrLogin", "scrHome", "scrApp"];
const show = id => SCREENS.forEach(s => { $("#" + s).hidden = s !== id; });

const LOCS = {
  frigo:    { label: "Frigo",    icon: "🧊" },
  freezer:  { label: "Freezer",  icon: "❄️" },
  dispensa: { label: "Dispensa", icon: "🥫" },
  utility:  { label: "Utility",  icon: "🧽" }
};
const LOC_ORDER = ["frigo", "freezer", "dispensa", "utility"];
const UNITS = ["pz", "conf", "kg", "l"];
const MEALS = [
  { id: "colazione", label: "Colazione", icon: "☕" },
  { id: "pranzo",    label: "Pranzo",    icon: "🍝" },
  { id: "spuntino",  label: "Spuntino",  icon: "🍎" },
  { id: "cena",      label: "Cena",      icon: "🍽️" }
];
const COLORS = ["#2D7FA6", "#C2185B", "#7A5BA8", "#2F7D4F", "#D97706", "#5B6CC9", "#A0702A", "#0F766E"];
const FREEZER_DAYS = 90;
const DEFAULT_OPEN_DAYS = 3;

const pad = n => String(n).padStart(2, "0");
const toISO = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const today = () => toISO(new Date());
const parseD = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (iso, n) => { const d = parseD(iso); d.setDate(d.getDate() + n); return toISO(d); };
const daysLeft = iso => iso ? Math.round((parseD(iso) - parseD(today())) / 86400000) : null;
const diffDays = (a, b) => Math.round((parseD(b) - parseD(a)) / 86400000);
const dShort = iso => { if (!iso) return "—"; const [y, m, d] = iso.split("-"); return d + "/" + m + "/" + y.slice(2); };
const round2 = x => Math.round(x * 100) / 100;
const num = x => (Math.round(x * 100) / 100).toLocaleString("it-IT", { maximumFractionDigits: 2 });
const eur = v => (v || 0).toLocaleString("it-IT", { style: "currency", currency: "EUR" });
const stepOf = u => (u === "kg" || u === "l") ? 0.25 : 1;
const fmtQty = (q, u) => num(q) + " " + (u || "pz");
const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const stemW = w => w.length > 3 ? w.replace(/(he|hi|e|i|a|o)$/, "") : w;
const stem = s => norm(s).split(" ").map(stemW).join(" ");
const slug = s => norm(s).replace(/ /g, "-").slice(0, 60) || "prodotto";
const ls = {
  get: k => { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (_) {} }
};
const dayLabel = iso => {
  const d = daysLeft(iso);
  if (d === 0) return "Oggi"; if (d === -1) return "Ieri";
  return cap(parseD(iso).toLocaleDateString("it-IT", { weekday: "long" })) + " " + dShort(iso);
};
const defaultMeal = () => { const h = new Date().getHours(); return h < 11 ? "colazione" : h < 15 ? "pranzo" : h < 18 ? "spuntino" : "cena"; };

function el(tag, attrs, ...kids){
  const n = document.createElement(tag);
  for (const k in (attrs || {})){
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "style") n.setAttribute("style", v);
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "pressed") n.setAttribute("aria-pressed", v ? "true" : "false");
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c);
  return n;
}

let toastTimer;
function toast(msg){
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}
async function safe(fn){
  try { return await fn(); }
  catch (e){
    console.error(e);
    toast(e && e.code === "permission-denied" ? "Non hai i permessi per questa modifica: hai ripubblicato le regole di Firestore?" : "Modifica non salvata, riprova.");
  }
}

/* =========================================================
   Stato e Firebase
   ========================================================= */
const state = {
  fridge: [], shopping: [], meals: [], catalogDocs: {},
  house: { alertDays: 3, memberNames: {}, members: [], extraPeople: [] },
  loc: "all", tab: "casa", period: "week"
};
let auth, db, me = null, hid = null, unsubs = [];
const migrated = new Set();
const col = name => collection(db, "households", hid, name);

/* ---------- Catalogo ---------- */
const BUILTIN = CAT.products.map(r => ({
  id: "b-" + slug(r[0]), name: r[0], emoji: r[1], cat: r[2], unit: r[3],
  days: r[4], loc: r[5], openDays: r[6] ?? null, price: null, uses: 0, builtin: true
}));
const BUILTIN_IDS = new Set(BUILTIN.map(p => p.id));
const catById = id => CAT.categories.find(c => c.id === id) || { id: "altro", name: "Altro", emoji: "🛒" };

function products(){
  const over = state.catalogDocs;
  const list = BUILTIN.map(p => over[p.id] ? { ...p, ...over[p.id], id: p.id, builtin: true } : p);
  for (const id in over) if (!BUILTIN_IDS.has(id)) list.push({ unit: "pz", loc: "frigo", days: null, cat: "altro", emoji: "🛒", uses: 0, ...over[id], id });
  return list.filter(p => !p.hidden);
}
function productById(id){ return id ? products().find(p => p.id === id) : null; }
function findProduct(name){
  const q = norm(name), qs = stem(name);
  if (!q) return null;
  const all = products();
  let best = null, score = 0;
  for (const p of all){
    const n = norm(p.name), s = stem(p.name);
    let sc = 0;
    if (n === q) sc = 100;
    else if (s === qs) sc = 90;
    else if ((" " + s + " ").includes(" " + qs + " ")) sc = 50 - s.length / 10;
    else if ((" " + qs + " ").includes(" " + s + " ")) sc = 40 + s.length / 10;
    if (sc > 0) sc += Math.min(9, (p.uses || 0)) / 10;
    if (sc > score){ score = sc; best = p; }
  }
  return best;
}
const emojiOf = it => it.emoji || (findProduct(it.name) || {}).emoji || "🛒";

function learnOp(p, { days, price, use = true } = {}){
  const id = (p.productId && (BUILTIN_IDS.has(p.productId) || p.productId.startsWith("c-"))) ? p.productId : "c-" + slug(p.name);
  const data = { name: p.name, emoji: p.emoji || "🛒", cat: p.cat || "altro", unit: p.unit || "pz", loc: p.loc || "frigo" };
  if (days !== undefined) data.days = days;
  if (price != null && price > 0) data.price = price;
  if (use) data.uses = increment(1);
  return { ref: doc(col("catalog"), id), data, id };
}

/* ---------- Persone ---------- */
function people(){
  const h = state.house, out = [];
  (h.members || []).forEach(uid => out.push({ id: uid, name: (h.memberNames || {})[uid] || "Membro", account: true }));
  (h.extraPeople || []).forEach(p => out.push({ ...p, account: false }));
  return out.map((p, i) => ({ ...p, color: p.color || COLORS[i % COLORS.length] }));
}
const personName = id => (people().find(p => p.id === id) || {}).name || "";

/* =========================================================
   Avvio, accesso, famiglia
   ========================================================= */
const configured = C.firebase && C.firebase.apiKey && !String(C.firebase.apiKey).startsWith("INCOLLA");
if (!configured) show("scrSetup");
else {
  const app = initializeApp(C.firebase);
  auth = getAuth(app); auth.languageCode = "it";
  try { db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
  catch (_) { db = initializeFirestore(app, {}); }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(console.error);
  onAuthStateChanged(auth, onUser);
}

async function onUser(u){
  stopSubs(); me = u; hid = null;
  if (!u){ show("scrLogin"); return; }
  show("scrLoading");
  try { const s = await getDoc(doc(db, "users", u.uid)); hid = s.exists() ? (s.data().household || null) : null; }
  catch (e){ console.error(e); }
  if (hid) startHousehold(); else openHome();
}
function stopSubs(){ unsubs.forEach(f => f()); unsubs = []; }

const authMsg = code => ({
  "auth/invalid-credential": "Email o password errate.", "auth/wrong-password": "Email o password errate.",
  "auth/user-not-found": "Nessun account con questa email: usa Crea account.",
  "auth/email-already-in-use": "Esiste già un account con questa email: usa Entra.",
  "auth/weak-password": "La password deve avere almeno 6 caratteri.", "auth/invalid-email": "L’email non è valida.",
  "auth/unauthorized-domain": "Questo indirizzo non è autorizzato in Firebase (passo 7 della guida).",
  "auth/operation-not-allowed": "Metodo di accesso non attivo in Firebase (passo 3 della guida).",
  "auth/network-request-failed": "Nessuna connessione. Riprova quando sei online.",
  "auth/popup-blocked": "Il browser ha bloccato la finestra di accesso: consenti i popup e riprova."
}[code] || "Accesso non riuscito, riprova.");
function loginError(e){
  if (e && (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request")) return;
  const p = $("#loginErr"); p.textContent = authMsg(e && e.code); p.hidden = false;
}
$("#googleBtn").addEventListener("click", () => { $("#loginErr").hidden = true; signInWithPopup(auth, new GoogleAuthProvider()).catch(loginError); });
let emailMode = "in";
document.querySelectorAll("#emailForm [data-mode]").forEach(b => b.addEventListener("click", () => { emailMode = b.dataset.mode; }));
$("#emailForm").addEventListener("submit", e => {
  e.preventDefault(); $("#loginErr").hidden = true;
  const f = e.target, email = f.email.value.trim(), pw = f.password.value;
  (emailMode === "up" ? createUserWithEmailAndPassword(auth, email, pw) : signInWithEmailAndPassword(auth, email, pw)).catch(loginError);
});

function openHome(msg){
  show("scrHome");
  const n = $("#myName");
  if (!n.value) n.value = (me.displayName || "").split(" ")[0] || ls.get("frigo.name") || "";
  const err = $("#homeErr"); err.textContent = msg || ""; err.hidden = !msg;
}
function homeError(msg){ const err = $("#homeErr"); err.textContent = msg; err.hidden = false; }
function nameOrAsk(){
  const n = $("#myName").value.trim();
  if (!n){ homeError("Scrivi prima il tuo nome."); $("#myName").focus(); return null; }
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
    await setDoc(doc(db, "households", code), { name: $("#houseNameIn").value.trim() || "Frigo di casa",
      members: [me.uid], memberNames: { [me.uid]: name }, extraPeople: [], createdBy: me.uid, alertDays: 3, createdAt: Date.now() });
    await setDoc(doc(db, "users", me.uid), { household: code }, { merge: true });
    hid = code; startHousehold();
    setTimeout(() => { openSettings(); toast("Condividi il codice invito con la famiglia."); }, 400);
  } catch (err){ console.error(err); homeError("Non sono riuscito a creare la famiglia. Controlla le regole di Firestore."); }
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
  } catch (err){ console.error(err); homeError(err.code === "unavailable" ? "Serve la connessione per entrare in una famiglia." : "Codice non valido."); }
});
$("#logoutHome").addEventListener("click", () => signOut(auth));

/* =========================================================
   Dati in tempo reale
   ========================================================= */
function startHousehold(){
  show("scrApp");
  const lost = err => {
    console.error(err);
    if (err.code === "permission-denied"){
      if (err.__sub === "house"){ stopSubs(); hid = null; openHome("Non fai più parte di questa famiglia."); }
      else toast("Alcuni dati non sono leggibili: ripubblica le regole di Firestore (vedi AGGIORNAMENTO).");
    }
  };
  const tag = name => e => { e.__sub = name; lost(e); };
  unsubs.push(onSnapshot(doc(db, "households", hid), s => {
    if (!s.exists()) return;
    state.house = Object.assign({ alertDays: 3, memberNames: {}, members: [], extraPeople: [] }, s.data());
    $("#houseName").textContent = state.house.name || "Frigo di casa";
    renderAll(); renderSettings();
  }, tag("house")));
  unsubs.push(onSnapshot(col("fridge"), s => {
    state.fridge = s.docs.map(d => ({ id: d.id, ...d.data() }));
    migrateItems(); renderAll();
  }, tag("fridge")));
  unsubs.push(onSnapshot(col("shopping"), s => { state.shopping = s.docs.map(d => ({ id: d.id, ...d.data() })); renderAll(); }, tag("shopping")));
  unsubs.push(onSnapshot(col("catalog"), s => {
    const m = {}; s.docs.forEach(d => { m[d.id] = d.data(); }); state.catalogDocs = m; renderAll();
  }, tag("catalog")));
  unsubs.push(onSnapshot(query(col("meals"), where("date", ">=", addDays(today(), -45))), s => {
    state.meals = s.docs.map(d => ({ id: d.id, ...d.data() })); renderMeals();
  }, tag("meals")));
  maybeHintNotifications();
}

// Converte gli alimenti della versione 1 (quantità scritta a testo)
function parseQtyText(t, p){
  const s = String(t || "").toLowerCase().replace(",", ".");
  const m = s.match(/(\d+(?:\.\d+)?)\s*(pz|pezzi|pezzo|conf|confezioni|confezione|kg|chili|g|gr|grammi|l|lt|litri|litro|ml|cl)?/);
  if (!m) return { qty: 1, unit: (p && p.unit) || "pz" };
  let q = parseFloat(m[1]), u = m[2] || "";
  if (/^(g|gr|grammi)$/.test(u)){ q = q / 1000; u = "kg"; }
  else if (u === "ml"){ q = q / 1000; u = "l"; }
  else if (u === "cl"){ q = q / 100; u = "l"; }
  else if (/^(kg|chili)$/.test(u)) u = "kg";
  else if (/^(l|lt|litri|litro)$/.test(u)) u = "l";
  else if (/^conf/.test(u)) u = "conf";
  else u = u ? "pz" : ((p && p.unit) || "pz");
  return { qty: round2(q) || 1, unit: u };
}
function migrateItems(){
  for (const it of state.fridge){
    if (typeof it.qty === "number" || migrated.has(it.id)) continue;
    migrated.add(it.id);
    const p = findProduct(it.name);
    const { qty, unit } = parseQtyText(it.qty, p);
    safe(() => updateDoc(doc(col("fridge"), it.id), {
      qty, unit, productId: p ? p.id : null, emoji: p ? p.emoji : "🛒", cat: p ? p.cat : "altro",
      price: it.price ?? null, location: it.location || "frigo", openedAt: it.openedAt || ""
    }));
  }
}
const qtyOf = it => typeof it.qty === "number" ? it.qty : parseQtyText(it.qty).qty;

/* =========================================================
   Render principale
   ========================================================= */
function status(item){
  const d = daysLeft(item.expiresAt), ad = state.house.alertDays ?? 3;
  if (d === null) return { cls: "none", label: "", d };
  if (d < 0) return { cls: "bad", label: d === -1 ? "Scaduto ieri" : "Scaduto da " + (-d) + " gg", d };
  if (d === 0) return { cls: "bad", label: "Scade oggi", d };
  if (d <= ad) return { cls: "soon", label: d === 1 ? "Scade domani" : "Tra " + d + " giorni", d };
  return { cls: "fresh", label: "Tra " + d + " giorni", d };
}
const urgentItems = () => state.fridge.map(i => ({ i, s: status(i) }))
  .filter(x => x.s.cls === "bad" || x.s.cls === "soon").sort((a, b) => a.s.d - b.s.d);

function renderAll(){ renderSummary(); renderAlerts(); renderLocFilter(); renderHome(); renderShop(); }

function renderSummary(){
  const n = state.fridge.length, s = state.shopping.filter(x => !x.done).length;
  $("#summary").textContent = n + (n === 1 ? " prodotto in casa" : " prodotti in casa") + ", " + s + (s === 1 ? " da comprare" : " da comprare");
  const b = $("#badgeSpesa"); b.textContent = s; b.hidden = s === 0;
}
function renderAlerts(){
  const u = urgentItems(), box = $("#alerts");
  const badge = $("#badgeCasa"); badge.textContent = u.length; badge.hidden = u.length === 0;
  if (!u.length){ box.hidden = true; return; }
  const expired = u.filter(x => x.s.d < 0).length;
  box.hidden = false; box.classList.toggle("bad", u.some(x => x.s.cls === "bad"));
  $("#alertsTitle").textContent = expired
    ? (expired === 1 ? "1 prodotto è scaduto" : expired + " prodotti sono scaduti") + (u.length > expired ? ", altri " + (u.length - expired) + " scadono a breve" : "")
    : (u.length === 1 ? "1 prodotto scade a breve" : u.length + " prodotti scadono a breve");
  $("#alertsList").replaceChildren(...u.map(x => el("li", null, emojiOf(x.i) + " " + x.i.name + " · " + x.s.label.toLowerCase())));
}
function renderLocFilter(){
  const counts = {}; state.fridge.forEach(i => { const l = i.location || "frigo"; counts[l] = (counts[l] || 0) + 1; });
  const btn = (id, label) => el("button", { pressed: state.loc === id, onclick: () => { state.loc = id; renderLocFilter(); renderHome(); } }, label);
  $("#locFilter").replaceChildren(btn("all", "Tutto " + state.fridge.length),
    ...LOC_ORDER.map(l => btn(l, LOCS[l].icon + " " + LOCS[l].label + (counts[l] ? " " + counts[l] : ""))));
}
function sortItems(a, b){
  const ka = a.expiresAt || "9999-99-99", kb = b.expiresAt || "9999-99-99";
  return ka < kb ? -1 : ka > kb ? 1 : String(a.name).localeCompare(String(b.name));
}
function itemCard(i){
  const s = status(i), loc = i.location || "frigo", q = qtyOf(i), u = i.unit || "pz";
  const dates = [el("span", null, "IN ", el("b", null, dShort(i.addedAt)))];
  if (i.expiresAt) dates.push(" · ", el("span", null, "SCAD ", el("b", null, dShort(i.expiresAt))));
  if (i.openedAt) dates.push(" · aperto il " + dShort(i.openedAt));
  if (i.price) dates.push(" · " + eur(round2(q * i.price)));
  return el("li", { class: "item " + s.cls },
    el("span", { class: "stripe", "aria-hidden": "true" }),
    el("div", null,
      el("div", { class: "top" },
        el("button", { class: "name", onclick: () => openEdit(i), "aria-label": "Modifica " + i.name }, emojiOf(i) + " " + i.name),
        el("span", { class: "loc " + loc }, LOCS[loc].icon + " " + LOCS[loc].label),
        s.label ? el("span", { class: "pill" }, s.label) : null),
      el("div", { class: "dates" }, dates),
      el("div", { class: "row-actions" },
        el("span", { class: "stepper" },
          el("button", { onclick: () => minusItem(i), "aria-label": "Togli " + num(stepOf(u)) + " " + u }, "−"),
          el("span", { class: "v" }, fmtQty(q, u)),
          el("button", { onclick: () => plusItem(i), "aria-label": "Aggiungi " + num(stepOf(u)) + " " + u }, "+")),
        loc !== "utility" ? el("button", { class: "btn small", onclick: () => openUse(i) }, "Utilizza") : null,
        el("button", { class: "btn ghost small", onclick: () => rebuy(i) }, "Ricompra"))));
}
function renderHome(){
  const box = $("#homeList");
  if (!state.fridge.length){
    box.replaceChildren(el("div", { class: "empty" }, el("strong", null, "La casa è vuota"), "Tocca «Aggiungi» e scegli i prodotti dai pulsanti, oppure dettali con il microfono."));
    return;
  }
  if (state.loc !== "all"){
    const items = state.fridge.filter(i => (i.location || "frigo") === state.loc).sort(sortItems);
    box.replaceChildren(items.length ? el("ul", { class: "list" }, items.map(itemCard))
      : el("div", { class: "empty" }, el("strong", null, "Niente qui"), "Nessun prodotto in " + LOCS[state.loc].label.toLowerCase() + "."));
    return;
  }
  const out = [];
  for (const l of LOC_ORDER){
    const items = state.fridge.filter(i => (i.location || "frigo") === l).sort(sortItems);
    if (!items.length) continue;
    out.push(el("div", { class: "sec" }, LOCS[l].icon + " " + LOCS[l].label, el("span", { class: "n" }, String(items.length))),
      el("ul", { class: "list" }, items.map(itemCard)));
  }
  box.replaceChildren(...out);
}

/* =========================================================
   Movimenti: −, +, finito, ricompra
   ========================================================= */
function eventData(type, item, qty, extra = {}){
  const price = item.price ?? null;
  return { type, name: item.name, productId: item.productId || null, cat: item.cat || "altro",
    qty: round2(qty), unit: item.unit || "pz", price, value: price != null ? round2(qty * price) : null,
    date: today(), ts: Date.now(), by: me ? me.uid : "", ...extra };
}
function minusItem(i){
  const q = qtyOf(i), st = stepOf(i.unit), left = round2(q - st);
  if (left <= 0.0001){
    safe(() => addDoc(col("events"), eventData("use", i, q)));
    finishItems([i]);
  } else {
    safe(async () => { await updateDoc(doc(col("fridge"), i.id), { qty: left }); await addDoc(col("events"), eventData("use", i, st)); });
  }
}
function plusItem(i){ safe(() => updateDoc(doc(col("fridge"), i.id), { qty: round2(qtyOf(i) + stepOf(i.unit)) })); }

function shopHas(name){ const n = norm(name); return state.shopping.some(s => !s.done && norm(s.name) === n); }
function addToShopping(p, { silent } = {}){
  if (shopHas(p.name)){ if (!silent) toast(p.name + " è già in lista"); return Promise.resolve(false); }
  return safe(async () => {
    await addDoc(col("shopping"), { name: p.name, productId: p.productId || p.id || null, emoji: p.emoji || emojiOf(p),
      qty: p.qty ?? null, unit: p.qty != null ? (p.unit || "pz") : null, done: false, addedBy: me.uid, createdAt: Date.now() });
    return true;
  });
}
function rebuy(i){ addToShopping({ name: i.name, productId: i.productId, emoji: emojiOf(i) }).then(ok => { if (ok) toast(i.name + " aggiunto alla spesa"); }); }

// Domanda «finito, lo rimetto in lista?» e cancellazione
function askFinish(items){
  return new Promise(resolve => {
    const dlg = $("#ask"); let done = false;
    const finish = v => { if (done) return; done = true; dlg.close(); resolve(v); };
    if (items.length === 1){
      const it = items[0];
      $("#askBody").replaceChildren(
        el("h2", null, emojiOf(it) + " " + it.name + " è finito"),
        el("p", { class: "muted", style: "margin:0" }, "Lo rimetto in lista della spesa?"),
        el("div", { class: "foot" },
          el("button", { class: "btn ghost", onclick: () => finish([]) }, "No"),
          el("button", { class: "btn", onclick: () => finish([it.id]) }, "Sì, in lista")));
    } else {
      const checks = items.map(it => { const c = el("input", { type: "checkbox" }); c.checked = true; c.dataset.id = it.id; return { it, c }; });
      $("#askBody").replaceChildren(
        el("h2", null, "Prodotti finiti"),
        el("p", { class: "muted", style: "margin:0" }, "Quali rimetto in lista della spesa?"),
        ...checks.map(({ it, c }) => el("label", { class: "check" }, c, el("span", null, emojiOf(it) + " " + it.name))),
        el("div", { class: "foot" }, el("button", { class: "btn", onclick: () => finish(checks.filter(x => x.c.checked).map(x => x.it.id)) }, "Conferma")));
    }
    dlg.addEventListener("close", () => finish([]), { once: true });
    dlg.showModal();
  });
}
async function finishItems(items){
  const again = await askFinish(items);
  await safe(async () => {
    const b = writeBatch(db);
    items.forEach(it => b.delete(doc(col("fridge"), it.id)));
    await b.commit();
  });
  for (const it of items) if (again.includes(it.id)) await addToShopping({ name: it.name, productId: it.productId, emoji: emojiOf(it) }, { silent: true });
  if (again.length) toast(again.length === 1 ? "Rimesso in lista della spesa" : again.length + " prodotti rimessi in lista");
}

/* =========================================================
   Pannelli a tutto schermo
   ========================================================= */
function openSheet(id, title, body, foot){
  $("#" + id + "Title").textContent = title;
  $("#" + id + "Body").replaceChildren(body);
  $("#" + id + "Body").scrollTop = 0;
  $("#" + id + "Foot").replaceChildren(...(foot || []));
  const d = $("#" + id); if (!d.open) d.showModal();
}
function closeSheet(id){ const d = $("#" + id); if (d.open) d.close(); }
document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => closeSheet(b.dataset.close)));

// Piccoli componenti riutilizzabili con aggiornamento mirato
function makeUI(){
  const ups = [];
  const ui = {
    refresh: () => ups.forEach(f => f()),
    opts(list, get, set, cls){
      const box = el("div", { class: "opts" + (cls ? " " + cls : "") });
      list.forEach(o => {
        const b = el("button", { class: "opt", type: "button", onclick: () => { set(o.v); ui.refresh(); } },
          o.icon && cls === "loc4" ? [el("span", null, o.icon), o.label] : (o.icon ? o.icon + " " : "") + o.label);
        box.append(b);
        ups.push(() => b.setAttribute("aria-pressed", String(get() === o.v)));
      });
      return box;
    },
    multi(list, has, toggle){
      const box = el("div", { class: "opts" });
      list.forEach(o => {
        const b = el("button", { class: "opt", type: "button", onclick: () => { toggle(o.v); ui.refresh(); } }, o.label);
        if (o.color) b.prepend(el("span", { class: "dot", style: "background:" + o.color }));
        box.append(b); ups.push(() => b.setAttribute("aria-pressed", String(has(o.v))));
      });
      return box;
    },
    stepper(text, minus, plus, cls = "stepper"){
      const v = el("span", { class: "v" });
      const n = el("span", { class: cls },
        el("button", { type: "button", "aria-label": "Meno", onclick: () => { minus(); ui.refresh(); } }, "−"), v,
        el("button", { type: "button", "aria-label": "Più", onclick: () => { plus(); ui.refresh(); } }, "+"));
      ups.push(() => { v.textContent = text(); });
      return n;
    },
    text(fn, tag = "span", attrs){ const n = el(tag, attrs); ups.push(() => { n.textContent = fn(); }); return n; },
    when(fn, node){ ups.push(() => { node.hidden = !fn(); }); return node; },
    datePicker(get, set){
      const lbl = el("span", { class: "date-big" });
      const inp = el("input", { type: "date", "aria-label": "Scegli dal calendario" });
      inp.addEventListener("change", () => { if (inp.value){ set(inp.value); ui.refresh(); } });
      inp.addEventListener("click", () => { try { inp.showPicker(); } catch (_) {} });
      ups.push(() => { lbl.textContent = get() ? dShort(get()) : "Nessuna"; inp.value = get() || today(); });
      return el("span", { class: "datepick" }, lbl, inp);
    },
    priceInput(get, set){
      const inp = el("input", { type: "text", inputmode: "decimal", class: "price-in", placeholder: "—", "aria-label": "Prezzo per unità in euro" });
      inp.addEventListener("change", () => {
        const v = parseFloat(inp.value.replace(",", ".").replace(/[^\d.]/g, ""));
        set(isFinite(v) && v > 0 ? round2(v) : null); ui.refresh();
      });
      ups.push(() => { if (document.activeElement !== inp) inp.value = get() != null ? get().toFixed(2).replace(".", ",") : ""; });
      return inp;
    }
  };
  return ui;
}
const priceStep = (get, set, dir) => { const v = get(); set(v == null ? (dir > 0 ? 1 : null) : Math.max(0, round2(v + 0.1 * dir)) || null); };

/* =========================================================
   Catalogo a pulsanti (picker)
   ========================================================= */
let picker = null;
function openPicker(mode, opts = {}){
  // mode: "home" (aggiungi in casa), "shop" (aggiungi alla spesa), "replace" (cambia prodotto in modifica)
  const freq = products().filter(p => p.uses > 0);
  picker = { mode, q: "", cat: freq.length ? "freq" : (mode === "shop" ? "latticini" : "latticini"), added: {}, onPick: opts.onPick };
  const sheetId = mode === "replace" ? "sheet2" : "sheet";
  const input = el("input", { type: "search", placeholder: "Cerca o scrivi un prodotto nuovo…", autocomplete: "off", enterkeyhint: "done", "aria-label": "Cerca prodotto" });
  const grid = el("div", { class: "grid" });
  const catsBox = el("div", { class: "chips-row", style: "margin-top:8px" });
  const renderCats = () => {
    const mk = (id, label) => el("button", { class: "qchip", style: picker.cat === id && !picker.q ? "background:var(--accent);color:var(--accent-ink);font-weight:600" : "",
      onclick: () => { picker.cat = id; picker.q = ""; input.value = ""; renderCats(); renderGrid(); } }, label);
    catsBox.replaceChildren(mk("freq", "⭐ Frequenti"), ...CAT.categories.map(c => mk(c.id, c.emoji + " " + c.name)));
  };
  const renderGrid = () => {
    const all = products();
    let list;
    if (picker.q){
      const q = norm(picker.q), qs = stem(picker.q);
      list = all.filter(p => norm(p.name).includes(q) || stem(p.name).includes(qs))
        .sort((a, b) => (b.uses || 0) - (a.uses || 0) || a.name.localeCompare(b.name)).slice(0, 40);
    } else if (picker.cat === "freq"){
      list = all.filter(p => p.uses > 0).sort((a, b) => b.uses - a.uses).slice(0, 30);
    } else {
      list = all.filter(p => p.cat === picker.cat).sort((a, b) => (b.uses || 0) - (a.uses || 0) || a.name.localeCompare(b.name));
    }
    const tiles = list.map(p => {
      const n = picker.added[p.id];
      return el("button", { class: "tile-btn", onclick: () => pick(p) },
        n ? el("span", { class: "badge" }, "+" + n) : null,
        el("span", { class: "e" }, p.emoji), el("span", { class: "t" }, p.name));
    });
    const exact = picker.q && all.some(p => norm(p.name) === norm(picker.q));
    if (picker.q && !exact){
      tiles.unshift(el("button", { class: "tile-btn new", onclick: () => pick(null, cap(picker.q.trim())) },
        el("span", { class: "e" }, "＋"), el("span", { class: "t" }, "Nuovo: " + cap(picker.q.trim()))));
    }
    if (!tiles.length) tiles.push(el("div", { class: "muted", style: "grid-column:1/-1;padding:20px 4px" }, "Ancora nessun prodotto frequente: scegli una categoria qui sopra."));
    grid.replaceChildren(...tiles);
  };
  const pick = (p, newName) => {
    if (mode === "shop"){
      const prod = p || { name: newName, emoji: "🛒", id: null };
      addToShopping({ name: prod.name, productId: prod.id, emoji: prod.emoji }).then(ok => {
        if (ok){ picker.added[prod.id || newName] = (picker.added[prod.id || newName] || 0) + 1; toast(prod.name + " in lista"); renderGrid(); updateFoot(); }
      });
      if (newName){ picker.q = ""; input.value = ""; renderCats(); }
      return;
    }
    const prod = p || { id: null, name: newName, emoji: (catById(picker.cat).emoji) || "🛒", cat: picker.cat !== "freq" ? picker.cat : "altro", unit: "pz", days: 7, loc: "frigo" };
    if (mode === "replace"){ closeSheet("sheet2"); picker.onPick && picker.onPick(prod, !p); return; }
    openDetails(newDraft(prod, !p), "sheet2");
  };
  input.addEventListener("input", () => { picker.q = input.value; renderCats(); renderGrid(); });
  input.addEventListener("keydown", e => { if (e.key === "Enter"){ e.preventDefault(); input.blur(); } });
  renderCats(); renderGrid();
  const doneBtn = el("button", { class: "btn", onclick: () => closeSheet(sheetId) }, "Fatto");
  const updateFoot = () => { const n = Object.values(picker.added).reduce((a, b) => a + b, 0); doneBtn.textContent = n ? "Fatto (" + n + " in lista)" : "Fatto"; };
  const body = el("div", null, el("div", { class: "search" }, input, catsBox), grid);
  openSheet(sheetId, mode === "shop" ? "Aggiungi alla spesa" : mode === "replace" ? "Cambia prodotto" : "Cosa metti in casa?", body,
    mode === "shop" ? [doneBtn] : []);
}

/* =========================================================
   Inserimento e modifica di un prodotto
   ========================================================= */
function newDraft(p, isNewProduct){
  const loc = p.loc || "frigo";
  return { mode: "new", isNewProduct: !!isNewProduct, productId: p.id || null, name: p.name, emoji: p.emoji || "🛒",
    cat: p.cat || "altro", unit: p.unit || "pz", qty: 1, price: p.price ?? null, loc,
    addedAt: today(), expiresAt: p.days != null ? addDays(today(), p.days) : "", openedAt: "", expBeforeOpen: "",
    openDays: p.openDays ?? null };
}
function openEdit(i){
  const p = productById(i.productId) || findProduct(i.name) || {};
  openDetails({ mode: "edit", id: i.id, orig: i, productId: i.productId || p.id || null, name: i.name, emoji: emojiOf(i),
    cat: i.cat || p.cat || "altro", unit: i.unit || "pz", qty: qtyOf(i), price: i.price ?? null, loc: i.location || "frigo",
    addedAt: i.addedAt || today(), expiresAt: i.expiresAt || "", openedAt: i.openedAt || "", expBeforeOpen: i.expBeforeOpen || "",
    openDays: p.openDays ?? null, addedBy: i.addedBy }, "sheet");
}
function openDetails(d, sheetId){
  const ui = makeUI();
  const nameT = ui.text(() => d.name, "span", { class: "n" });
  const emT = ui.text(() => d.emoji, "span", { class: "e" });
  const changeBtn = el("button", { class: "btn ghost small", type: "button", onclick: () => {
    if (sheetId === "sheet2"){ closeSheet("sheet2"); return; }
    openPicker("replace", { onPick: (p, isNew) => {
      Object.assign(d, { productId: p.id || null, name: p.name, emoji: p.emoji || d.emoji, cat: p.cat || d.cat, unit: p.unit || d.unit,
        openDays: p.openDays ?? null, isNewProduct: isNew });
      if (p.price != null && d.price == null) d.price = p.price;
      ui.refresh();
    } });
  } }, "Cambia");

  const blocks = [];
  blocks.push(el("div", { class: "block" }, el("div", { class: "prod-head" }, emT, nameT, changeBtn),
    d.addedBy && d.mode === "edit" ? el("div", { class: "muted small", style: "margin-top:6px" }, "Inserito da " + (personName(d.addedBy) || "—")) : null));

  // Categoria (solo per prodotti nuovi)
  const catBlock = el("div", { class: "block" }, el("div", { class: "lbl" }, "Categoria"),
    ui.opts(CAT.categories.map(c => ({ v: c.id, label: c.emoji + " " + c.name })), () => d.cat, v => {
      d.cat = v; d.emoji = catById(v).emoji;
      if (v === "casa" || v === "igiene"){ d.loc = "utility"; d.expiresAt = ""; }
    }));
  blocks.push(ui.when(() => d.isNewProduct, catBlock));

  // Quantità
  blocks.push(el("div", { class: "block" }, el("div", { class: "lbl" }, "Quantità"),
    el("div", { class: "inline" },
      ui.stepper(() => fmtQty(d.qty, d.unit), () => { d.qty = Math.max(stepOf(d.unit), round2(d.qty - stepOf(d.unit))); }, () => { d.qty = round2(d.qty + stepOf(d.unit)); }),
      ui.opts(UNITS.map(u => ({ v: u, label: u })), () => d.unit, v => { d.unit = v; if (stepOf(v) === 1) d.qty = Math.max(1, Math.round(d.qty)); })),
    ui.when(() => stepOf(d.unit) < 1, el("div", { class: "opts", style: "margin-top:8px" },
      [[0.5, "½"], [1, "1"], [2, "2"]].map(([v, t]) => el("button", { class: "opt", type: "button", onclick: () => { d.qty = v; ui.refresh(); } }, t))))));

  // Prezzo
  blocks.push(el("div", { class: "block" }, el("div", { class: "lbl" }, "Prezzo (facoltativo)"),
    el("div", { class: "inline" },
      el("span", { class: "mini" },
        el("button", { type: "button", onclick: () => { priceStep(() => d.price, v => d.price = v, -1); ui.refresh(); } }, "−"),
        ui.priceInput(() => d.price, v => d.price = v),
        el("button", { type: "button", onclick: () => { priceStep(() => d.price, v => d.price = v, 1); ui.refresh(); } }, "+")),
      ui.text(() => "€ / " + d.unit, "span", { class: "muted" }),
      ui.text(() => d.price ? "Totale " + eur(round2(d.qty * d.price)) : "", "span", { class: "total" }))));

  // Posizione
  blocks.push(el("div", { class: "block" }, el("div", { class: "lbl" }, "Dove"),
    ui.opts(LOC_ORDER.map(l => ({ v: l, label: LOCS[l].label, icon: LOCS[l].icon })), () => d.loc, v => {
      const was = d.loc; d.loc = v;
      if (v === "freezer" && was !== "freezer"){
        const left = daysLeft(d.expiresAt);
        if (left === null || left < FREEZER_DAYS){ d.expiresAt = addDays(today(), FREEZER_DAYS); toast("In freezer: scadenza portata a 3 mesi"); }
      }
    }, "loc4")));

  // Date
  const shortcut = (label, n) => el("button", { class: "opt", type: "button", onclick: () => { d.expiresAt = addDays(today(), n); ui.refresh(); } }, label);
  blocks.push(el("div", { class: "block" },
    el("div", { class: "lbl" }, "Scadenza"),
    el("div", { class: "inline" },
      el("span", { class: "mini" },
        el("button", { type: "button", "aria-label": "Un giorno prima", onclick: () => { if (d.expiresAt){ d.expiresAt = addDays(d.expiresAt, -1); ui.refresh(); } } }, "−"),
        ui.datePicker(() => d.expiresAt, v => d.expiresAt = v),
        el("button", { type: "button", "aria-label": "Un giorno dopo", onclick: () => { d.expiresAt = d.expiresAt ? addDays(d.expiresAt, 1) : addDays(today(), 1); ui.refresh(); } }, "+")),
      ui.text(() => { const n = daysLeft(d.expiresAt); return n === null ? "" : n < 0 ? "scaduto" : n === 0 ? "oggi" : "tra " + n + " gg"; }, "span", { class: "muted" })),
    el("div", { class: "opts", style: "margin-top:8px" }, shortcut("+3 gg", 3), shortcut("+1 sett.", 7), shortcut("+1 mese", 30), shortcut("+3 mesi", 90),
      el("button", { class: "opt", type: "button", onclick: () => { d.expiresAt = ""; ui.refresh(); } }, "Nessuna")),
    el("div", { class: "lbl", style: "margin-top:14px" }, "Entrato il"),
    el("div", { class: "inline" },
      el("span", { class: "mini" },
        el("button", { type: "button", onclick: () => { d.addedAt = addDays(d.addedAt, -1); ui.refresh(); } }, "−"),
        ui.datePicker(() => d.addedAt, v => d.addedAt = v),
        el("button", { type: "button", onclick: () => { if (d.addedAt < today()){ d.addedAt = addDays(d.addedAt, 1); ui.refresh(); } } }, "+")))));

  // Aperto
  const openChk = el("input", { type: "checkbox" });
  openChk.addEventListener("change", () => {
    if (openChk.checked){
      d.openedAt = today(); d.expBeforeOpen = d.expiresAt;
      const lim = addDays(today(), d.openDays ?? DEFAULT_OPEN_DAYS);
      if (!d.expiresAt || d.expiresAt > lim) d.expiresAt = lim;
    } else { d.openedAt = ""; if (d.expBeforeOpen) d.expiresAt = d.expBeforeOpen; d.expBeforeOpen = ""; }
    ui.refresh();
  });
  blocks.push(ui.when(() => d.loc !== "utility", el("div", { class: "block" },
    el("label", { class: "check" }, openChk, ui.text(() => d.openedAt ? "Aperto il " + dShort(d.openedAt) + ": scadenza accorciata" : "Aperto (accorcia la scadenza a " + (d.openDays ?? DEFAULT_OPEN_DAYS) + " giorni)")))));
  const upOpen = () => { openChk.checked = !!d.openedAt; };

  // Buttato / Elimina (solo modifica)
  if (d.mode === "edit"){
    blocks.push(el("div", { class: "block" }, el("div", { class: "lbl" }, "Non c’è più?"),
      el("div", { class: "opts" },
        el("button", { class: "btn danger", type: "button", onclick: () => wasteItem(d) }, "🗑️ Buttato (spreco)"),
        el("button", { class: "btn ghost", type: "button", onclick: () => deleteItem(d) }, "Elimina (inserito per errore)"))));
  }

  const save = el("button", { class: "btn", onclick: () => saveDetails(d, sheetId) }, d.mode === "edit" ? "Salva" : "Metti in casa");
  const cancel = el("button", { class: "btn ghost", onclick: () => closeSheet(sheetId) }, "Annulla");
  openSheet(sheetId, d.mode === "edit" ? "Modifica" : "Nuovo in casa", el("div", null, blocks), [cancel, save]);
  ui.refresh(); upOpen();
}

function saveDetails(d, sheetId){
  if (!d.name) return;
  const data = { name: d.name, productId: d.productId, emoji: d.emoji, cat: d.cat, qty: round2(d.qty), unit: d.unit,
    price: d.price ?? null, location: d.loc, addedAt: d.addedAt, expiresAt: d.expiresAt || "", openedAt: d.openedAt || "", expBeforeOpen: d.expBeforeOpen || "" };
  const days = d.expiresAt && !d.openedAt && d.loc !== "freezer" ? diffDays(d.addedAt, d.expiresAt) : undefined;
  closeSheet(sheetId); if (sheetId === "sheet2") closeSheet("sheet");
  safe(async () => {
    const b = writeBatch(db);
    if (d.mode === "edit"){
      b.update(doc(col("fridge"), d.id), data);
      const known = productById(d.productId);
      const L = learnOp({ ...d, loc: known ? known.loc : d.loc }, { price: d.price, use: false });
      b.set(L.ref, L.data, { merge: true });
      if (!data.productId) b.update(doc(col("fridge"), d.id), { productId: L.id });
    } else {
      const L = learnOp({ ...d }, { days: d.loc === "utility" ? null : days, price: d.price });
      const ref = doc(col("fridge"));
      b.set(ref, { ...data, productId: L.id, addedBy: me.uid, createdAt: Date.now() });
      b.set(doc(col("events")), eventData("in", { ...data, productId: L.id }, data.qty));
      b.set(L.ref, L.data, { merge: true });
    }
    await b.commit();
    toast(d.mode === "edit" ? "Salvato" : d.name + " messo in casa");
  });
}
function wasteItem(d){
  const it = { ...d.orig, qty: qtyOf(d.orig) };
  closeSheet("sheet");
  safe(() => addDoc(col("events"), eventData("waste", it, it.qty)));
  finishItems([it]);
}
function deleteItem(d){
  const dlg = $("#ask");
  $("#askBody").replaceChildren(el("h2", null, "Eliminare " + d.name + "?"),
    el("p", { class: "muted", style: "margin:0" }, "Usalo per gli inserimenti sbagliati: non conta nelle statistiche."),
    el("div", { class: "foot" },
      el("button", { class: "btn ghost", onclick: () => dlg.close() }, "Annulla"),
      el("button", { class: "btn danger", onclick: () => { dlg.close(); closeSheet("sheet"); safe(() => deleteDoc(doc(col("fridge"), d.id))); toast("Eliminato"); } }, "Elimina")));
  dlg.showModal();
}

/* =========================================================
   Utilizza (consumo legato a un pasto)
   ========================================================= */
const roundAmt = (x, u) => stepOf(u) === 1 ? Math.max(0.5, Math.round(x * 2) / 2) : Math.max(0.05, round2(x));
let lastPeople = null;
function defaultPeople(){
  const ids = people().map(p => p.id);
  try { const saved = JSON.parse(ls.get("frigo.lastPeople") || "null"); if (Array.isArray(saved)){ const f = saved.filter(x => ids.includes(x)); if (f.length) return new Set(f); } } catch (_) {}
  return new Set(ids);
}
function peopleBlock(ui, set){
  const ps = people();
  const all = el("button", { class: "opt", type: "button", onclick: () => { if (set.size === ps.length) set.clear(); else ps.forEach(p => set.add(p.id)); ui.refresh(); } }, "Tutti");
  const multi = ui.multi(ps.map(p => ({ v: p.id, label: p.name, color: p.color })), v => set.has(v), v => { set.has(v) ? set.delete(v) : set.add(v); });
  multi.prepend(all);
  const up = () => all.setAttribute("aria-pressed", String(set.size === ps.length && ps.length > 0));
  return { node: multi, up };
}
function whenBlock(ui, s){
  const dates = [0, -1, -2].map(n => ({ v: addDays(today(), n), label: n === 0 ? "Oggi" : n === -1 ? "Ieri" : cap(parseD(addDays(today(), n)).toLocaleDateString("it-IT", { weekday: "long" })) }));
  return el("div", { class: "block" }, el("div", { class: "lbl" }, "Quando"),
    ui.opts(dates, () => s.date, v => s.date = v),
    el("div", { style: "height:8px" }),
    ui.opts(MEALS.map(m => ({ v: m.id, label: m.label, icon: m.icon })), () => s.meal, v => s.meal = v));
}
function mealItem(it, qty, i = 0){
  return { name: it.name, emoji: emojiOf(it), qty: round2(qty), unit: it.unit || "pz",
    value: it.price != null ? round2(qty * it.price) : null, ts: Date.now() + i };
}
function openUse(i){
  const q = qtyOf(i), u = i.unit || "pz";
  const s = { amount: Math.min(q, stepOf(u)), date: today(), meal: defaultMeal(), people: defaultPeople() };
  const ui = makeUI();
  const pb = peopleBlock(ui, s.people);
  const body = el("div", null,
    el("div", { class: "block" }, el("div", { class: "prod-head" }, el("span", { class: "e" }, emojiOf(i)),
      el("span", { class: "n" }, i.name), el("span", { class: "muted" }, "in casa: " + fmtQty(q, u)))),
    el("div", { class: "block" }, el("div", { class: "lbl" }, "Quanto hai usato"),
      el("div", { class: "opts" },
        el("button", { class: "opt", type: "button", onclick: () => { s.amount = q; ui.refresh(); } }, "Tutto"),
        el("button", { class: "opt", type: "button", onclick: () => { s.amount = Math.min(q, roundAmt(q / 2, u)); ui.refresh(); } }, "Metà"),
        el("button", { class: "opt", type: "button", onclick: () => { s.amount = Math.min(q, roundAmt(q / 4, u)); ui.refresh(); } }, "¼")),
      el("div", { style: "height:8px" }),
      ui.stepper(() => fmtQty(s.amount, u) + (s.amount >= q ? " (tutto)" : ""),
        () => { s.amount = Math.max(stepOf(u) < 1 ? 0.25 : 0.5, round2(s.amount - stepOf(u))); },
        () => { s.amount = Math.min(q, round2(s.amount + stepOf(u))); })),
    whenBlock(ui, s),
    el("div", { class: "block" }, el("div", { class: "lbl" }, "Chi ha mangiato"), pb.node));
  ui.refresh(); pb.up();
  const origRefresh = ui.refresh; ui.refresh = () => { origRefresh(); pb.up(); };
  const ok = el("button", { class: "btn", onclick: () => confirmUse(i, s) }, "Registra");
  openSheet("sheet", "Utilizza", body, [el("button", { class: "btn ghost", onclick: () => closeSheet("sheet") }, "Annulla"), ok]);
}
function mealWrite(b, date, meal, peopleIds, items){
  const ref = doc(col("meals"), date + "_" + meal);
  const data = { date, meal, updatedAt: Date.now() };
  if (peopleIds.length) data.people = arrayUnion(...peopleIds);
  if (items.length) data.items = arrayUnion(...items);
  b.set(ref, data, { merge: true });
  return ref.id;
}
function confirmUse(i, s){
  const q = qtyOf(i), amt = Math.min(q, s.amount), left = round2(q - amt);
  const ids = [...s.people]; ls.set("frigo.lastPeople", JSON.stringify(ids));
  closeSheet("sheet");
  safe(async () => {
    const b = writeBatch(db);
    const mealId = mealWrite(b, s.date, s.meal, ids, [mealItem(i, amt)]);
    b.set(doc(col("events")), eventData("use", i, amt, { mealId, date: s.date }));
    if (left > 0.0001) b.update(doc(col("fridge"), i.id), { qty: left });
    await b.commit();
    if (left <= 0.0001) finishItems([i]); else toast("Registrato: " + fmtQty(amt, i.unit) + " di " + i.name);
  });
}

/* =========================================================
   Pasti
   ========================================================= */
function renderMeals(){
  const box = $("#mealsList");
  if (!box) return;
  const meals = [...state.meals].sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 :
    MEALS.findIndex(m => m.id === b.meal) - MEALS.findIndex(m => m.id === a.meal));
  if (!meals.length){
    box.replaceChildren(el("div", { class: "empty" }, el("strong", null, "Nessun pasto registrato"),
      "Usa «Utilizza» su un prodotto, oppure «Nuovo pasto» per segnare chi ha mangiato e cosa."));
    return;
  }
  const out = []; let lastDay = null;
  for (const m of meals){
    if (m.date !== lastDay){ out.push(el("div", { class: "day" }, dayLabel(m.date))); lastDay = m.date; }
    const meta = MEALS.find(x => x.id === m.meal) || MEALS[3];
    const items = m.items || [], ppl = (m.people || []).map(id => people().find(p => p.id === id)).filter(Boolean);
    const tot = items.reduce((a, x) => a + (x.value || 0), 0);
    out.push(el("div", { class: "meal" },
      el("div", { class: "h" }, el("span", null, meta.icon), el("span", { class: "grow" }, meta.label),
        tot ? el("span", null, eur(tot)) : null),
      ppl.length ? el("div", { class: "muted small", style: "margin-top:4px" },
        ppl.map((p, k) => el("span", null, el("span", { class: "dot", style: "background:" + p.color }), p.name + (k < ppl.length - 1 ? "  " : "")))) : null,
      items.length ? el("div", { class: "chips" }, items.map(x => el("span", { class: "chip" },
        (x.emoji || "") + " " + x.name + " " + fmtQty(x.qty, x.unit) + (x.value ? " · " + eur(x.value) : "")))) : null));
  }
  box.replaceChildren(...out);
}
function openNewMeal(){
  const s = { date: today(), meal: defaultMeal(), people: defaultPeople(), used: {}, q: "" };
  const ui = makeUI();
  const pb = peopleBlock(ui, s.people);
  const list = el("div");
  const search = el("input", { type: "search", placeholder: "Filtra (facoltativo)", "aria-label": "Filtra ingredienti" });
  const renderList = () => {
    const q = norm(s.q);
    const items = state.fridge.filter(i => (i.location || "frigo") !== "utility" && (!q || norm(i.name).includes(q))).sort(sortItems);
    if (!items.length){ list.replaceChildren(el("div", { class: "muted", style: "padding:10px" }, "Nessun prodotto disponibile.")); return; }
    list.replaceChildren(...items.map(i => {
      const q0 = qtyOf(i), u = i.unit || "pz";
      const v = el("span", { class: "v" });
      const up = () => { const a = s.used[i.id] || 0; v.textContent = a ? fmtQty(a, u) : "—"; row.style.outline = a ? "2px solid var(--accent)" : ""; };
      const row = el("div", { class: "urow" },
        el("div", { class: "nm" }, el("b", null, emojiOf(i) + " " + i.name), el("span", { class: "muted small" }, "in casa " + fmtQty(q0, u))),
        el("span", { class: "mini" },
          el("button", { type: "button", onclick: () => { s.used[i.id] = Math.max(0, round2((s.used[i.id] || 0) - stepOf(u))); up(); updateFoot(); } }, "−"), v,
          el("button", { type: "button", onclick: () => { s.used[i.id] = Math.min(q0, round2((s.used[i.id] || 0) + stepOf(u))); up(); updateFoot(); } }, "+")),
        el("button", { class: "btn ghost small", type: "button", onclick: () => { s.used[i.id] = q0; up(); updateFoot(); } }, "Tutto"));
      up(); return row;
    }));
  };
  search.addEventListener("input", () => { s.q = search.value; renderList(); });
  const body = el("div", null, whenBlock(ui, s),
    el("div", { class: "block" }, el("div", { class: "lbl" }, "Chi mangia"), pb.node),
    el("div", { class: "block" }, el("div", { class: "lbl" }, "Ingredienti presi da casa"), search, el("div", { style: "height:8px" }), list));
  const saveBtn = el("button", { class: "btn", onclick: () => saveMeal(s) }, "Salva pasto");
  const updateFoot = () => { const n = Object.values(s.used).filter(x => x > 0).length; saveBtn.textContent = n ? "Salva pasto (" + n + (n === 1 ? " ingrediente)" : " ingredienti)") : "Salva pasto"; };
  const origRefresh = ui.refresh; ui.refresh = () => { origRefresh(); pb.up(); };
  renderList(); ui.refresh();
  openSheet("sheet", "Nuovo pasto", body, [el("button", { class: "btn ghost", onclick: () => closeSheet("sheet") }, "Annulla"), saveBtn]);
}
function saveMeal(s){
  const ids = [...s.people]; ls.set("frigo.lastPeople", JSON.stringify(ids));
  const used = Object.entries(s.used).filter(([, a]) => a > 0).map(([id, a]) => ({ it: state.fridge.find(f => f.id === id), a })).filter(x => x.it);
  if (!ids.length && !used.length){ toast("Scegli chi mangia o almeno un ingrediente."); return; }
  closeSheet("sheet");
  safe(async () => {
    const b = writeBatch(db), finished = [];
    const mealId = mealWrite(b, s.date, s.meal, ids, used.map((x, k) => mealItem(x.it, x.a, k)));
    used.forEach(({ it, a }) => {
      const left = round2(qtyOf(it) - a);
      b.set(doc(col("events")), eventData("use", it, a, { mealId, date: s.date }));
      if (left > 0.0001) b.update(doc(col("fridge"), it.id), { qty: left }); else finished.push(it);
    });
    await b.commit();
    toast("Pasto salvato");
    if (finished.length) finishItems(finished);
  });
}
$("#newMealBtn").addEventListener("click", openNewMeal);

/* =========================================================
   Spesa
   ========================================================= */
const QUICK_DEFAULT = ["Latte fresco", "Pane", "Uova", "Pasta", "Mozzarella", "Yogurt", "Insalata", "Pomodori", "Mele", "Banane", "Acqua naturale", "Scottex"];
function renderShop(){
  const open = state.shopping.filter(x => !x.done).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const done = state.shopping.filter(x => x.done);
  // Aggiungi al volo
  const all = products();
  let quick = all.filter(p => p.uses > 0).sort((a, b) => b.uses - a.uses);
  if (quick.length < 8) quick = quick.concat(QUICK_DEFAULT.map(n => all.find(p => p.name === n)).filter(Boolean));
  const seen = new Set();
  quick = quick.filter(p => { if (seen.has(p.id) || shopHas(p.name)) return false; seen.add(p.id); return true; }).slice(0, 14);
  $("#shopQuick").replaceChildren(...quick.map(p => el("button", { class: "qchip", onclick: () => addToShopping({ name: p.name, productId: p.id, emoji: p.emoji }) }, p.emoji + " " + p.name)));
  const row = x => {
    const cb = el("input", { type: "checkbox", "aria-label": "Comprato: " + x.name });
    cb.checked = !!x.done;
    cb.addEventListener("change", () => safe(() => updateDoc(doc(col("shopping"), x.id), { done: cb.checked })));
    const by = x.addedBy && x.addedBy !== me.uid ? personName(x.addedBy) : "";
    return el("li", { class: "shop" + (x.done ? " done" : "") }, cb, el("span", { class: "em" }, emojiOf(x)),
      el("div", { class: "txt" }, el("div", { class: "name" }, (x.qty ? fmtQty(x.qty, x.unit) + " " : "") + x.name),
        by ? el("div", { class: "muted small" }, "da " + by) : null),
      el("button", { class: "btn ghost small", "aria-label": "Togli " + x.name, onclick: () => safe(() => deleteDoc(doc(col("shopping"), x.id))) }, "✕"));
  };
  $("#shopList").replaceChildren(...(open.length ? open.map(row)
    : [el("li", { class: "empty" }, el("strong", null, "Lista vuota"), "Tocca i prodotti qui sopra o detta la spesa con il microfono.")]));
  $("#doneList").replaceChildren(...done.map(row));
  $("#doneTitle").hidden = !done.length; $("#doneBar").hidden = !done.length;
  $("#doneCount").textContent = done.length ? String(done.length) : "";
  $("#spesaFattaBtn").textContent = "Spesa fatta: metti in casa (" + done.length + ")";
}
$("#shopPickBtn").addEventListener("click", () => openPicker("shop"));
$("#addBtn").addEventListener("click", () => openPicker("home"));
$("#clearDone").addEventListener("click", () => safe(async () => {
  const b = writeBatch(db); state.shopping.filter(s => s.done).forEach(x => b.delete(doc(col("shopping"), x.id))); await b.commit();
}));
$("#spesaFattaBtn").addEventListener("click", () => {
  const done = state.shopping.filter(s => s.done);
  openBatch(done.map(x => ({ name: x.name, productId: x.productId, qty: x.qty, unit: x.unit, shopId: x.id })), "Spesa fatta");
});

/* =========================================================
   Revisione multipla: spesa fatta / dettatura in casa
   ========================================================= */
function openBatch(entries, title){
  const rows = entries.map(e => {
    const p = productById(e.productId) || findProduct(e.name) || null;
    const unit = e.unit || (p && p.unit) || "pz";
    const loc = (p && p.loc) || "frigo";
    return { name: p && norm(p.name) === norm(e.name) ? p.name : e.name, productId: p ? p.id : null, emoji: p ? p.emoji : "🛒",
      cat: p ? p.cat : "altro", unit, qty: e.qty || 1, price: p ? (p.price ?? null) : null, loc,
      expiresAt: p && p.days != null ? addDays(today(), p.days) : "", shopId: e.shopId || null, removed: false };
  });
  const list = el("div");
  const confirmBtn = el("button", { class: "btn" });
  const updateFoot = () => { const n = rows.filter(r => !r.removed).length; confirmBtn.textContent = "Metti in casa (" + n + ")"; confirmBtn.disabled = !n; };
  const render = () => {
    list.replaceChildren(...rows.filter(r => !r.removed).map(r => {
      const ui = makeUI();
      const unitBtn = ui.text(() => r.unit, "button", { class: "opt", type: "button", style: "min-height:36px;padding:4px 10px" });
      unitBtn.addEventListener("click", () => { r.unit = UNITS[(UNITS.indexOf(r.unit) + 1) % UNITS.length]; if (stepOf(r.unit) === 1) r.qty = Math.max(1, Math.round(r.qty)); ui.refresh(); });
      const node = el("div", { class: "brow" },
        el("div", { class: "r1" }, el("span", { style: "font-size:1.4rem" }, r.emoji), el("span", { class: "nm" }, r.name),
          el("button", { class: "x", type: "button", "aria-label": "Togli " + r.name, onclick: () => { r.removed = true; render(); updateFoot(); } }, "✕")),
        el("div", { class: "r3" },
          ui.stepper(() => num(r.qty), () => { r.qty = Math.max(stepOf(r.unit), round2(r.qty - stepOf(r.unit))); }, () => { r.qty = round2(r.qty + stepOf(r.unit)); }, "mini"),
          unitBtn,
          el("span", { class: "mini" },
            el("button", { type: "button", onclick: () => { priceStep(() => r.price, v => r.price = v, -1); ui.refresh(); } }, "−"),
            ui.priceInput(() => r.price, v => r.price = v),
            el("button", { type: "button", onclick: () => { priceStep(() => r.price, v => r.price = v, 1); ui.refresh(); } }, "+")),
          ui.text(() => "€/" + r.unit, "span", { class: "muted small" })),
        ui.opts(LOC_ORDER.map(l => ({ v: l, label: LOCS[l].label, icon: LOCS[l].icon })), () => r.loc, v => {
          const was = r.loc; r.loc = v;
          if (v === "freezer" && was !== "freezer"){ const left = daysLeft(r.expiresAt); if (left === null || left < FREEZER_DAYS) r.expiresAt = addDays(today(), FREEZER_DAYS); }
          if (v === "utility") r.expiresAt = "";
        }, "loc4"),
        ui.when(() => r.loc !== "utility", el("div", { class: "r3" }, el("span", { class: "muted small" }, "SCAD"),
          el("span", { class: "mini" },
            el("button", { type: "button", onclick: () => { if (r.expiresAt){ r.expiresAt = addDays(r.expiresAt, -1); ui.refresh(); } } }, "−"),
            ui.datePicker(() => r.expiresAt, v => r.expiresAt = v),
            el("button", { type: "button", onclick: () => { r.expiresAt = r.expiresAt ? addDays(r.expiresAt, 1) : addDays(today(), 1); ui.refresh(); } }, "+")))));
      ui.refresh();
      return node;
    }));
    if (!rows.some(r => !r.removed)) list.replaceChildren(el("div", { class: "empty" }, el("strong", null, "Niente da mettere in casa")));
  };
  confirmBtn.addEventListener("click", () => {
    const sel = rows.filter(r => !r.removed);
    closeSheet("sheet");
    safe(async () => {
      const b = writeBatch(db);
      sel.forEach(r => {
        const L = learnOp(r, { days: r.expiresAt && r.loc !== "freezer" ? diffDays(today(), r.expiresAt) : undefined, price: r.price });
        const data = { name: r.name, productId: L.id, emoji: r.emoji, cat: r.cat, qty: round2(r.qty), unit: r.unit, price: r.price ?? null,
          location: r.loc, addedAt: today(), expiresAt: r.expiresAt || "", openedAt: "", expBeforeOpen: "", addedBy: me.uid, createdAt: Date.now() };
        b.set(doc(col("fridge")), data);
        b.set(doc(col("events")), eventData("in", data, data.qty));
        b.set(L.ref, L.data, { merge: true });
        if (r.shopId) b.delete(doc(col("shopping"), r.shopId));
      });
      await b.commit();
      toast(sel.length === 1 ? "1 prodotto messo in casa" : sel.length + " prodotti messi in casa");
    });
  });
  render(); updateFoot();
  openSheet("sheet", title, el("div", null, el("p", { class: "muted small", style: "margin:0 2px 10px" },
    "Controlla quantità, prezzo, posizione e scadenza, poi conferma."), list),
    [el("button", { class: "btn ghost", onclick: () => closeSheet("sheet") }, "Annulla"), confirmBtn]);
}

/* =========================================================
   Dettatura vocale
   ========================================================= */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const NUMW = { un: 1, uno: 1, una: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9, dieci: 10, dodici: 12, mezzo: 0.5, mezza: 0.5 };
const ARTW = new Set(["il", "lo", "la", "i", "gli", "le", "l", "del", "dello", "della", "dei", "degli", "delle", "di", "da", "po", "qualche", "ancora", "comprare", "prendere", "serve", "servono", "anche"]);
const UNITW = { chilo: "kg", chili: "kg", kg: "kg", chilogrammi: "kg", chilogrammo: "kg", litro: "l", litri: "l", pacco: "conf", pacchi: "conf",
  confezione: "conf", confezioni: "conf", pacchetto: "conf", pacchetti: "conf", scatola: "conf", scatole: "conf", bottiglia: "pz", bottiglie: "pz",
  pezzi: "pz", pezzo: "pz", vasetto: "pz", vasetti: "pz", barattolo: "pz", barattoli: "pz", rotoli: "conf" };
function parseSpeech(text){
  const parts = text.toLowerCase().replace(/[.;]/g, ",").replace(/l'/g, "l ").split(/,|\s+e\s+|\s+ed\s+|\s+poi\s+|\s+più\s+/);
  const out = [];
  for (const part of parts){
    const words = part.trim().split(/\s+/).filter(Boolean);
    let qty = null, unit = null;
    while (words.length){
      const w = words[0];
      if (/^\d+([.,]\d+)?$/.test(w) && qty == null){ qty = parseFloat(w.replace(",", ".")); words.shift(); }
      else if (NUMW[w] != null && qty == null){ qty = NUMW[w]; words.shift(); }
      else if (UNITW[w] && !unit){ unit = UNITW[w]; words.shift(); }
      else if (ARTW.has(w)){ words.shift(); }
      else break;
    }
    const name = words.join(" ").trim();
    if (!name) continue;
    const p = findProduct(name);
    out.push({ name: p ? p.name : cap(name), productId: p ? p.id : null, emoji: p ? p.emoji : "🛒", qty, unit: unit || (qty != null && p ? p.unit : null) || (qty != null ? "pz" : null) });
  }
  return out;
}
function openVoice(target){
  const items = [];
  const heard = el("div", { class: "heard" }, SR ? "Tocca il microfono e parla" : "");
  const btn = el("button", { class: "voice-btn", "aria-label": "Avvia dettatura" }, "🎤");
  const list = el("div");
  const confirm = el("button", { class: "btn" });
  const updateFoot = () => { confirm.textContent = (target === "shop" ? "Aggiungi alla spesa" : "Continua") + (items.length ? " (" + items.length + ")" : ""); confirm.disabled = !items.length; };
  const render = () => {
    list.replaceChildren(...items.map((it, k) => el("div", { class: "vrow" }, el("span", { class: "em" }, it.emoji),
      el("span", { class: "nm" }, (it.qty != null ? num(it.qty) + " " + (it.unit && it.unit !== "pz" ? it.unit + " " : "× ") : "") + it.name),
      el("button", { class: "x", "aria-label": "Togli " + it.name, onclick: () => { items.splice(k, 1); render(); updateFoot(); } }, "✕"))));
    updateFoot();
  };
  let rec = null, listening = false;
  const start = () => {
    if (!SR){ heard.textContent = "La dettatura non è supportata su questo browser. Usa Chrome su Android."; return; }
    if (listening){ rec && rec.stop(); return; }
    rec = new SR(); rec.lang = "it-IT"; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
    rec.onstart = () => { listening = true; btn.classList.add("on"); heard.textContent = "Ti ascolto…"; };
    rec.onresult = ev => {
      let interim = "", final = "";
      for (let k = ev.resultIndex; k < ev.results.length; k++){
        const t = ev.results[k][0].transcript;
        if (ev.results[k].isFinal) final += t + " "; else interim += t;
      }
      if (interim) heard.textContent = "«" + interim + "»";
      if (final.trim()){ heard.textContent = "«" + final.trim() + "»"; items.push(...parseSpeech(final)); render(); }
    };
    rec.onerror = ev => {
      heard.textContent = ev.error === "not-allowed" || ev.error === "service-not-allowed" ? "Consenti l’uso del microfono per questa app e riprova."
        : ev.error === "no-speech" ? "Non ho sentito nulla: riprova." : ev.error === "network" ? "Per la dettatura serve la connessione." : "Dettatura interrotta: riprova.";
    };
    rec.onend = () => { listening = false; btn.classList.remove("on"); if (heard.textContent === "Ti ascolto…") heard.textContent = "Tocca il microfono e parla"; };
    try { rec.start(); } catch (e){ console.error(e); }
  };
  btn.addEventListener("click", start);
  confirm.addEventListener("click", async () => {
    if (rec && listening) rec.stop();
    closeSheet("sheet");
    if (target === "shop"){
      let n = 0;
      for (const it of items) if (await addToShopping(it, { silent: true })) n++;
      toast(n ? (n === 1 ? "1 prodotto aggiunto alla spesa" : n + " prodotti aggiunti alla spesa") : "Erano già tutti in lista");
    } else {
      setTimeout(() => openBatch(items.map(it => ({ name: it.name, productId: it.productId, qty: it.qty, unit: it.unit })), "Metti in casa"), 50);
    }
  });
  $("#sheet").addEventListener("close", () => { if (rec && listening) rec.abort(); }, { once: true });
  updateFoot();
  openSheet("sheet", target === "shop" ? "Detta la spesa" : "Detta cosa metti via",
    el("div", null, el("div", { class: "voice-big" }, btn, heard),
      el("p", { class: "muted small", style: "text-align:center;margin:0 0 12px" }, "Esempio: «latte, sei uova, mezzo chilo di pane e due mozzarelle». Puoi toccare di nuovo il microfono per aggiungere altro."),
      list),
    [el("button", { class: "btn ghost", onclick: () => closeSheet("sheet") }, "Annulla"), confirm]);
  start();
}
$("#micFab").addEventListener("click", () => openVoice("shop"));
$("#voiceHomeBtn").addEventListener("click", () => openVoice("home"));

/* =========================================================
   Statistiche
   ========================================================= */
function periodRange(p){
  const t = parseD(today());
  if (p === "week"){ const d = new Date(t); const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd); return [toISO(d), today(), "dal " + dShort(toISO(d))]; }
  if (p === "month"){ const d = new Date(t.getFullYear(), t.getMonth(), 1); return [toISO(d), today(), cap(t.toLocaleDateString("it-IT", { month: "long" }))]; }
  const s = new Date(t.getFullYear(), t.getMonth() - 1, 1), e = new Date(t.getFullYear(), t.getMonth(), 0);
  return [toISO(s), toISO(e), cap(s.toLocaleDateString("it-IT", { month: "long", year: "numeric" }))];
}
let statsToken = 0;
async function renderStats(){
  const body = $("#statsBody"), token = ++statsToken;
  const [s, e, label] = periodRange(state.period);
  body.replaceChildren(el("div", { class: "notice" }, "Calcolo in corso…"));
  let evs = [], meals = [];
  try {
    const [a, b] = await Promise.all([
      getDocs(query(col("events"), where("date", ">=", s), where("date", "<=", e))),
      getDocs(query(col("meals"), where("date", ">=", s), where("date", "<=", e)))]);
    evs = a.docs.map(d => d.data()); meals = b.docs.map(d => d.data());
  } catch (err){ console.error(err); if (token === statsToken) body.replaceChildren(el("div", { class: "notice" }, "Statistiche non disponibili: serve la connessione e le regole aggiornate di Firestore.")); return; }
  if (token !== statsToken) return;
  const agg = t => { const x = evs.filter(v => v.type === t); return { n: x.length, v: round2(x.reduce((a, v) => a + (v.value || 0), 0)) }; };
  const inn = agg("in"), use = agg("use"), waste = agg("waste");
  const outEv = evs.filter(v => v.type === "use" || v.type === "waste");
  const allPriced = outEv.length > 0 && outEv.every(v => v.value != null);
  const pct = allPriced && (use.v + waste.v) > 0 ? Math.round(waste.v / (use.v + waste.v) * 100)
    : (use.n + waste.n) > 0 ? Math.round(waste.n / (use.n + waste.n) * 100) : 0;
  const inHouse = round2(state.fridge.reduce((a, i) => a + (i.price ? qtyOf(i) * i.price : 0), 0));
  const tile = (k, v, sub, cls) => el("div", { class: "tile" + (cls ? " " + cls : "") }, el("div", { class: "k" }, k), el("div", { class: "v" }, v), el("div", { class: "s" }, sub));
  const top = (t, by) => {
    const m = {};
    evs.filter(v => v.type === t).forEach(v => { const k = v.name; m[k] = m[k] || { n: 0, v: 0 }; m[k].n++; m[k].v += v.value || 0; });
    return Object.entries(m).sort((a, b) => by === "v" ? (b[1].v - a[1].v || b[1].n - a[1].n) : (b[1].n - a[1].n || b[1].v - a[1].v)).slice(0, 5);
  };
  const bars = (rows, w, fmt) => {
    if (!rows.length) return el("div", { class: "muted small" }, "Niente da mostrare in questo periodo.");
    const max = Math.max(...rows.map(r => r[2]));
    return el("div", null, rows.map(([name, txt, val]) => el("div", { class: "barrow" + (w ? " w" : "") },
      el("span", null, name), el("span", { class: "muted" }, txt),
      el("div", { class: "track" }, el("div", { class: "fill", style: "width:" + (max ? Math.max(4, val / max * 100) : 0) + "%" })))));
  };
  const wasteTop = top("waste", "v").map(([n, x]) => [n, x.v ? eur(x.v) + " · " + x.n + "×" : x.n + "×", x.v || x.n]);
  const useTop = top("use", "n").map(([n, x]) => [n, x.n + (x.n === 1 ? " volta" : " volte") + (x.v ? " · " + eur(x.v) : ""), x.n]);
  const perPerson = {}; meals.forEach(m => (m.people || []).forEach(id => { perPerson[id] = (perPerson[id] || 0) + 1; }));
  const pRows = Object.entries(perPerson).map(([id, n]) => [personName(id) || "—", n + (n === 1 ? " pasto" : " pasti"), n]).sort((a, b) => b[2] - a[2]);
  const mealVals = meals.map(m => (m.items || []).reduce((a, x) => a + (x.value || 0), 0)).filter(v => v > 0);
  const avgMeal = mealVals.length ? round2(mealVals.reduce((a, b) => a + b, 0) / mealVals.length) : 0;
  const noPrices = !evs.some(v => v.value);
  body.replaceChildren(...[
    el("div", { class: "muted small", style: "margin:0 2px" }, label),
    el("div", { class: "tiles" },
      tile("Acquistato", eur(inn.v), inn.n + (inn.n === 1 ? " inserimento" : " inserimenti")),
      tile("Consumato", eur(use.v), use.n + (use.n === 1 ? " utilizzo" : " utilizzi")),
      tile("Buttato", eur(waste.v), waste.n + (waste.n === 1 ? " prodotto" : " prodotti") + " · " + pct + "% spreco", "waste")),
    noPrices ? el("div", { class: "notice" }, "Aggiungi il prezzo quando metti in casa i prodotti per vedere i valori in euro. Il prezzo viene ricordato per le volte successive.") : null,
    el("div", { class: "panel" }, el("h3", null, "Più buttati"), bars(wasteTop, true)),
    el("div", { class: "panel" }, el("h3", null, "Più consumati"), bars(useTop, false)),
    el("div", { class: "panel" }, el("h3", null, "Pasti per persona"), bars(pRows, false),
      el("div", { class: "muted small", style: "margin-top:6px" }, meals.length + (meals.length === 1 ? " pasto registrato" : " pasti registrati") + (avgMeal ? " · costo medio " + eur(avgMeal) : ""))),
    el("div", { class: "panel" }, el("h3", null, "Valore in casa adesso"), el("div", { style: "font-size:1.4rem;font-weight:800" }, eur(inHouse)),
      el("div", { class: "muted small" }, "Somma dei prodotti con prezzo indicato"))].filter(Boolean));
}
document.querySelectorAll("#periodSeg button").forEach(b => b.addEventListener("click", () => {
  state.period = b.dataset.p;
  document.querySelectorAll("#periodSeg button").forEach(x => x.setAttribute("aria-pressed", x === b));
  renderStats();
}));

/* =========================================================
   Schede, impostazioni, persone, notifiche
   ========================================================= */
document.querySelectorAll("nav.tabs button").forEach(b => b.addEventListener("click", () => {
  state.tab = b.dataset.tab;
  document.querySelectorAll("nav.tabs button").forEach(x => x.setAttribute("aria-selected", x === b));
  ["casa", "spesa", "pasti", "stats"].forEach(t => { $("#tab-" + t).hidden = t !== state.tab; });
  $("#micFab").hidden = state.tab !== "spesa";
  if (state.tab === "stats") renderStats();
  if (state.tab === "pasti") renderMeals();
  window.scrollTo(0, 0);
}));

function renderSettings(){
  $("#inviteCode").textContent = hid || "";
  if (document.activeElement !== $("#alertDays")) $("#alertDays").value = state.house.alertDays ?? 3;
  $("#peopleList").replaceChildren(...people().map(p => el("span", { class: "chip" }, el("span", { class: "dot", style: "background:" + p.color }), p.name,
    p.account ? el("span", { class: "muted small" }, " · app") : el("button", { class: "rm", "aria-label": "Togli " + p.name, onclick: () => removePerson(p.id) }, "✕"))));
}
function openSettings(){ renderSettings(); renderNotifStatus(); $("#settingsDialog").showModal(); }
$("#settingsBtn").addEventListener("click", openSettings);
$("#closeSettings").addEventListener("click", () => $("#settingsDialog").close());
$("#logoutBtn").addEventListener("click", () => { $("#settingsDialog").close(); stopSubs(); signOut(auth); });
$("#shareCode").addEventListener("click", async () => {
  const text = "Entra nella nostra app del frigo! Apri " + location.href.split("#")[0] + " e usa il codice invito " + hid;
  try { if (navigator.share) await navigator.share({ title: "Frigo di casa", text }); else { await navigator.clipboard.writeText(text); toast("Messaggio copiato"); } } catch (_) {}
});
$("#addPerson").addEventListener("click", () => {
  const n = $("#newPerson").value.trim(); if (!n) return;
  const list = [...(state.house.extraPeople || []), { id: "p-" + Date.now().toString(36), name: n }];
  $("#newPerson").value = "";
  safe(() => updateDoc(doc(db, "households", hid), { extraPeople: list }));
});
function removePerson(id){
  const list = (state.house.extraPeople || []).filter(p => p.id !== id);
  safe(() => updateDoc(doc(db, "households", hid), { extraPeople: list }));
}
let adTimer;
$("#alertDays").addEventListener("input", e => {
  const v = Math.max(0, Math.min(30, Number(e.target.value) || 0));
  clearTimeout(adTimer);
  adTimer = setTimeout(() => { if (v !== state.house.alertDays) safe(() => updateDoc(doc(db, "households", hid), { alertDays: v })); }, 600);
});

function renderNotifStatus(){
  const s = $("#notifStatus"), b = $("#notifBtn");
  if (!("Notification" in window)){ s.textContent = "Notifiche non supportate qui. Installa l’app da Chrome."; b.disabled = true; return; }
  if (Notification.permission === "denied"){ s.textContent = "Notifiche bloccate: riattivale dalle impostazioni di Android per questa app."; b.disabled = true; return; }
  const on = Notification.permission === "granted" && ls.get("frigo.pushToken");
  b.disabled = false;
  b.textContent = on ? "Aggiorna notifiche su questo telefono" : "Attiva notifiche su questo telefono";
  s.textContent = on ? "Attive: ogni mattina il riepilogo delle scadenze." : "Ogni mattina un riepilogo di cosa sta per scadere.";
}
async function enableNotifications(){
  const s = $("#notifStatus");
  try {
    if (!C.vapidKey || String(C.vapidKey).startsWith("INCOLLA")){ s.textContent = "Manca la vapidKey in config.js."; return; }
    if (!(await isSupported())){ s.textContent = "Notifiche non supportate qui."; return; }
    const perm = await Notification.requestPermission();
    if (perm !== "granted"){ renderNotifStatus(); return; }
    s.textContent = "Attivazione…";
    const reg = await navigator.serviceWorker.ready;
    const token = await getToken(getMessaging(), { vapidKey: C.vapidKey, serviceWorkerRegistration: reg });
    if (!token) throw new Error("no token");
    await setDoc(doc(db, "users", me.uid), { tokens: arrayUnion(token) }, { merge: true });
    ls.set("frigo.pushToken", token); $("#notifHint").hidden = true;
    renderNotifStatus(); toast("Notifiche attive su questo telefono.");
  } catch (e){ console.error(e); s.textContent = "Attivazione non riuscita. Riprova."; }
}
$("#notifBtn").addEventListener("click", enableNotifications);
function maybeHintNotifications(){
  const h = $("#notifHint");
  const need = "Notification" in window && Notification.permission !== "denied" && !(Notification.permission === "granted" && ls.get("frigo.pushToken")) && !ls.get("frigo.hintDismissed");
  if (!need){ h.hidden = true; return; }
  h.replaceChildren("Vuoi un avviso ogni mattina con i prodotti in scadenza? ",
    el("button", { class: "btn small", style: "margin:6px 6px 0 0", onclick: enableNotifications }, "Attiva notifiche"),
    el("button", { class: "btn ghost small", style: "margin-top:6px", onclick: () => { ls.set("frigo.hintDismissed", "1"); h.hidden = true; } }, "Non ora"));
  h.hidden = false;
}

/* ---------- Varie ---------- */
const net = () => { $("#offline").hidden = navigator.onLine; };
window.addEventListener("online", net); window.addEventListener("offline", net); net();
let lastDay = today();
setInterval(() => { if (today() !== lastDay){ lastDay = today(); renderAll(); renderMeals(); } }, 60000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && hid) renderAll(); });
