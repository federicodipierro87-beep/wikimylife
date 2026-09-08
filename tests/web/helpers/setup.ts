import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * Smontare quello che si e' montato, dopo ogni caso.
 *
 * Non e' pulizia di cortesia. `PendingRecordings` monta un `setInterval` che
 * chiama il client ogni cinque secondi: senza `cleanup`, quel componente resta
 * nel documento anche dopo la fine del caso, e continua a chiamare il finto di
 * quel caso mentre ne sta girando un altro. Il fallimento arriva altrove, con
 * un conteggio di chiamate sbagliato in un test che non c'entra niente — ed e'
 * la categoria di guasto piu' costosa da capire, perche' il file da guardare
 * non e' quello che fallisce.
 *
 * `@testing-library/react` lo farebbe da solo se i globali di Vitest fossero
 * accesi. Qui non lo sono — i test importano `describe` e `it` esplicitamente,
 * come tutti gli altri file di questo repository — quindi la registrazione va
 * scritta a mano.
 */
afterEach(() => {
  cleanup();
});
