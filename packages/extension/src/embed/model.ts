/**
 * The sentence-embedding model for meaning-based feedback matching: all-MiniLM-L6-v2 (Apache-2.0,
 * 384 dimensions) in Xenova's ONNX export, int8-quantised. Pinned to one revision; every file is
 * checked against its SHA-256 before it is saved, so a changed or damaged download is refused.
 * Downloaded once from huggingface.co (which allows extension origins via CORS: no host permission).
 */
export const MODEL = {
  name: 'Xenova/all-MiniLM-L6-v2',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  dims: 384,
  maxTokens: 256,
  files: [
    { path: 'tokenizer.json', sha256: 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0' },
    { path: 'tokenizer_config.json', sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3' },
    { path: 'onnx/model_quantized.onnx', sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1', bytes: 22_972_370 },
  ],
} as const;

export type ModelFiles = Record<(typeof MODEL.files)[number]['path'], Uint8Array>;

export const modelUrl = (path: string): string => `https://huggingface.co/${MODEL.name}/resolve/${MODEL.revision}/${path}`;

export async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Downloads and verifies every file; nothing is returned (or saved) unless all of them match. */
export async function downloadModel(doFetch: typeof fetch, onProgress?: (bytes: number) => void): Promise<ModelFiles> {
  const out: Partial<ModelFiles> = {};
  let total = 0;
  for (const f of MODEL.files) {
    const res = await doFetch(modelUrl(f.path), { credentials: 'omit' });
    if (!res.ok) throw new Error(`Hugging Face answered ${res.status} for ${f.path}`);
    const data = new Uint8Array(await res.arrayBuffer()) as Uint8Array<ArrayBuffer>;
    if ((await sha256Hex(data)) !== f.sha256) throw new Error(`${f.path} did not match its expected checksum, so it was not saved`);
    out[f.path] = data;
    total += data.length;
    onProgress?.(total);
  }
  return out as ModelFiles;
}

const DB = 'repospector-models';
const STORE = 'files';
const KEY = `${MODEL.name}@${MODEL.revision}`;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const r = fn(db.transaction(STORE, mode).objectStore(STORE));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}

export const saveModel = (files: ModelFiles): Promise<IDBValidKey> => tx('readwrite', (s) => s.put(files, KEY));
export const loadModel = async (): Promise<ModelFiles | undefined> => (await tx('readonly', (s) => s.get(KEY))) as ModelFiles | undefined;
export const deleteModel = (): Promise<undefined> => tx('readwrite', (s) => s.clear());
