interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * UCSC Genome Browser REST API — reference genome assemblies for ~250 species, the annotation tracks on each (genes, variants, conservation, regulation), the rows of any track over a region, and raw DNA sequence. Keyless.
 *
 * Auth: none. Docs: https://genome.ucsc.edu/goldenPath/help/api.html
 * Endpoints: https://api.genome.ucsc.edu/{list,getData}/...
 */


const BASE = 'https://api.genome.ucsc.edu';
const UA = 'pipeworx-mcp-ucsc-genome/1.0 (+https://pipeworx.io)';

// Bound every outbound call — the Workers runtime puts no limit on a bare
// fetch(), so a degraded upstream would hold the Worker until its execution
// budget kills the request. The `getData/track` endpoint is the one that can
// legitimately take tens of seconds (a wide region on a dense track), so the
// bound has to be generous but it still has to exist.
async function pwFetch(url: string): Promise<Response> {
  return fetchWithTimeout(url, { headers: { Accept: 'application/json', 'User-Agent': UA } }, 'UCSC Genome Browser API');
}

// The single most dangerous argument in this pack. hg19 (GRCh37) and hg38
// (GRCh38) are DIFFERENT coordinate systems for the same human genome, and
// every position is valid in both — so a wrong assembly never errors, it
// returns confident annotations for a different locus. The classic example is
// BRCA1: chr17:41,196,311-41,277,500 is BRCA1 in hg19 and lands in a
// completely different neighbourhood in hg38 (BRCA1 sits near
// chr17:43,044,295-43,170,245 there). Published tables, dbSNP exports and most
// clinical spreadsheets older than ~2018 are hg19. There is no default and no
// inference: the argument is required on every tool that takes a coordinate.
const ASSEMBLY_DESC =
  'REQUIRED. UCSC assembly ID — the genome build your coordinates are in. Human: "hg38" (= GRCh38, current) or "hg19" (= GRCh37, what most older papers, dbSNP dumps and clinical spreadsheets use). Mouse: "mm39"/"mm10". These are DIFFERENT coordinate systems: the same chrom/start/end is valid in every build, so a wrong build returns confident annotations for a different gene instead of an error. Call ucsc_genomes to list the assembly IDs for a species.';

// UCSC's API is 0-based half-open, and the Genome Browser UI is 1-based
// inclusive — so a position copy-pasted out of the browser is off by one at the
// start. Say so on every coordinate argument rather than in a doc nobody reads.
const START_DESC =
  'Start position, 0-BASED and inclusive. The Genome Browser UI and most papers are 1-based, so subtract 1 from a position you copied out of the browser location box.';
const END_DESC = 'End position, 0-based and EXCLUSIVE (so end - start = length in bases).';

