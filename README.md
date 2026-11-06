# Kalco3D

*Photo to 3D* — dalla foto al modello 3D, pronto per web, AR, render e stampa.

Web app full-stack che trasforma una foto in un modello 3D esplorabile e scaricabile in formato GLB.

## Come funziona

1. **Upload** — carichi una foto dal dispositivo (drag & drop o selezione), oppure parti dagli esempi procedurali (luna per i paesaggi, vaso per gli oggetti).
2. **Ritaglio del soggetto** — con "Ritaglia oggetto dallo sfondo" attivo, il browser stima il colore dello sfondo dai bordi e lo rimuove con un flood-fill tollerante (soglia regolabile, anteprima live della sagoma). Pensato per foto di oggetti su sfondo abbastanza uniforme.
3. **Heightmap** — due strategie:
   - **Con ritaglio (oggetti)**: la forma nasce dalla sagoma — cupola calcolata con distance transform dal bordo, più il dettaglio di superficie dalla luminanza ad alta frequenza. L'illuminazione e le ombre della foto non deformano più la forma.
   - **Senza ritaglio (paesaggi/superfici)**: luminanza classica come mappa di profondità, con levigatura regolabile.
4. **Mesh** — il server costruisce la geometria (TypeScript puro, `api/lib/glb.ts`) in tre modalità:
   - **Rilievo** — segue la sagoma del soggetto (i quad di sfondo vengono tagliati); con "Volume chiuso fronte/retro" aggiunge il guscio posteriore speculare e i vertici di bordo vanno a quota zero, così il solido si sigilla sul perimetro;
   - **Sfera** — la foto avvolge e deforma una sfera;
   - **Cilindro** — effetto litofania avvolta su un cilindro.
5. **GLB** — la mesh viene serializzata in glTF 2.0 binario; con il ritaglio la texture è PNG con alpha cutout e i colori del soggetto vengono diffusi oltre il bordo (niente alone chiaro). Salvataggio in Supabase Storage (bucket privato, una cartella per utente), metadati in Postgres su Supabase.
6. **Generazione AI multi-motore** (`api/ai3d/`) — il servizio principale. Il cliente carica la foto frontale (obbligatoria) e fino a 3 viste extra (sinistra, retro, destra), sceglie **destinazione** (e-commerce/AR, stampa 3D, render, gioco) e **qualità** (bozza, standard, pro). Prima dell'invio il browser controlla ogni foto (`src/lib/photoCheck.ts`): risoluzione, sfocatura, esposizione, riflessi, soggetto tagliato o troppo piccolo. La "ricetta" dei parametri per ogni combinazione è in `api/ai3d/plan.ts`. Motori supportati, con ripiego automatico se uno fallisce: **Tripo** (H3.1 e P2 low-poly), **Rodin Gen-2**, **Hunyuan3D 3.1 Pro** e **TRELLIS.2** via fal.ai, **Meshy**. Il job salva in DB avanzamento e fase; la galleria li mostra in tempo reale con la miniatura renderizzata dal motore.
7. **Viewport** — visualizzatore Three.js con orbit controls, wireframe, rotazione automatica; download del `.glb` con un click.
8. **Motore di scultura** (`src/three/sculpt.ts`) — i vertici nella stessa posizione (cuciture UV dei GLB AI, perimetro del volume chiuso) vengono saldati e si muovono insieme: niente crepe. BVH (`three-mesh-bvh`) per raycast e ricerca nel raggio, pennellate distanziate (spacing), normale d'area per Alza/Abbassa, Gonfia lungo la normale, Leviga con metodo Taubin (non sgonfia il volume), simmetria X, annulla su modelli con più mesh. Test: `npm test`.
9. **Rendering** — luce ambientale (IBL), tone mapping Khronos PBR Neutral, ombre morbide della luce principale, pavimento appoggiato sotto il modello.
10. **Editing stile "programma 3D"** — toolbar nel viewport: gizmo Sposta/Ruota/Scala (TransformControls), pennelli scultura Alza/Abbassa/Leviga/Pizzica/Appiattisci con raggio e intensità, viste camera Fronte/Lato/Alto/ISO. **Cronologia annulla/ripeti** (Ctrl+Z / Ctrl+Maiusc+Z o pulsanti nella barra del viewport) per scultura e trasformazioni, fino a 40 passi.
11. **Stile (ispirato a Vizcom)** — preset materiale (foto, marmo, grafite, arancio, metallo, oro), metallico/rugosità, texture on/off; scena con 4 preset luci e 3 sfondi.
12. **Esporta** — GLB, **STL in millimetri con Z in alto** (pronto per lo slicer, appoggiato sul piano), **USDZ in scala reale** per l'AR su iPhone/iPad, e controllo di stampabilità (bordi aperti e spigoli ambigui, `src/three/printCheck.ts`). Il "volume chiuso" del rilievo ora ha spessore minimo e parete laterale: è davvero stampabile; "Salva modifica in galleria" carica la versione editata come nuovo modello (`models.saveEdited`).

