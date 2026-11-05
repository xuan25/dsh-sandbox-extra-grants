# dsh-sandbox-extra-grants

The built-in dsh sandbox profile deliberately excludes host paths from
confined commands - device nodes such as `/dev/nvidia0` or `/dev/dri`, and
files outside the workspace. The framework provides no policy-level way to
add exactly those paths back, so a confined command that needs one of them
(a GPU tool such as `nvidia-smi`) fails until the operator replaces or
forks the built-in provider. This plugin fills that gap: it wraps the
built-in `LocalSandboxProvider` and splices **extra path grants** (files,
device nodes, or directories, each read-only or read-write) into the
confined argv, keyed per policy mode and written in the format of the
runner the profile uses (the `landlock-run` launcher, or an operator
`runnerCommand` such as `bwrap`). The decorator composes with the built-in
provider rather than replacing it, so the built-in confinement stays in
place and only the granted paths change.

## Installation

```sh
dsh plugin --profile <profile> add dsh-sandbox-extra-grants
```

The package ships no cordis lines of its own: it installs as a plain
dependency (the "no layer activated" notice is expected). The deployment
writes the composition entry in its own patch layer - for example in the
profile `cordis.patch.yml`, disabling the built-in `sandbox` line and
inserting the plugin entry with the fields documented in the Configuration
section:

```yaml
- id: sandbox
  disabled: true
- insert:
    - id: sandbox-extra-grants
      name: dsh-sandbox-extra-grants
      config:
        grants:
          workspace-write:
            - /dev/nvidia0
```

On a profile with the dsh-hmr bundle active, toggling those lines
hot-recomposes the provider, and grant edits then apply to new sessions
only - pre-existing sessions pin the provider instance they were composed
with until the process restarts. Installing the package itself requires a
process restart (resolution change).

## Configuration

One composition entry carries both config surfaces: `grants` is owned by
this plugin, and `backing` groups the backing provider's own fields, which
the plugin passes through to the built-in provider untouched:

| field | source | meaning |
| --- | --- | --- |
| `grants` | this plugin | the plugin-owned map of extra path grants per policy mode (below); the field is optional |
| `backing` | the built-in provider, passed through | the backing provider's own config object; when the field is omitted, every backing field takes the framework default |

The `backing` object carries exactly the built-in `dsh-sandbox-local` fields:

| field | meaning |
| --- | --- |
| `runnerCommand` | the operator runner command; the plugin recognizes `bwrap`-family runners by matching the first element against the confined command's `argv[0]` |
| `runnerFailureSignatures` | the runner's refusal signatures; the value must be non-empty when `runnerCommand` is set |
| `probeTimeoutMs` | the probe timeout, in milliseconds |

### The `grants` map

Grants are keyed by the framework's confined policy mode - the closed set
`read-only` and `workspace-write` - and apply to exactly that mode's
confined commands. A mode without an entry (or with an empty list) gets no
grants.

Each entry is a string in the docker `-v` path-suffix style:

```yaml
config:
  backing:            # optional; omitted = every framework default
    runnerCommand: [/opt/runner]
  grants:
    workspace-write:
      - /dev/nvidia0          # bare path: read-write (default)
      - /proc:rw              # explicit read-write (same as bare)
    read-only:
      - /var/log/audit:ro     # read-only
```

The entry rules are checked at service start, and an invalid entry fails the
composition:

- the path part must be non-empty and absolute (starts with `/`);
- the suffix after the last `:` must be `ro` or `rw`; a bare path means `rw`;
- `w` (write-only) is rejected: no runner dialect can express it - use `rw`;
- duplicate paths collapse to one grant keeping the more permissive mode
  (`rw` over `ro`).

The `backing` object is validated at service start, exactly as the built-in
service is. All configuration arrives through the cordis config entry; the
plugin reads no environment variables.

## Semantics

- The plugin runs on Linux only. On other platforms a non-empty grant set
  for the active policy mode fails closed.
- A command never runs unconfined: the plugin re-checks the confined argv
  on every `confine` call, and a failure to confine refuses the command.
- With no grants for the active policy mode, the confined argv is identical
  to the built-in provider's output.
- The plugin recognizes the `landlock-run` launcher and `bwrap`-family
  runners (a configured `runnerCommand`); any other runner refuses the
  command at confine time.
- `ro` under landlock is actually read+execute (`--ro`); under bwrap
  `--ro-bind` is a read-only bind. Both are at least pure-read.
- An `rw` grant listed under `read-only` is a deliberate per-path write
  exception: it widens write access to that one path beyond the read-only
  policy's intent. Use `:ro` when only read access is needed.
- Device nodes: `rw` is the broadly sane mode (e.g. NVML/nvidia-smi runs
  with read-write grants on the `nvidia*` nodes). A read-only device grant
  is a passthrough under landlock but makes the command fail under bwrap,
  because bwrap has no read-only device bind; this can only be detected at
  run time (device-ness and the chosen dialect are both unknown at config
  time).
- A grant whose path does not exist is passed through as-is: the runner
  surfaces the failure at run time (bwrap refuses to bind a missing path;
  the launcher validates its own grants) rather than failing silently.
- Grants are scoped per policy mode, but once granted they are process-wide
  for the confined process tree - the same exposure class as the backing
  profile's own roots.
- Do not grant the same directory twice: once here and once through the
  framework's per-call additional writable roots. Under landlock the
  duplication is harmless; under bwrap it emits a duplicate bind.

## Development

```sh
pnpm install
pnpm run build     # tsc
pnpm run typecheck
pnpm run lint      # eslint src/ test/
pnpm run selftest  # pure-transform unit tests + boot assertion + ASCII gate
```

Framework types come from peer declarations, which the dsh loader routes to
the host's own framework instances (single realm); local
`node_modules/@deepseek-ai` links pointing at the same real paths are
build-time conveniences for `tsc`.
