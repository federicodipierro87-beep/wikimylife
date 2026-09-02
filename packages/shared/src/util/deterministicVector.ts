/**
 * Vettore unitario deterministico ricavato da una stringa.
 *
 * A cosa serve: il seed e i test devono produrre embedding senza chiamare
 * OpenAI. Nessuna chiave API per popolare un database di sviluppo, nessuna
 * suite che fallisce perche' un fornitore ha un disservizio.
 *
 * Cosa NON e': una funzione semantica. Due frasi sinonime danno vettori
 * ortogonali. Va benissimo cosi': serve a verificare le meccaniche (dimensione,
 * norma, operatore coseno, indice HNSW), non la qualita' del recupero.
 *
 * FNV-1a per il seed, mulberry32 come PRNG, Box-Muller per una distribuzione
 * gaussiana — che su una sfera in 1536 dimensioni da' direzioni uniformi, quindi
 * coppie di testi diversi cadono intorno a similarita' 0 e restano ben sotto la
 * soglia di dedup di 0.85.
 *
 * Solo aritmetica: nessun `node:crypto`, nessuna `SubtleCrypto`. Gira
 * identica in Node, nel browser e in React Native.
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function fnv1a32(text: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
    // I code point sopra 255 contribuiscono anche col byte alto: senza questo,
    // "citta'" e "citta" collidono piu' spesso di quanto sia ragionevole.
    const high = text.charCodeAt(i) >>> 8;
    if (high !== 0) {
      hash ^= high;
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
    }
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Vettore di norma 1 con `dimensions` componenti, funzione pura di `text`.
 */
export function deterministicUnitVector(text: string, dimensions: number): number[] {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new RangeError(`dimensions deve essere un intero positivo, ricevuto ${dimensions}`);
  }

  const random = mulberry32(fnv1a32(text) ^ 0x9e3779b9);
  const values = new Array<number>(dimensions);

  for (let i = 0; i < dimensions; i += 1) {
    // Box-Muller. `1 - random()` evita log(0).
    const u1 = 1 - random();
    const u2 = random();
    values[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  let sumOfSquares = 0;
  for (let i = 0; i < dimensions; i += 1) {
    const v = values[i] ?? 0;
    sumOfSquares += v * v;
  }
  const norm = Math.sqrt(sumOfSquares);
  if (norm === 0) {
    // Irraggiungibile con Box-Muller, ma un vettore nullo mandera' in errore
    // l'operatore coseno di pgvector: meglio un fallback esplicito.
    const fallback = new Array<number>(dimensions).fill(0);
    fallback[0] = 1;
    return fallback;
  }

  for (let i = 0; i < dimensions; i += 1) {
    values[i] = (values[i] ?? 0) / norm;
  }
  return values;
}

/** Similarita' coseno. Su vettori unitari coincide col prodotto scalare. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new RangeError(`dimensioni incompatibili: ${a.length} contro ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

/**
 * Letterale `vector` di pgvector.
 *
 * Va sempre passato come PARAMETRO bindato e castato — mai concatenato:
 *   prisma.$executeRaw`UPDATE "Procedure" SET embedding = ${literal}::vector ...`
 */
export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}