const tools: McpToolExport['tools'] = [
  {
    name: 'ucsc_genomes',
    description:
      '"What genome assemblies does UCSC have for [species]" / "is hg38 or hg19 the current human build" / "what is the latest [mouse/zebrafish/dog] assembly" / "list UCSC genomes" — AUTHORITATIVE list of every reference assembly the UCSC Genome Browser serves (~250 species), with its UCSC assembly ID (hg38, mm39, danRer11...), organism, scientific name, source assembly name and release date. PREFER OVER WEB SEARCH when you need the exact assembly ID to pass to another genomics tool — the ID is the thing every other UCSC call keys on, and guessing it is how a query silently lands on the wrong build.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        search: {
          type: 'string',
          description:
            'Case-insensitive substring filter over assembly ID, common name, scientific name and description. e.g. "human", "Mus musculus", "hg". Omit to list everything.',
        },
        limit: { type: 'number', description: 'Max assemblies to return (default 50, max 400).' },
      },
      required: [],
    },
  },
  {
    name: 'ucsc_tracks',
    description:
      '"What annotation tracks does UCSC have for hg38" / "does [assembly] have a [ClinVar/GENCODE/conservation/repeat] track" / "what is the track name for [dataset] in the genome browser" — lists the annotation tracks available on one UCSC assembly, with each track\'s internal name, short and long label, data type and parent container. AUTHORITATIVE for the `track` argument of ucsc_track_data: the browser shows human-readable labels, the API wants the internal name (e.g. label "GENCODE V50" is track `knownGene`), and there is no way to guess one from the other.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        genome: { type: 'string', description: ASSEMBLY_DESC },
        search: {
          type: 'string',
          description: 'Case-insensitive substring filter over track name, short label and long label. e.g. "clinvar", "gencode", "conservation".',
        },
        limit: { type: 'number', description: 'Max tracks to return (default 100, max 1000).' },
      },
      required: ['genome'],
    },
  },
  {
    name: 'ucsc_track_data',
    description:
      '"What genes are in [chr:start-end]" / "list ClinVar variants in [region]" / "what repeats/SNPs/regulatory elements overlap [locus]" / "show me the GENCODE annotations across [gene]" — AUTHORITATIVE per-row data from any UCSC annotation track over a genomic interval. Returns the actual track rows (gene models with exon structure, variant records, conservation scores, whatever that track holds) plus the track type and the assembly the rows are in. PREFER OVER WEB SEARCH for "what is annotated at this position" — this is the same data the Genome Browser draws, not a description of it. Get the `track` name from ucsc_tracks first.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        genome: { type: 'string', description: ASSEMBLY_DESC },
        track: {
          type: 'string',
          description: 'UCSC internal track name from ucsc_tracks, e.g. "knownGene" (GENCODE genes), "refGene" (RefSeq genes), "clinvarMain", "rmsk" (repeats).',
        },
        chrom: { type: 'string', description: 'Chromosome in UCSC naming, e.g. "chr17", "chrX", "chrM" — with the "chr" prefix. Ensembl/NCBI style bare "17" is not accepted by UCSC.' },
        start: { type: 'number', description: START_DESC },
        end: { type: 'number', description: END_DESC },
        maxItemsOutput: { type: 'number', description: 'Cap on rows returned by UCSC (default 1000). A dense track over a wide region is truncated, and the response says so in `truncated`.' },
      },
      required: ['genome', 'track', 'chrom', 'start', 'end'],
    },
  },
  {
    name: 'ucsc_sequence',
    description:
      '"What is the DNA sequence at [chr:start-end]" / "get the reference bases for [region] in hg38" / "pull the sequence around [variant position]" — AUTHORITATIVE reference DNA for a genomic interval from the UCSC assembly, returned as a plain base string with its GC content. Use it to check what the reference allele actually is at a position, to extract primer/probe context, or to pull a promoter or exon sequence. The assembly argument is required because the same coordinates return different bases in hg19 and hg38.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        genome: { type: 'string', description: ASSEMBLY_DESC },
        chrom: { type: 'string', description: 'Chromosome in UCSC naming, e.g. "chr7", "chrX". The "chr" prefix is required.' },
        start: { type: 'number', description: START_DESC },
        end: { type: 'number', description: END_DESC },
        revComp: { type: 'boolean', description: 'Return the reverse complement — for a gene on the minus strand, this is the sense strand. Default false.' },
      },
      required: ['genome', 'chrom', 'start', 'end'],
    },
  },
];

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`Required argument "${key}" is missing. Pass a string like ${example}.`);
  }
  return v.trim();
}

function reqNum(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) {
    throw new Error(`Required argument "${key}" is missing or not a number. UCSC coordinates are 0-based half-open integers.`);
  }
  return Math.trunc(n);
}

function clampNum(v: unknown, def: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.trunc(n), max);
}

// UCSC answers a bad assembly / bad track with a 400 carrying a useful
// `error` string. Surface that string rather than a bare status — "hg19 is not
// a valid track for genome hg38" is the whole diagnosis.
async function ucscGet(path: string): Promise<Record<string, unknown>> {
  const res = await pwFetch(`${BASE}${path}`);
  // httpError mines the body for UCSC's own explanation ("hg19 is not a valid
  // track for genome hg38") without handing the caller raw markup.
  if (!res.ok) throw await httpError(res, 'UCSC Genome Browser API');
  const body = await parseJson<Record<string, unknown>>(res, 'UCSC Genome Browser API');
  // A 200 carrying an `error` key: UCSC does this for some malformed requests,
  // and an unchecked caller reads it as an empty result rather than a mistake.
  if (typeof body.error === 'string') throw new Error(`UCSC Genome Browser API: ${body.error}`);
  return body;
}

const SOURCE = 'UCSC Genome Browser REST API (api.genome.ucsc.edu)';

