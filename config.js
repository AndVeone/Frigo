// =====================================================================
//  CONFIGURAZIONE — l'unico file da modificare (vedi GUIDA.md, passi 2 e 5)
//  Questi valori NON sono segreti: la sicurezza è garantita dalle regole
//  di Firestore. Non mettere qui la chiave del service account.
// =====================================================================
self.FRIGO_CONFIG = {
  // Passo 2: incolla qui i valori di "firebaseConfig" della tua app web
  firebase: {
    apiKey: "AIzaSyDQk6V-4G8TikEBP1ncYpEeBGSh9_cf21A",
    authDomain: "frigo-6f3c9.firebaseapp.com",
    projectId: "frigo-6f3c9",
    storageBucket: "frigo-6f3c9.firebasestorage.app",
    messagingSenderId: "650638851985",
    appId: "1:650638851985:web:2bfdcaf614c0abbf19e430"
  },
  // Passo 5: la "coppia di chiavi" dei certificati Web Push (Cloud Messaging)
  vapidKey: "BAf8cNPcuCaX5ExNnYsJoV8Ja9y2Vi4FgWXkaCRLTqfs1IR524NWffNtmJxjFD_0AIxTWYNc3Gqczc_selDLHvg",
  // Modello usato per i suggerimenti di ricette (facoltativo)
  recipeModel: "claude-haiku-5-5"
};