## Stack

- Frontend: React 19 + Vite + Tailwind + shadcn/ui, Three.js (`src/three/scene.ts`)
- Backend: Hono + tRPC 11 (`api/routers/models.ts`); ogni procedura (tranne `aiStatus`) richiede il login e lavora solo sui modelli dell'utente
- Account: Supabase Auth, accesso con link via email (opzionale Google) — `src/components/AuthGate.tsx`, verifica del token in `api/context.ts`
- Dati: Drizzle ORM + Postgres su Supabase (`db/schema.ts`, migrazione in `supabase/migrations/`), Supabase Storage con URL firmati (`api/lib/storage.ts`)

## Supabase (database, file, account)

Il progetto Supabase **Kalco3D** (Francoforte) è già creato, con la tabella `models`, le regole di sicurezza (RLS) e il bucket privato `kalco3d`. Per collegarlo:

1. Copia `.env.example` in `.env`: URL e chiave pubblicabile sono già compilati.
2. `SUPABASE_SECRET_KEY`: Supabase → Project Settings → API Keys → **Secret keys** → crea/copia la chiave `sb_secret_…`.
3. `DATABASE_URL`: Supabase → pulsante **Connect** → **Transaction pooler** (porta 6543). Se non conosci la password del database: Project Settings → Database → **Reset database password**.
4. Supabase → Authentication → **URL Configuration**: metti il dominio di produzione in *Site URL* e aggiungi `http://localhost:3000` (e il dominio) tra i *Redirect URLs*, altrimenti il link dell'email non riporta all'app.
5. Per la produzione: Authentication → **Emails → SMTP Settings** con un servizio vero (es. Resend, Brevo). L'invio email di prova di Supabase ha limiti molto bassi (poche email all'ora).

## Pubblicazione (Railway consigliato)

Le generazioni AI girano in background sul server per diversi minuti: serve un server Node sempre acceso, non funzioni "serverless" (su Vercel verrebbero interrotte). Su **Railway** (o Render):

1. Nuovo progetto → da repository GitHub (o `railway up` dalla cartella).
2. Variabili: tutte quelle di `.env` (anche le `VITE_…`, servono al momento della build).
3. Build `npm run build`, avvio `npm start` (già in `railway.json`). Railway assegna `PORT` da solo.
4. Metti il dominio pubblico nelle *URL Configuration* di Supabase (punto 4 sopra).

## Kalco3D Building (`/building`)

Grandi stampe 3D: cemento (portale, gru), pellet o bracci robot, oppure stampanti normali a pezzi.
- Modello dalla galleria o da file (STL, OBJ, GLB, STEP, DXF…), rotazioni di 90°, altezza reale in metri.
- `src/building/engine.ts`: strati con Manifold, perimetri e zig-zag, sbalzi oltre l'angolo ammesso, preventivo (materiale, tempo, costi) e G-code generico (G0/G1, E volumetrico opzionale).
- Se il modello non entra nella macchina: pezzi numerati dal basso con perni (`splitToPlate`), STL dei pezzi e pagina di montaggio.
- Dalla pianta (immagine) ai muri: `src/building/plan.ts` tiene le zone spesse del disegno (apertura morfologica con la trasformata di distanza), scarta mobili e testi, lascia i varchi di porte e finestre; scala da larghezza totale o misura nota; muri estrusi all'altezza scelta. Da fare: piante DWG/DXF.

## Immagini da testo (FLUX.2)

- Nella scheda AI, «Creala dal testo»: l'utente descrive l'oggetto e FLUX.2 [pro] su fal crea 1–4 immagini (`api/lib/imageGen.ts`).
- Il prompt viene avvolto in una ricetta per il 3D: un solo oggetto, intero, centrato, fondo neutro; per la stampa niente parti sottili.
- L'immagine scelta diventa la foto frontale. Costo: 1 credito ogni 2 immagini, rimborsato per quelle fallite. Serve `FAL_KEY`.

## Crediti e pagamenti (Stripe)

