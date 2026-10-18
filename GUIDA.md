# Frigo di casa — guida all’installazione

Ti servono circa 45 minuti, un account Google e un account GitHub (gratuito). Si fa tutto dal browser del computer, senza installare programmi. Alla fine avrai un indirizzo tipo `https://tuonome.github.io/frigo/` da aprire sui telefoni Android della famiglia.

Cosa usa l’app, tutto con piani gratuiti:

- **Firebase** (Google): accesso, database condiviso e invio delle notifiche
- **GitHub Pages**: ospita l’app
- **GitHub Actions**: ogni mattina controlla le scadenze e manda la notifica

---

## 1. Crea il progetto Firebase

1. Vai su <https://console.firebase.google.com> e accedi con il tuo account Google.
2. Clicca **Crea un progetto** (o «Aggiungi progetto»), chiamalo per esempio `frigo-di-casa`.
3. Quando chiede di Google Analytics, disattivalo: non serve. Clicca **Crea progetto**.

Resta sul piano **Spark (gratuito)**: non serve inserire una carta di credito.

## 2. Registra l’app web e copia la configurazione

1. Nella pagina del progetto clicca l’icona **`</>`** (Web).
2. Nome: `Frigo`. **Non** spuntare «Firebase Hosting». Clicca **Registra app**.
3. Compare un blocco di codice con `const firebaseConfig = { apiKey: "...", ... }`.
4. Apri il file **`config.js`** del progetto con un editor di testo (Blocco note va benissimo) e sostituisci ogni `INCOLLA_QUI` della sezione `firebase` con il valore corrispondente. Lascia le virgolette.

Questi valori non sono segreti: possono stare in un repository pubblico. A proteggere i dati sono le regole del passo 4.

## 3. Attiva l’accesso

1. Menu a sinistra: **Build → Authentication → Inizia**.
2. Scheda **Metodo di accesso**:
   - attiva **Google** (scegli la tua email come email di assistenza) e salva;
   - attiva **Email/password** (solo la prima opzione) e salva.

## 4. Crea il database e incolla le regole di sicurezza

1. Menu: **Build → Firestore Database → Crea database**.
2. Posizione: scegli **`eur3 (europe-west)`** (o `europe-west8` Milano). Non si può cambiare dopo.
3. Scegli **Modalità di produzione** e conferma.
4. Apri la scheda **Regole**, cancella tutto e incolla il contenuto del file **`firestore.rules`**. Clicca **Pubblica**.

## 5. Crea la chiave per le notifiche

1. Clicca l’ingranaggio in alto a sinistra → **Impostazioni progetto** → scheda **Cloud Messaging**.
2. Controlla che **Firebase Cloud Messaging API (V1)** risulti **Attivata** (nei progetti nuovi lo è già).
3. In fondo, sezione **Configurazione web → Certificati push web**, clicca **Genera coppia di chiavi**.
4. Copia la chiave (una lunga stringa che inizia di solito con `B`) e incollala in **`config.js`** al posto di `INCOLLA_QUI` in `vapidKey`.

Salva `config.js`.

## 6. Pubblica l’app su GitHub Pages

1. Crea un account su <https://github.com> se non ce l’hai.
2. In alto a destra **+ → New repository**. Nome: `frigo`. Visibilità: **Public** (con l’account gratuito Pages funziona solo con repository pubblici). Clicca **Create repository**.
3. Nella pagina del repository clicca **uploading an existing file**.
4. Trascina dentro **tutti i file e le cartelle del progetto tranne la cartella `.github`** (quella la creiamo al passo 8): `index.html`, `app.js`, `config.js`, `sw.js`, `manifest.webmanifest`, `firestore.rules`, `GUIDA.md`, la cartella `icons` e la cartella `notifier`. Clicca **Commit changes**.
5. Vai su **Settings → Pages**. In «Build and deployment» scegli **Source: Deploy from a branch**, **Branch: main**, cartella **/ (root)**, e salva.
6. Dopo un paio di minuti in cima alla stessa pagina compare l’indirizzo dell’app, tipo `https://tuonome.github.io/frigo/`. Annotalo.

## 7. Autorizza l’indirizzo dell’app in Firebase

1. Firebase → **Authentication → Impostazioni → Domini autorizzati → Aggiungi dominio**.
2. Inserisci solo il dominio, senza `https://` e senza `/frigo`: per esempio `tuonome.github.io`.

Senza questo passo l’accesso con Google dà errore.

## 8. Attiva le notifiche automatiche ogni mattina

**a) Scarica la chiave del service account**

1. Firebase → ingranaggio → **Impostazioni progetto → Account di servizio**.
2. Clicca **Genera nuova chiave privata** → conferma. Si scarica un file `.json`.
3. Questa chiave è segreta: **non caricarla mai** nel repository, non mandarla per email o chat.