function matches(needle: string | undefined, ...hay: unknown[]): boolean {
  if (!needle) return true;
  const n = needle.toLowerCase();
  return hay.some((h) => typeof h === 'string' && h.toLowerCase().includes(n));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function listGenomes(args: Record<string, unknown>): Promise<unknown> {
  const body = await ucscGet('/list/ucscGenomes');
  const raw = body.ucscGenomes;
  if (!isRecord(raw)) throw new Error('UCSC Genome Browser API: no ucscGenomes block in the response.');
  const search = typeof args.search === 'string' ? args.search.trim() : undefined;
  const limit = clampNum(args.limit, 50, 400);

  const all = Object.entries(raw).map(([id, v]) => {
    const g = isRecord(v) ? v : {};
    return {
      assembly: id,
      organism: g.organism ?? null,
      scientificName: g.scientificName ?? null,
      description: g.description ?? null,
      sourceName: g.sourceName ?? null,
      defaultPos: g.defaultPos ?? null,
      taxId: g.taxId ?? null,
      active: g.active === 1 || g.active === true,
    };
  });
  const hits = all.filter((g) => matches(search, g.assembly, g.organism, g.scientificName, g.description));
  hits.sort((a, b) => String(a.assembly).localeCompare(String(b.assembly)));

  return {
    source: SOURCE,
    search: search ?? null,
    totalAssemblies: all.length,
    matched: hits.length,
    returned: Math.min(hits.length, limit),
    assemblies: hits.slice(0, limit),
  };
}

// A composite track's subtracks are nested one level down inside the parent's
// object, keyed by subtrack name. Flatten them, or a search for "clinvar" on
// hg38 misses every subtrack of the ClinVar container and reads as "UCSC does
// not have it".
function flattenTracks(block: Record<string, unknown>, parent: string | null, out: Record<string, unknown>[]): void {
  for (const [name, v] of Object.entries(block)) {
    if (!isRecord(v)) continue;
    const hasLabel = typeof v.shortLabel === 'string' || typeof v.longLabel === 'string';
    if (hasLabel) {
      out.push({
        track: name,
        shortLabel: v.shortLabel ?? null,
        longLabel: v.longLabel ?? null,
        type: v.type ?? null,
        group: v.group ?? null,
        parent: parent ?? (typeof v.parent === 'string' ? v.parent.split(' ')[0] : null),
        itemCount: v.itemCount ?? null,
      });
    }
    // Recurse into children regardless — a container may carry labels of its
    // own and still hold subtracks.
    for (const [childName, childVal] of Object.entries(v)) {
      if (isRecord(childVal) && (typeof childVal.shortLabel === 'string' || typeof childVal.longLabel === 'string')) {
        flattenTracks({ [childName]: childVal }, name, out);
      }
    }
  }
}

async function listTracks(args: Record<string, unknown>): Promise<unknown> {
  const genome = reqStr(args, 'genome', '"hg38" (GRCh38) or "hg19" (GRCh37)');
  const body = await ucscGet(`/list/tracks?genome=${encodeURIComponent(genome)}`);
  const block = body[genome];
  if (!isRecord(block)) throw new Error(`UCSC Genome Browser API: no track block for assembly "${genome}". Check the assembly ID with ucsc_genomes.`);

  const flat: Record<string, unknown>[] = [];
  flattenTracks(block, null, flat);
  // Recursion can visit a subtrack both as a child and in its own right.
  const seen = new Set<string>();
  const unique = flat.filter((t) => {
    const k = String(t.track);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const search = typeof args.search === 'string' ? args.search.trim() : undefined;
  const limit = clampNum(args.limit, 100, 1000);
  const hits = unique.filter((t) => matches(search, t.track, t.shortLabel, t.longLabel));
  // hg38 carries ~24,000 tracks and most longLabels are prose, so a plain
  // substring search puts thousands of incidental mentions ahead of the track
  // the caller meant. Two measured failures drove this ranking: searching
  // "gencode" matched 13,427 tracks and buried `knownGene` (short label
  // "GENCODE V50"), which is the answer; and 13,000 of those matches were the
  // ENCODE catalogue, because "wgEncodeBroadHistone..." lowercases to a string
  // that literally contains "gencode". So rank by WHERE the match landed AND
  // whether it fell on a word boundary — camelCase counts, which is what
  // separates "nmdEscGencode" from "wgEncode...".
  const boundaryHit = (hay: unknown, needle: string): boolean => {
    if (typeof hay !== 'string') return false;
    const i = hay.toLowerCase().indexOf(needle);
    if (i < 0) return false;
    if (i === 0) return true;
    const prev = hay[i - 1];
    const here = hay[i];
    if (!/[A-Za-z0-9]/.test(prev)) return true;
    return here === here.toUpperCase() && here !== here.toLowerCase() && prev === prev.toLowerCase();
  };
  const rank = (t: Record<string, unknown>): number => {
    if (!search) return 6;
    const n = search.toLowerCase();
    const name = String(t.track ?? '');
    const short = String(t.shortLabel ?? '');
    if (name.toLowerCase() === n) return 0;
    if (short.toLowerCase() === n) return 1;
    if (boundaryHit(name, n)) return 2;
    if (boundaryHit(short, n)) return 3;
    if (name.toLowerCase().includes(n)) return 4;
    if (short.toLowerCase().includes(n)) return 5;
    return 6;
  };
  hits.sort((a, b) => rank(a) - rank(b) || String(a.track).localeCompare(String(b.track)));

  return {
    source: SOURCE,
    assembly: genome,
    search: search ?? null,
    totalTracks: unique.length,
    matched: hits.length,
    returned: Math.min(hits.length, limit),
    trackDataUpdated: body.dataTime ?? null,
    tracks: hits.slice(0, limit),
  };
}

async function trackData(args: Record<string, unknown>): Promise<unknown> {
  const genome = reqStr(args, 'genome', '"hg38" (GRCh38) or "hg19" (GRCh37)');
  const track = reqStr(args, 'track', '"knownGene" or "refGene" — get the name from ucsc_tracks');
  const chrom = reqStr(args, 'chrom', '"chr17" (the "chr" prefix is required)');
  const start = reqNum(args, 'start');
  const end = reqNum(args, 'end');
  if (end <= start) throw new Error(`"end" (${end}) must be greater than "start" (${start}). UCSC coordinates are 0-based half-open.`);
  const maxItems = clampNum(args.maxItemsOutput, 1000, 100000);

  const qs = new URLSearchParams({
    genome,
    track,
    chrom,
    start: String(start),
    end: String(end),
    maxItemsOutput: String(maxItems),
  });
  const body = await ucscGet(`/getData/track?${qs.toString()}`);

  // UCSC keys the row array on the track name — except on some composite
  // tracks where it keys on the subtrack, so fall back to "the first array
  // value in the response" rather than reporting an empty result that is
  // really a naming mismatch.
  let rows: unknown[] | null = Array.isArray(body[track]) ? (body[track] as unknown[]) : null;
  let rowKey = track;
  if (rows === null) {
    for (const [k, v] of Object.entries(body)) {
      if (Array.isArray(v)) {
        rows = v;
        rowKey = k;
        break;
      }
    }
  }
  if (rows === null) rows = [];

  return {
    source: SOURCE,
    assembly: genome,
    track,
    rowKey,
    chrom,
    start,
    end,
    trackType: body.trackType ?? null,
    chromSize: body.chromSize ?? null,
    dataTime: body.dataTime ?? null,
    itemsReturned: rows.length,
    truncated: rows.length >= maxItems,
    note:
      rows.length === 0
        ? `No rows from track "${track}" overlap ${chrom}:${start}-${end} in ${genome}. That is a real empty interval only if the assembly is right — the same coordinates in a different build point at a different locus.`
        : null,
    items: rows,
  };
}

async function sequence(args: Record<string, unknown>): Promise<unknown> {
  const genome = reqStr(args, 'genome', '"hg38" (GRCh38) or "hg19" (GRCh37)');
  const chrom = reqStr(args, 'chrom', '"chr7" (the "chr" prefix is required)');
  const start = reqNum(args, 'start');
  const end = reqNum(args, 'end');
  if (end <= start) throw new Error(`"end" (${end}) must be greater than "start" (${start}). UCSC coordinates are 0-based half-open.`);
  if (end - start > 1000000) throw new Error(`Requested ${end - start} bases. Keep a sequence request under 1,000,000 bases — UCSC refuses larger spans and the result would not be usable in a chat response anyway.`);

  const qs = new URLSearchParams({ genome, chrom, start: String(start), end: String(end) });
  if (args.revComp === true) qs.set('revComp', 'TRUE');
  const body = await ucscGet(`/getData/sequence?${qs.toString()}`);

  const dna = typeof body.dna === 'string' ? body.dna : '';
  if (!dna) throw new Error(`UCSC Genome Browser API returned no bases for ${genome} ${chrom}:${start}-${end}. Check the chromosome name (UCSC uses "chr17", not "17") and that the interval is inside the chromosome.`);
  const gc = (dna.match(/[gcGC]/g) ?? []).length;
  const n = (dna.match(/[nN]/g) ?? []).length;

  return {
    source: SOURCE,
    assembly: genome,
    chrom,
    start,
    end,
    revComp: args.revComp === true,
    length: dna.length,
    gcFraction: dna.length ? Number((gc / dna.length).toFixed(4)) : null,
    nCount: n,
    dna,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'ucsc_genomes':
      return listGenomes(args);
    case 'ucsc_tracks':
      return listTracks(args);
    case 'ucsc_track_data':
      return trackData(args);
    case 'ucsc_sequence':
      return sequence(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
