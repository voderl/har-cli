# har-cli

Agent-friendly CLI for parsing, querying, and filtering HAR files. Useful for reconstructing a page's user-flow timeline and reverse-engineering its auth logic (cookies, tokens, redirect chains, signed requests) from a captured HAR.

## Install

```bash
npm install -g @voderl/har-cli
```

## Example

> **You:** Claude, analyze the user flow in `demo/www.google.com.har` with har-cli.
>
> **Claude:** The user opened the Google homepage → typed `h`, `he`, `hel`, `hell`, `hello` into the search box → submitted the search for `hello` → landed on the SERP (which includes a YouTube video card). The whole session is ~9 seconds, and there is no navigation request for clicking a result, which means the recording stopped on the results page.

## Usage

```
har-cli -f <file.har> [list]                       # default: list Fetch/XHR entries
har-cli -f <file.har> headers <id> [--full | --key <name>]
har-cli -f <file.har> response <id>
har-cli -f <file.har> to-curl-command <id>         # render a copy-pasteable curl command
har-cli daemon-clear                               # stop and clean up all daemons
har-cli -f <file.har> --no-daemon list             # one-shot, no caching
har-cli -f <file.har> --format json list           # machine-readable JSON output
```

Output defaults to a compact text format optimized for agent consumption (table + summary + next-step hint). Use `--format json` for the structured form.

### Filters (apply to `list`)

| flag | description |
| --- | --- |
| `--id <ids>` | filter by entry id, comma-separated (e.g. `12,24,42`) |
| `--extra-info <fields>` | extra columns, comma-separated. allowed: `size`, `start_time`, `duration`, `type`, `content_type` |
| `-d, --domain <substring>` | host substring match |
| `-t, --type <types>` | comma-separated. allowed: `all`, `Fetch/XHR` (default), `Doc`, `CSS`, `JS`, `Font`, `Img`, `Media`, `Manifest`, `Socket`, `Wasm`, `Other` |
| `--time-range <range>` | start-time in seconds, e.g. `0-2.5`, `2-`, `-5` |
| `-s, --status <code>` | `200`, `2xx`, `200,302`, `200-299` |
| `-k, --keyword <kw>` | case-insensitive search; default scope = url+header+response. use `\|` to OR multiple terms (e.g. `agent\|user\|login`) |
| `--regex <pattern>` | search with a JavaScript regex (case-insensitive); takes precedence over `--keyword` |
| `--search-type <types>` | comma-separated subset of `url,header,response` |
| `-p, --page <n>` | default 1 |
| `--page-size <n>` | default 50 |

When `--keyword` is set and the search scope spans multiple sources, every row gets a `hit_reason` array (e.g. `["url","header"]`).

### List output columns

Default columns: `id`, `method`, `status`, `url`. Use `--extra-info` to add any of `size` (`2.1kB`/`2.6Mb`), `start_time` (`12.3s`), `duration` (`0.1s`), `type`, `content_type`. With multi-source keyword search a `hit_reason` column is appended automatically. URL is always the last column so long URLs don't push the table out.

When more than `page_size` matches exist, the response includes a `hint` like:

> 42 more entries hidden. Use page=2 (of 15) to fetch the next page, or apply tighter filters (...).

### Headers / response / curl

```
har-cli -f x.har headers 12                       # default: header names only
har-cli -f x.har headers 12 --full                # full name+value pairs
har-cli -f x.har headers 12 --key content-type    # value of one header (req+res)
har-cli -f x.har headers 12 --key cookie          # raw value (no wrapping)
har-cli -f x.har response 12                      # summary (url/status/size/content_type) + body truncated to 2kB
har-cli -f x.har response 12 --full               # entire raw body, JSON pretty-printed
har-cli -f x.har to-curl-command 12               # Chrome devtools-style curl command
```

By default `response` prints a 4-line summary (`url`, `status`, `size`, `content_type`), then the body truncated to 2kB with a marker showing the total size. JSON-typed bodies are pretty-printed (newline + 2-space indent). Pass `--full` for the entire raw body — large bodies can blow past tool-result token caps; check `size` (via `list --extra-info size`) first.

## Capturing HAR files in Chrome

By default, Chrome's "Save all as HAR" strips `cookie` request headers and `set-cookie` response headers as a privacy measure. If you want har-cli to see them (e.g. for `headers --key cookie` or `to-curl-command`), enable:

> DevTools → Settings (⚙) → Preferences → Network → **Allow to generate HAR with sensitive data**

Only do this on captures you intend to keep private — the resulting HAR will contain auth tokens, session cookies, and other credentials in plain text.

## Daemon

Each unique `(absolute path, size, mtime)` triple maps to its own daemon. Per-version socket/pid/log files live under `$TMPDIR/har-cli/<uid>/d-<hash>.{sock,pid,log}` (on macOS that's `/var/folders/.../T/har-cli/<uid>/`). The daemon auto-exits after 10 minutes of idle; if the file changes, a fresh daemon is spawned for the new version on the next command.

**By default, only files ≥ 16MB use the daemon** — for smaller files the spawn overhead (~100ms) outweighs the per-call parse cost, so requests run inline. Override with:

| flag | effect |
| --- | --- |
| `--no-daemon` | force inline parse, never spawn a daemon |
| `--force-daemon` | always use daemon, regardless of file size |
| `--daemon-threshold <mb>` | custom threshold in MB (default 16) |

If a daemon for the file is already alive, it is reused regardless of size.

To stop everything and clean up runtime files:

```
har-cli daemon-clear
```
