import { useEffect, useState } from "react";
import { apiClient } from "../api";
import { messaggioDi } from "../session";

/**
 * Il player dell'audio originale.
 *
 * `<audio src="/api/…">` non funzionerebbe: quell'URL vuole
 * `Authorization: Bearer`, e un tag non manda intestazioni. Quindi i byte si
 * scaricano con il client, che l'intestazione la mette, e diventano un object
 * URL locale.
 *
 * L'object URL va revocato. Non farlo tiene il blob in memoria finche' la
 * scheda non si chiude, e su un'app dove ogni audio pesa qualche megabyte
 * bastano dieci schede aperte per farla morire su un telefono.
 *
 * Il download parte solo quando qualcuno lo chiede. La §3 dice che l'audio deve
 * essere sempre accessibile, non sempre scaricato: aprire una scheda sotto rete
 * mobile non deve costare tre megabyte che nessuno ascoltera'.
 */
export function AudioPlayer({ recordingId }: { recordingId: string }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null);
  const [attesa, setAttesa] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);

  useEffect(() => {
    if (src === null) {
      return;
    }
    return () => {
      URL.revokeObjectURL(src);
    };
  }, [src]);

  // Cambiando registrazione il vecchio audio non deve restare appeso sotto il
  // nuovo player.
  useEffect(() => {
    setSrc(null);
    setErrore(null);
  }, [recordingId]);

  async function carica(): Promise<void> {
    setAttesa(true);
    setErrore(null);
    try {
      const blob = await apiClient.getRecordingAudio(recordingId);
      setSrc(URL.createObjectURL(blob));
    } catch (error: unknown) {
      setErrore(messaggioDi(error));
    } finally {
      setAttesa(false);
    }
  }

  if (src !== null) {
    return <audio className="player" src={src} controls autoPlay preload="auto" />;
  }

  return (
    <div className="player-carica">
      <button
        type="button"
        className="bottone bottone--piatto"
        disabled={attesa}
        onClick={() => {
          void carica();
        }}
      >
        {attesa ? "Scarico…" : "▶ Ascolta l'originale"}
      </button>
      {errore !== null && (
        <p className="avviso avviso--errore" role="alert">
          {errore}
        </p>
      )}
    </div>
  );
}
