import { createHash } from "node:crypto";
import { EMBEDDING_DIM } from "@elevate/db";

export interface Embedder {
  readonly name: string;
  embed(texts: string[]): Promise<number[][]>;
}

const STOP = new Set(
  "a an and are as at be by for from has have in into is it its of on or that the this to was were will with we our you your can using use via new how what why not".split(
    " ",
  ),
);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+#.\- ]+/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^[.\-]+|[.\-]+$/g, ""))
    .filter((t) => t.length > 1 && !STOP.has(t));
}

function bucket(feature: string): { index: number; sign: number } {
  const h = createHash("md5").update(feature).digest();
  return { index: h.readUInt32LE(0) % EMBEDDING_DIM, sign: h[4]! & 1 ? 1 : -1 };
}

/**
 * Offline embedder: signed feature hashing over unigrams, bigrams and character trigrams,
 * L2-normalised. Good enough for topical similarity; swap in OpenAIEmbedder for quality.
 */
export class HashingEmbedder implements Embedder {
  readonly name = "hashing";
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const v = new Array<number>(EMBEDDING_DIM).fill(0);
      const toks = tokens(text);
      const add = (f: string, w: number) => {
        const { index, sign } = bucket(f);
        v[index]! += sign * w;
      };
      toks.forEach((t, i) => {
        add(`u:${t}`, 1);
        if (i > 0) add(`b:${toks[i - 1]} ${t}`, 0.7);
        if (t.length > 4) for (let j = 0; j + 3 <= t.length; j++) add(`c:${t.slice(j, j + 3)}`, 0.15);
      });
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  }
}

export class OpenAIEmbedder implements Embedder {
  readonly name = "openai";
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.openai.com/v1",
    private readonly model = "text-embedding-3-small",
  ) {}
  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: texts.map((t) => t.slice(0, 8000)), dimensions: EMBEDDING_DIM }),
    });
    if (!res.ok) throw new Error(`Embedding request failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { data: { embedding: number[] }[] };
    return body.data.map((d) => d.embedding);
  }
}

export function defaultEmbedder(): Embedder {
  return process.env.OPENAI_API_KEY ? new OpenAIEmbedder(process.env.OPENAI_API_KEY) : new HashingEmbedder();
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
