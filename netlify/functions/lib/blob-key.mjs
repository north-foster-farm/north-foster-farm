// A Blobs key as it goes into a request path (#758). @netlify/blobs
// 11.1.0 puts the key into the URL raw (getFinalRequest), so a "+"
// reached one route as a "+" and the other as a space, and "%", "#"
// and "?" would be read as an escape, a fragment and a query. Each "/"
// segment is percent-encoded, the "/" between them kept, so every
// route names the same blob for the same key. The server decodes the
// path, so the key it stores, and the key `list` hands back, is the
// key as given: a listed key goes back into `get` unchanged.
export const keyPath = (key) => String(key).split("/")
  .map(encodeURIComponent).join("/");
