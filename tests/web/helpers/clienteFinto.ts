import type { ApiClient } from "@wikimylife/shared";

/**
 * Un `ApiClient` che non sa fare niente, tranne quello che il caso gli insegna.
 *
 * Ventisette metodi, e ogni test ne usa due o tre. La tentazione e' un finto
 * che risponde a tutto con dei valori plausibili, ed e' la scelta che rende
 * inutile il test: una schermata che chiama una rotta sbagliata riceverebbe
 * comunque una risposta valida, e il caso passerebbe verificando la cosa
 * sbagliata.
 *
 * Qui il predefinito e' l'opposto: ogni metodo non insegnato lancia col proprio
 * nome dentro. Se una schermata chiama `getProcedure` dove doveva chiamare
 * `proposeRedaction`, il test si ferma e dice quale.
 *
 * Il lancio e' sincrono e non una promessa rifiutata, ed e' voluto. Una
 * promessa rifiutata finirebbe dentro `useAsync`, diventerebbe uno stato
 * `errore` e comparirebbe come un avviso rosso in pagina: cioe' come uno degli
 * stati che questi test verificano di proposito. Un finto che si confonde con
 * un caso legittimo e' peggio di nessun finto.
 *
 * Non c'e' nessuna registrazione delle chiamate: chi vuole contarle chiude una
 * variabile dentro la funzione che passa, che e' cio' che serve nei tre o
 * quattro casi in cui serve, e si legge senza dover sapere cosa sia uno spy.
 */

function nonPrevista(nome: string): never {
  throw new Error(
    `Il test non ha previsto ApiClient.${nome}(): o la schermata chiama la rotta sbagliata, o il finto va completato.`,
  );
}

export function creaClienteFinto(risposte: Partial<ApiClient> = {}): ApiClient {
  const base: ApiClient = {
    health: () => nonPrevista("health"),
    signup: () => nonPrevista("signup"),
    login: () => nonPrevista("login"),
    me: () => nonPrevista("me"),
    refresh: () => nonPrevista("refresh"),
    logout: () => nonPrevista("logout"),
    changePassword: () => nonPrevista("changePassword"),
    revokeOtherSessions: () => nonPrevista("revokeOtherSessions"),
    listSessions: () => nonPrevista("listSessions"),
    getAccessToken: () => nonPrevista("getAccessToken"),
    restoreSession: () => nonPrevista("restoreSession"),
    createRecording: () => nonPrevista("createRecording"),
    listPendingRecordings: () => nonPrevista("listPendingRecordings"),
    getRecording: () => nonPrevista("getRecording"),
    retryRecording: () => nonPrevista("retryRecording"),
    deleteRecording: () => nonPrevista("deleteRecording"),
    getRecordingAudio: () => nonPrevista("getRecordingAudio"),
    listProcedures: () => nonPrevista("listProcedures"),
    getProcedure: () => nonPrevista("getProcedure"),
    updateProcedure: () => nonPrevista("updateProcedure"),
    archiveProcedure: () => nonPrevista("archiveProcedure"),
    deleteProcedureForever: () => nonPrevista("deleteProcedureForever"),
    emptyTrash: () => nonPrevista("emptyTrash"),
    recordExecution: () => nonPrevista("recordExecution"),
    proposeRedaction: () => nonPrevista("proposeRedaction"),
    applyRedaction: () => nonPrevista("applyRedaction"),
    search: () => nonPrevista("search"),
  };

  return { ...base, ...risposte };
}
