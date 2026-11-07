# Potion static embeddings

`PotionModel.ts` implements mean-pooled static WordPiece embeddings for the
English `minishlab/potion-base-8M` model. Hugging Face's
[`@huggingface/tokenizers`](https://github.com/huggingface/tokenizers.js) owns
tokenization; the pooling and L2 normalization follow
[`Model2Vec`](https://github.com/MinishLab/model2vec). Its MIT attribution is in
`POTION-LICENSE`. The tokenizer package carries its own Apache-2.0 license.

`potionModelManifest.ts` pins the official Hugging Face revision and the size and
SHA-256 of each asset. `bun server/scripts/download-potion.ts --output <directory>`
downloads those assets during packaging. Runtime reads only the supplied asset
directory, verifies all four files, and validates the F32 tensor dimensions and
bounds. It never downloads a model. The files total 30,922,059 bytes; inference
requires no Python, ONNX runtime, or transformer model.

Create one `PotionModel(assetDirectory)` and reuse it. The first `encode(texts)`
loads the model; concurrent calls share that load. After the last active encode
finishes, `PotionModelIdleTimeoutMs` releases the cached weights/tokenizer after
five minutes without another encode. The next request loads and verifies the
assets again. A failed encode remains visible to its caller; the next request can
retry loading. Release drops the references, while RSS reclamation depends on
the runtime garbage collector and allocator. No forced collection is performed. Each result is a 256-dimensional normalized
vector. Empty input or input containing only unknown tokens produces a zero
vector, matching Model2Vec. Encoding yields the event loop after every 100 texts.

The official tokenizer handles punctuation, Unicode normalization, and subwords.
No special tokens are inserted, and unknown tokens are removed before pooling.
This is a static bag-of-tokens model: it does not model word order or provide the
contextual reasoning of a transformer. Tunarr owns the descriptive text, when to
recompute or remove vectors, and how recommendations use them. Changing either
the model identity or the input policy requires rebuilding the affected vectors.

A direct Bun parity exercise compared all 1,733 full descriptions from the
existing external Model2Vec trial. Token IDs matched exactly. The JavaScript
pooling produced a minimum cosine of 0.999999999999891 and maximum component
difference of 1.79e-7 against the reference vectors. This establishes numerical
parity for that corpus; it does not establish recommendation quality for unseen
libraries or other languages.

## Index ownership and runtime

`MeilisearchService` owns one `PotionEmbeddingServer` in the main process when
`TUNARR_POTION_ENABLED=true`. The loopback-only REST adapter starts before
Meilisearch settings sync, because the public API starts after indexing. Its
listener starts without warming the model. Existing vectors can be searched
without loading it; fresh or changed descriptions load it through the REST
embedder. Hash/tensor validation therefore occurs on first use, not listener
startup. The port persists in `potion-port` under the configured database directory: changing
the endpoint URL would make Meili recompute every vector. A conflicting port is
a visible startup failure. Worker threads use Meili without loading another
model. Disabling the setting removes the embedder and its vectors.

Meili's automatic REST embedder owns generation and invalidation on the existing
`programs` documents. The Liquid template joins nonempty title, genres, tags and
summary (falling back to plot), matching the external trial recipe. Only changes
to the rendered description regenerate vectors. State/path-only updates retain
them, `state = ok` limits candidate retrieval, and the existing permanent-delete
paths remove the documents and vectors together. Non-show/movie writers set
`_vectors.potion = null`; initial enablement suppresses existing non-source rows
before installing the embedder. No second catalog, vector cache, identity graph
or SQLite migration is involved.

The embedder URL includes the pinned model revision and encoder revision; bump
the encoder revision if tokenization or pooling changes. Template changes also
trigger Meili regeneration. `documentTemplateMaxBytes` is 32 KiB, so longer
descriptions are truncated by Meili. Search uses Meili's approximate nearest
neighbor index; ordering can differ from an exhaustive cosine sort, particularly
for ties or nearly equal scores.
