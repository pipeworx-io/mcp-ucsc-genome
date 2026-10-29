# @pipeworx/ucsc-genome

Reference genome assemblies from the UCSC Genome Browser — which builds exist for a species,
which annotation tracks sit on each build, the actual rows of any track over a genomic interval,
and raw reference DNA.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1857+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `ucsc_genomes(search?, limit?)` — every UCSC assembly (~238), with its assembly ID (`hg38`, `mm39`,
  `danRer11`), organism, scientific name, source assembly and release description. This is where you
  get the ID every other call keys on.
- `ucsc_tracks(genome, search?, limit?)` — annotation tracks on one assembly, with the INTERNAL track
  name that `ucsc_track_data` wants. The browser UI shows labels, not names: "GENCODE V50" is track
  `knownGene`, and there is no rule that maps one to the other.
- `ucsc_track_data(genome, track, chrom, start, end, maxItemsOutput?)` — the track's rows over an
  interval: gene models with exon structure, ClinVar variants, repeats, whatever that track holds.
- `ucsc_sequence(genome, chrom, start, end, revComp?)` — reference DNA for an interval, with GC
  fraction and an N count.

## Auth

Keyless. No registration, no rate-limit headers observed. UCSC asks heavy users to mirror or use a
local install rather than hammer the public endpoint, so keep interval widths sane.

## Data sources

- <https://api.genome.ucsc.edu/list/ucscGenomes> — assembly catalogue.
- <https://api.genome.ucsc.edu/list/tracks?genome=hg38> — track catalogue for one assembly.
- <https://api.genome.ucsc.edu/getData/track> — track rows over an interval.
- <https://api.genome.ucsc.edu/getData/sequence> — reference DNA.
- Docs: <https://genome.ucsc.edu/goldenPath/help/api.html>

## Traps

**`genome` is required on every coordinate tool and there is no default.** hg19 (GRCh37) and hg38
(GRCh38) are different coordinate systems for the same genome, and every position is valid in both —
so a wrong build never errors, it returns confident annotations for a different locus. BRCA1 sits at
chr17:41,196,311-41,277,500 in hg19 and chr17:43,044,295-43,170,245 in hg38. Anything older than
~2018 (published tables, clinical spreadsheets, most dbSNP dumps) is hg19.

**Coordinates are 0-based half-open; the Genome Browser UI is 1-based inclusive.** A position copied
out of the browser location box is one too high at the start.

**Chromosomes need the `chr` prefix.** UCSC wants `chr17`; Ensembl/NCBI style bare `17` is rejected.

**Track search ranks by where the match landed, on purpose.** hg38 carries ~24,000 tracks (most of
them ENCODE subtracks) and the longLabels are prose, so a plain substring search for "gencode"
matched 13,427 of them — and ~13,000 of those were false positives, because
`wgEncodeBroadHistone…` lowercases to a string that literally contains "gencode". The ranking scores
an internal-name hit above a shortLabel hit above prose, and treats a camelCase transition as a word
boundary, which is what separates `nmdEscGencode` from `wgEncode…`. Without it the answer
(`knownGene`) was on page 2,700.

**Composite tracks nest their subtracks one level down** inside the parent object. `ucsc_tracks`
flattens them, otherwise a search for "clinvar" on hg38 misses every subtrack of the ClinVar
container and reads as "UCSC does not have ClinVar".

**`getData/track` keys its row array on the track name — usually.** On some composites it keys on a
subtrack instead, so the pack falls back to "the first array in the response" rather than reporting
an empty result that is really a naming mismatch.

**A bad assembly or track returns HTTP 400 with a useful `error` string in the JSON body** — the pack
surfaces that string, because "hg19 is not a valid track for genome hg38" is the whole diagnosis.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "ucsc-genome": {
      "url": "https://gateway.pipeworx.io/ucsc-genome/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/ucsc-genome/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1857+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ucsc_genomes \
  -H 'Content-Type: application/json' \
  -d '{"search":"human"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ucsc_genomes`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-ucsc-genome` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/ucsc-genome/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "ucsc-genome": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-ucsc-genome"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Ucsc Genome data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