**b) Salvala tra i segreti di GitHub**

1. Nel repository GitHub: **Settings → Secrets and variables → Actions → New repository secret**.
2. Nome: `FIREBASE_SERVICE_ACCOUNT`. Valore: apri il file `.json` con Blocco note, copia **tutto** il contenuto e incollalo. Salva.
3. Crea un secondo secret. Nome: `APP_URL`. Valore: l’indirizzo dell’app del passo 6, per esempio `https://tuonome.github.io/frigo/`. Salva.
4. Ora puoi cancellare il file `.json` dal computer.

**c) Crea il programma giornaliero**

1. Nel repository: **Add file → Create new file**.
2. Come nome del file scrivi esattamente `.github/workflows/notifiche.yml` (scrivendo le barre, GitHub crea le cartelle da solo).
3. Incolla il contenuto del file `notifiche.yml` che trovi nella cartella `.github/workflows` del progetto e clicca **Commit changes**.

**d) Provalo**

Quando avrai attivato le notifiche su almeno un telefono (passo 9), vai su **Actions → Notifiche scadenze → Run workflow**. Se in frigo c’è qualcosa in scadenza, la notifica arriva in pochi secondi. Da quel momento parte da sola ogni mattina (8:00 d’estate, 7:00 d’inverno).

## 9. Installa l’app sui telefoni Android

Per ogni persona della famiglia:

1. Apri l’indirizzo dell’app in **Chrome**.
2. Menu **⋮ → Installa app** (o «Aggiungi a schermata Home»). Compare l’icona del frigo.
3. Apri l’app dall’icona e accedi con Google o con email e password.
4. La **prima persona** scrive il proprio nome e tocca **Crea la famiglia**: compare il **codice invito** di 10 caratteri, con il pulsante **Condividi codice** per mandarlo su WhatsApp.
5. **Gli altri** scrivono il proprio nome, inseriscono il codice e toccano **Entra nella famiglia**.
6. Ognuno tocca **Attiva notifiche** e consente le notifiche.

Da qui in poi frigo e lista della spesa sono condivisi in tempo reale. L’app funziona anche offline (in cantina, al supermercato senza campo): le modifiche si sincronizzano appena torna la rete.

## 10. Ricette con Claude (facoltativo)

1. Crea un account su <https://console.anthropic.com>, aggiungi un piccolo credito e crea una chiave API.
2. Nell’app: **Impostazioni (ingranaggio) → Chiave API Anthropic**, incolla la chiave e tocca **Fatto**.

La chiave resta salvata solo su quel telefono: non finisce nel database né su GitHub. Ogni richiesta di ricette costa pochi centesimi. Mettila solo sui telefoni di persone fidate, perché chi ha il telefono può usarla. Il modello si può cambiare in `config.js` (`recipeModel`).

---

## Domande frequenti

**Come aggiorno l’app se cambio qualcosa?**
Carica di nuovo il file modificato su GitHub (stessa procedura del passo 6, punto 3). I telefoni prendono la nuova versione alla seconda apertura.

**Le notifiche non arrivano più dopo qualche mese.**
Sui repository pubblici GitHub sospende i programmi automatici dopo 60 giorni senza modifiche al repository, e ti avvisa via email. Basta aprire **Actions → Notifiche scadenze** e cliccare **Enable workflow**, oppure fare una qualsiasi piccola modifica a un file del repository.

**Un familiare non riceve le notifiche.**
Controlla che abbia toccato **Attiva notifiche** nell’app installata e che Android non le blocchi (Impostazioni → App → Frigo → Notifiche). Nei telefoni con risparmio energetico aggressivo (Xiaomi, Huawei, alcuni Samsung) può servire togliere Chrome dalle ottimizzazioni della batteria.

**Qualcuno può vedere i miei dati?**
Solo chi ha fatto l’accesso **e** conosce il codice invito della tua famiglia. Il codice è casuale e lungo 10 caratteri: condividilo solo con la famiglia.

**Quanto costa?**
Niente: per una famiglia l’uso resta ampiamente dentro i limiti gratuiti di Firebase e GitHub. L’unico costo eventuale sono le ricette con la chiave Anthropic.

## Contenuto del progetto

| File | A cosa serve |
|---|---|
| `index.html`, `app.js` | L’app vera e propria |
| `config.js` | La tua configurazione Firebase (unico file da modificare) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installazione su Android, uso offline, notifiche |
| `firestore.rules` | Regole di sicurezza da incollare in Firebase |
| `notifier/` | Lo script che ogni mattina manda le notifiche |
| `.github/workflows/notifiche.yml` | L’orario in cui GitHub lancia lo script |
