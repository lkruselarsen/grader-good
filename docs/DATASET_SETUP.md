# Dataset / Embeddings Setup

## 1. Supabase CLI (optional)

To manage migrations via CLI:

```bash
# Install Supabase CLI (or use npx)
npm install -D supabase

# Link to your hosted project (get project ref from dashboard URL)
npx supabase link --project-ref ucrlqvdvyentabhvcwhj

# Apply migrations
npx supabase db push
```

Or run the SQL manually in the Supabase Dashboard → SQL Editor:

1. Run `supabase/migrations/00001_enable_pgvector.sql`
2. Enable the "vector" extension in Database → Extensions if not already enabled
3. Run `supabase/migrations/00002_create_grading_samples.sql`
4. Run `supabase/migrations/00003_match_grading_samples.sql` (RPC for tonal similarity)
5. Run `supabase/migrations/00004_semantic_embeddings.sql` (semantic embedding column + RPC)

## 2. Environment Variables

Create `.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=https://ucrlqvdvyentabhvcwhj.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
```

Get the service role key from: **Supabase Dashboard → Settings → API → service_role (secret)**

## 3. Storage Bucket

The upload API will auto-create the `grading-samples` bucket on first use. Or create it manually:

1. Dashboard → Storage → New bucket
2. Name: `grading-samples`
3. Public: Yes (so image URLs work)

## 4. Use the Dataset UI

1. Go to `/dataset`
2. Select one or more JPG/PNG reference photos
3. Each image is processed: fit LookParams, compute 32-dim tonal + 384-dim semantic (DINOv2) embeddings, upload to Storage, insert into `grading_samples`
4. First upload may take longer while the DINOv2 model (~25MB) loads in the browser

## 5. Search API (for automated workflow)

```
POST /api/dataset/search
Content-Type: application/json
Body: { "embeddingSemantic": [0.1, -0.02, ...] }  // 384 numbers from imageToSemanticEmbedding(file) - preferred
   or { "embedding": [0.1, -0.02, ...] }          // 32 numbers from imageToEmbedding(imageData) - fallback
Query: ?limit=5
```

Returns `{ matches: [{ id, name, image_url, look_params, similarity }, ...] }`.

Semantic search matches by scene/content (forest vs wall), so a forest photo finds forest references. Tonal search matches by color histogram only.

## 6. Use Embeddings on Lab Page

1. Load a source image in `/lab`
2. Click "Use embeddings"
3. The source is encoded with DINOv2 (semantic embedding)
4. The closest reference by scene similarity is found and its grading applied

## 7. Future: Automated Workflow

Once you have 200–1000 samples:

- On source upload: compute its semantic embedding via `imageToSemanticEmbedding(file)`
- Call `POST /api/dataset/search` with `embeddingSemantic`
- Apply the top match’s `look_params` to the source via `applyLook()`
