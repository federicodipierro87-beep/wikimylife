import type { PrismaClient } from "@prisma/client";
import { SEED_IDS } from "./config.js";
import { createProcedure, type ProcedureBlueprint } from "./support.js";

/**
 * Procedura B — il caso imperfetto, che e' quello che dimostra le regole.
 *
 * "Ripristinare la VPN aziendale dopo il cambio password": LAVORO,
 * DA_RIVEDERE, `contieneDatiSensibili: true`, e una sola Execution con esito
 * `CAMBIATA`.
 *
 * Serve a fissare due comportamenti che sarebbe facile sbagliare in Fase 2:
 *
 * 1. `ultimaVerifica` resta `null` pur esistendo una esecuzione. La §8 dice che
 *    una esecuzione `CAMBIATA` riporta la scheda a `DA_RIVEDERE`: e' il
 *    contrario di una verifica di freschezza, quindi non puo' aggiornarla.
 * 2. `volteEseguita` vale comunque 1, perche' conta le esecuzioni, non i
 *    successi. Le due colonne misurano cose diverse e qui divergono — se un
 *    giorno qualcuno le confondera', questa riga di seed lo fara' fallire.
 *
 * Nessun costo: `costoTotaleCent` viene 0, che e' diverso da `null` e va bene
 * cosi' (la procedura e' gratis, non "di costo ignoto").
 */

const blueprint: ProcedureBlueprint = {
  id: SEED_IDS.procedureB,
  userId: SEED_IDS.user,
  titolo: "Ripristinare la VPN aziendale dopo il cambio password",
  trigger: "Quando la VPN smette di connettersi subito dopo aver cambiato la password di dominio",
  esito: "Connessione VPN di nuovo attiva con le nuove credenziali",
  validitaEsito: "Fino al prossimo cambio password obbligatorio, ogni novanta giorni",
  luogoNome: null,
  luogoDettaglio: "Da remoto, serve solo la rete di casa",
  latitude: null,
  longitude: null,
  scope: "LAVORO",
  status: "DA_RIVEDERE",
  // Menziona nomi di sistemi interni e un contatto: la §5 chiede di marcarla.
  contieneDatiSensibili: true,
  tags: ["it", "vpn", "lavoro"],

  prereqs: [
    { descrizione: "Nuova password di dominio gia' impostata e funzionante sul portale", tipo: "CREDENZIALE", obbligatorio: true },
    { descrizione: "App dell'autenticatore con il token aziendale gia' registrato", tipo: "STRUMENTO", obbligatorio: true },
    { descrizione: "Numero dell'help desk interno, nel caso il profilo vada ricreato", tipo: "PERSONA", obbligatorio: false },
  ],

  steps: [
    {
      ordine: 1,
      azione: "Chiudere completamente il client VPN, non solo disconnettere",
      dettaglio: "Va terminato anche dall'area di notifica, altrimenti tiene in cache le credenziali vecchie",
      durataStimataMin: 2,
    },
    {
      ordine: 2,
      azione: "Cancellare le credenziali salvate dal gestore delle credenziali di Windows",
      dettaglio: "Voce generica che inizia con il nome del concentratore VPN",
      durataStimataMin: 5,
    },
    {
      ordine: 3,
      azione: "Riaprire il client e connettersi con la nuova password piu' il codice dell'autenticatore",
      dettaglio: "Password e codice vanno concatenati senza spazi nello stesso campo",
      durataStimataMin: 3,
    },
    {
      ordine: 4,
      azione: "Se rifiuta ancora, chiedere all'help desk di forzare la risincronizzazione del profilo",
      // Qui la durata e' davvero ignota: dipende dalla coda dell'help desk.
      // `null` e' un'informazione, non un buco da riempire con uno zero.
      dettaglio: "Passaggio non sempre necessario, dipende da quanto e' vecchio il profilo",
      durataStimataMin: null,
    },
  ],

  pitfalls: [
    {
      descrizione:
        "Tre tentativi con la password vecchia bloccano l'account di dominio per trenta minuti e a quel punto non si entra piu' da nessuna parte",
      gravita: "BLOCCANTE",
    },
    {
      descrizione: "Il codice dell'autenticatore va inserito nello stesso campo della password, non in un campo separato: non e' scritto da nessuna parte",
      gravita: "NOTA",
    },
  ],

  costs: [],

  refs: [
    { tipo: "SISTEMA", valore: "Client VPN aziendale, profilo 'sede-remota'" },
    { tipo: "TELEFONO", valore: "Help desk interno, interno 4400" },
  ],

  executions: [
    {
      eseguitaIl: new Date("2026-02-20T07:50:00.000Z"),
      esito: "CAMBIATA",
      nota: "Hanno spostato l'autenticazione sul nuovo portale: il passo 2 non serve piu' e il 3 e' diverso. Da riscrivere.",
    },
  ],
};

export async function seedProcedureB(prisma: PrismaClient): Promise<void> {
  await createProcedure(prisma, blueprint);
}
