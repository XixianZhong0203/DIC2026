// Eval-only preload (loaded via NODE_OPTIONS="--import" into the spawned server process;
// no product file is modified). Redirects fetch() calls aimed at the configured model
// endpoint (EVAL_FETCH_REDIRECT_FROM) to a local recording endpoint (EVAL_FETCH_REDIRECT_TO):
//   - fixture mode: the local endpoint answers deterministically (canned);
//   - model mode:   the local endpoint records the request, then forwards upstream.
// This is how the runner observes the exact model request the server builds
// (system prompt + history), which is where prompt-level isolation is proven.
//
// Prefix semantics: the part of the URL after EVAL_FETCH_REDIRECT_FROM is appended
// verbatim to EVAL_FETCH_REDIRECT_TO (new URL() would drop a base path component,
// e.g. "/v1", when resolving a root-relative path — so we concatenate strings).

const from = process.env.EVAL_FETCH_REDIRECT_FROM;
const to = process.env.EVAL_FETCH_REDIRECT_TO;
if (from && to) {
  const targetUrl = new URL(from).toString();
  const toBase = to.replace(/\/$/, '');
  const origFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (typeof url === 'string' && url.startsWith(targetUrl)) {
      return origFetch(toBase + url.slice(targetUrl.length), init);
    }
    return origFetch(input, init);
  };
}
