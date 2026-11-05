// Tipo condiviso per un modello restituito dall'API (serializzato via superjson).
export interface ModelItemDTO {
  id: number;
  name: string;
  mode: string;
  glbKey: string;
  photoKey: string;
  vertices: number;
  triangles: number;
  sizeBytes: number;
  /** ready | processing | failed — la generazione AI è asincrona */
  status: string;
  error: string | null;
  createdAt: Date;
  provider: string | null;
  providerModel: string | null;
  providerLabel: string | null;
  quality: string | null;
  target: string | null;
  views: number;
  progress: number;
  stage: string | null;
  previewKey: string | null;
  previewUrl: string | null;
  glbUrl: string | null;
  photoUrl: string | null;
}