- Ogni nuovo utente riceve 20 crediti. Costi: bozza 5, standard 8, Pro 15 (anche per la stampa, che ora chiede i colori). Preparazione stampa gratis.
- Piani: Maker 19 € / 150 crediti, Pro 49 € / 450, Studio 119 € / 1300 al mese. Ricarica 15 € / 100 crediti che non scadono.
- Il saldo sta in `credit_accounts`, ogni movimento in `credit_ledger` (`supabase/migrations/0002_credits.sql`).
- Il credito si scala prima di chiamare il motore AI e torna indietro se la generazione fallisce.
- Massimo 2 generazioni contemporanee per utente.
- I crediti si accreditano **solo** dal webhook firmato `POST /api/stripe/webhook`. Gli eventi richiesti sono `checkout.session.completed`, `invoice.paid`, `customer.subscription.updated` e `customer.subscription.deleted`.
- Gli account in `ADMIN_EMAILS` generano senza scalare crediti (e possono avere il doppio delle generazioni in corso).
- Le variabili `STRIPE_*` sono in `.env.example`. Senza queste variabili i pagamenti restano spenti.

## Comandi

```bash
npm run dev      # sviluppo con HMR su http://localhost:3000
npm run build    # build produzione (dist/public + dist/boot.js)
npm start        # server produzione
npm run check    # type-check
npm test         # test
```

## Nota sull'evoluzione

Due pipeline di generazione convivono: quella **locale** (heightmap → rilievo, istantanea) e
quella **AI** (Tripo API, volumetrica, asincrona). I modelli AI arrivano nel viewport come
qualsiasi altro GLB: stessi strumenti di editing, stili, export e galleria.

## Messa in funzione dei motori AI

1. Crea almeno un account e metti la chiave in `.env` (vedi `.env.example`):
   - `TRIPO_API_KEY` — consigliato come base (https://platform.tripo3d.ai)
   - `HYPER3D_API_KEY` — Rodin, per la qualità Pro
   - `FAL_KEY` — Hunyuan3D e TRELLIS.2 (bozze economiche)
2. Alla prima generazione con ogni motore controlla `app.log` (riga `ai job done` o `ai job failed`): gli adattatori di Rodin e fal sono scritti sulla documentazione pubblica e vanno confermati con una chiave vera. Se un motore risponde in modo inatteso la pipeline passa al successivo e l'errore resta scritto nel record.

Senza nessuna chiave la generazione AI resta disattivata (l'interfaccia lo segnala); rilievo, import CAD, modifica e stampa funzionano comunque.

## Stampa 3D (scheda «Stampa», `src/print/`)

Dal modello nel viewport a un **3MF pronto per lo slicer**, tutto nel browser:

1. conversione in millimetri con Z in alto;
2. **riparazione**: saldatura, facce raddrizzate, buchi chiusi (`meshOps.ts`);
3. **colori per filamento**: i colori visibili (texture inclusa) ridotti a N filamenti in spazio Lab, macchioline ripulite (`colors.ts`);
4. **solido garantito** con [Manifold](https://github.com/elalish/manifold) (Apache-2.0): gusci sovrapposti fusi, **base** tonda/quadrata con fondo appiattito se a punta, **taglio automatico** per il piatto con facce di taglio chiuse (`solid.ts`);
5. controllo **spessore pareti** (`wall.ts`);
6. **3MF** con colori per triangolo: standard 3MF + `paint_color` (Bambu Studio / OrcaSlicer) + `slic3rpe:mmu_segmentation` (PrusaSlicer) (`threemf.ts`).

In più:

- **Modelli pronti** (Statuina, Animale, Regalo, Calamita): un clic imposta misura, colori e base.
- **Incastri sui tagli**: su ogni taglio si scavano fori ciechi allineati nelle due metà (gioco radiale 0,2 mm) e si aggiungono perni smussati da stampare a parte (Ø3–8 mm, in proporzione alla sezione). Ogni foro è verificato: se bucherebbe la superficie viene rimpicciolito o tolto, e il resoconto segnala i tagli "solo colla".
- **Calamita**: si tiene la metà frontale, il retro piatto va sul piatto di stampa e si scava la sede per un magnete Ø10×3 mm.
- **Più piatti**: i pezzi vengono distribuiti su più piatti. Nel 3MF i piatti sono in griglia con la spaziatura di Bambu Studio/OrcaSlicer (piatto + 20%); in alternativa si scarica uno zip con un 3MF per piatto, che funziona con qualunque slicer.

Nota: la codifica dei colori e la disposizione su più piatti seguono i formati di Bambu/Prusa; vanno confermate aprendo un file in Bambu Studio con la propria stampante.

## Motori AI

Aggiunto **Meshy** (`MESHY_API_KEY`, Meshy 7.1 / 6-lite per le bozze) alla pipeline multi-motore.
