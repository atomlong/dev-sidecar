# Changelog

All notable changes to this project will be documented in this file.

## [v2.2.0] - 2026-07-17

### Added
- Synced upstream v2.2.0 (63 commits from docmirror/dev-sidecar). Major upstream features integrated:
  - TLS 1.3-only default with optional TLS 1.2 toggle (`allowTls12` config). Replaces the fork's previous `NODE_EXTRA_CA_CERTS` workaround with upstream's `REQUEST_CA_BUNDLE` environment variable approach.
  - HTTP/2 fake server with multiplexing support for browser concurrent requests.
  - On-demand IP probing with concurrent request scattering — when no tested alive IP is available, untested IPs are rotated in for probing instead of falling back to DNS cache.
  - Smart IPv6 detection — static NIC scan + runtime `ENETUNREACH` fallback to avoid IPv6 timeouts on networks without IPv6 connectivity.
  - CSP nonce injection for `'strict-dynamic'` bypass — injected scripts now carry a `nonce` attribute to pass GitHub and other CSP-protected sites.
  - HTTP/2 pseudo-header filtering and `:authority` → `Host` mapping to prevent header leakage to upstream HTTP/1.1 requests.
  - Chromium component disabling in Electron main process (PDF viewer, speech API, GPU rasterization, background networking, sync, phishing detection, etc.) to reduce memory and CPU usage.
  - macOS `zip` build target for auto-update alongside `dmg`.
  - Locale pruning — only `zh-CN.pak` is kept, saving ~15-20MB per platform.
  - Duplicate exe cleanup in `after-pack` — removes redundant `EnableLoopback.exe`/`sysproxy.exe` from `app.asar.unpacked` (already provided via `extraResources`).
  - Architecture-separated update ZIP filenames (`update-{platform}-{arch}-{version}.zip`).
  - Server duplicate-start guard — if the mitmproxy child process is still alive, `start()` returns early instead of forking a new one.
  - Startup guard for already-enabled plugins/proxy/server — prevents double-initialization on restart.
  - Security vulnerability fixes in `pnpm.overrides` (axios, brace-expansion, cross-spawn, dns-packet, form-data, ip, minimist, qs, tough-cookie).
  - CA certificate path validation in `setup-ca.js` — throws early with a clear error if `certPath` is empty or the file does not exist.
  - `JsonEditor.vue` component for editing JSON config in the GUI.
  - Theme system refactor with `variables.scss` for dark/light mode.

### Changed
- Adopted upstream `util.js`: removed the fork's `NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE` certificate loading logic (module-level `loadExtraCaCerts` cache, `tls.rootCertificates` merge). Upstream uses TLS 1.3 by default and provides `REQUEST_CA_BUNDLE` as a GUI-configurable environment variable.
- Adopted upstream `dnsLookup.js`: `setDnsLookupHeader` replaced with `safeHeaderValue` (filters non-ASCII for HTTP/2 header compliance), added on-demand IP probing via `pickNextForProbing`.
- Merged `server/index.js`: kept fork's V8 flags (`--expose-gc`, `--max-old-space-size` per batch level for OOM prevention) and added upstream's duplicate-start guard + `server.port` tracking.
- Merged `expose.js`: kept fork's `reclaimStartupMemory()` (cgroup memory reclaim) and added upstream's `!status.xxx.enabled` guards to prevent double-startup.
- Merged `setup-ca.js`: kept fork's `/usr/lib/dev-sidecar/setup-ca.sh` (sudoers NOPASSWD) and added upstream's path validation.
- Merged `after-pack.cjs`: kept fork's `ensureNativeRuntimeDependencies` (fadvise-linux, better-sqlite3, bindings) and added upstream's `pruneLocales`, duplicate exe cleanup, and architecture-separated ZIP filenames.
- Merged `electron-builder.config.cjs`: kept fork's `linuxTargets` (conditional rpm/flatpak) and adopted upstream's macOS `zip` target for CI auto-update.
- Adopted upstream `background.js`: Chromium component switches, icon path resolution fix for production builds.
- Adopted upstream `package.json` pnpm overrides (security fixes).
- Adopted upstream `mitmproxy/package.json` test script (`mocha --exit` to prevent CI hangs).
- Removed free-eye plugin from GUI router and menu (upstream uses free-eye, this fork uses xray).

### Preserved (fork-specific)
- Xray plugin with compact v2 SQLite cache, 3-stage gating, egress IP probing, shareLink generation.
- mitmproxy V8 flags for OOM prevention (`--expose-gc`, `--max-old-space-size` per batch level).
- cgroup memory reclaim (`reclaimStartupMemory`, `reclaim-memory.sh`).
- `setup-ca.sh` sudoers NOPASSWD helper.
- `fadvise-linux` native module for Linux file cache advice.
- Linux deb service integration (postinst/prerm/sudoers/systemd template).
- better-sqlite3 native module via `npm:@atomlong/better-sqlite3@12.12.0` alias, loaded from `app.asar.unpacked` at runtime through `__non_webpack_require__` fallback.

### Changed (post-sync)
- Reverted dual-protocol Stage 3 batch probing back to single-pass probing with the configured `probeUrl`. The dual-protocol (HTTP + HTTPS) probing introduced in v2.1.7 doubled per-batch latency, produced inaccurate `probeProtocol` classification (nodes flagged HTTP-only were frequently also reachable over 443), and proxying plain HTTP (port 80) had little practical value. Removed the `probe_protocol` column from the `node_runtime_v2` SQLite schema, removed `probeProtocol` from `probed-node-stats.json` output, and removed the egress-IP-lookup URL filtering by `probeProtocol` in `detectEgressAddressThroughProxy` (all lookup URLs are now always tried, HTTP first).

### Upgraded (previously deferred)
- Electron 19.1.9 → 41.3.0 (Chromium 119 → 134, Node 16 → 24).
- electron-builder 25.1.8 → 26.8.1 (with app-builder-lib, dmg-builder, squirrel-windows pinned to 26.8.1 via pnpm overrides).
- `preelectron:build` simplified to skip `install-app-deps` (native rebuild handled by `rebuild-core-native.js`); `loadBetterSqlite3` falls back to `__non_webpack_require__` against `app.asar.unpacked` when `require('better-sqlite3')` fails inside the asar archive.

## [v2.1.7] - 2026-07-16

### Changed
- Removed all legacy/hotcold database migration code from the Xray cache plugin (`cache.js` -1568 lines, `index.js` -60 lines). This fork's database has been compact v2 format for a long time; the legacy `nodes` single-table, hot/cold `node_runtime`+`node_payload`, and old `subscriptions`+`subscription_node_refs` tables are no longer created or maintained. 44 dead migration/retire functions, 3 stage2 migration helper functions, and 4 unused `CACHE_META` constants were deleted. All read/write/sync functions were simplified to compact v2-only paths. This also fixes a CI test failure where `exit_ip`/`probe_protocol` columns were referenced in queries against the legacy `node_runtime` table that did not have those columns, causing `SqliteError` swallowed by catch blocks and migration returning 0 rows.

### Added
- Added `exit_ip` column to the `node_runtime_v2` SQLite cache table to store the egress IP address of each probed node. The egress IP is obtained during Stage 3 egress metadata probing and refreshed on each probe round. Existing databases are automatically migrated via `ALTER TABLE ADD COLUMN`. The `probed-node-stats.json` report now includes an `exitIp` field for each node.
- Added `probe_protocol` column to the `node_runtime_v2` SQLite cache table to record which probe protocol(s) each node supports (`http`, `https`, or `both`). The `probed-node-stats.json` report now includes a `probeProtocol` field for each node. Existing databases are automatically migrated via `ALTER TABLE ADD COLUMN`.
- Added dual-protocol Stage 3 batch probing: each batch is probed with both the configured `probeUrl` and its protocol-flipped alternate (HTTP↔HTTPS). This discovers nodes that only support port 80 (HTTP) or port 443 (HTTPS) regardless of which protocol the user configured, increasing node yield. The probe result for each node is tagged with `probeProtocol` accordingly.
- Added Linux deb package integration: the `dev-sidecar.service` systemd template, `postinst`/`prerm` scripts, and sudoers helper scripts (`reclaim-memory.sh`, `setup-ca.sh`) are now bundled in the deb package. On install, the postinst auto-detects the UID 1000 user, installs the service with correct `User`/`Group`, creates a sudoers drop-in for NOPASSWD execution of the helper scripts, and enables/starts the service.
- Added `shareLink` field to `probed-node-stats.json`: each probed node now includes a shareable proxy link (e.g. `vless://...`, `vmess://...`, `trojan://...`, `ss://...`, `http://...`, `socks://...`) with a human-readable tag in the format `🇺🇸 US 1.2.3.4` (flag emoji + country code + exit IP). Links are generated on the fly when writing `probed-node-stats.json` and are not stored in the SQLite cache.

### Changed
- Increased mitmproxy child process V8 old-space limit from 64 MB to 80 MB (Stage 3 batch level 2) to prevent JavaScript heap out of memory (`SIGABRT`) under high-concurrency HTTPS interception workloads. The `stage3GcThresholdMB` for all batch levels (1-5) was adjusted to ~75% of `maxOldSpaceSizeMB` so that explicit GC triggers before V8 is forced into a full mark-sweep, reducing event-loop freezes.
- Increased default systemd `MemoryHigh` from 280M to 512M in the packaged service template to accommodate Stage 3 batch levels 1-4 without cgroup memory pressure.
- Unified all timestamp formatting to use local timezone (`formatLocalTimestamp`) instead of mixed UTC (`toISOString`). Affected files: `probed-node-stats.json`, `stage3-last-round.json`, `local-input-state.json`, and cache sync plan timestamps. All timestamps now display in the operating system's local timezone (e.g. `2026-07-16T11:30:34.595+08:00`) instead of UTC (`2026-07-16T03:30:34.595Z`).
- Reordered `EGRESS_IP_LOOKUP_URLS` to list China-accessible IP-lookup services (`ip.3322.net`, `bt.cn`, `myip.ipip.net`) before foreign services so that CN exit nodes resolve their egress IP in 1-2 seconds instead of exhausting the timeout on GFW-blocked foreign endpoints.
- Increased egress metadata lookup per-URL timeout from implicit 30s to explicit 8s per URL with a 90s outer cap, allowing multiple lookup URLs to be attempted within a single egress probe instead of timing out on the first blocked URL.
- Adapted egress IP lookup URL selection to the node's `probeProtocol`: nodes tagged `https` only attempt HTTPS IP-lookup URLs (port 443), while `http`/`both`/unknown nodes use the full URL list (HTTP first).
- Replaced direct `sudo` calls in `cache.js`, `expose.js`, and `setup-ca.js` with packaged helper scripts (`/usr/lib/dev-sidecar/reclaim-memory.sh`, `/usr/lib/dev-sidecar/setup-ca.sh`) invoked via NOPASSWD sudoers rules installed by the deb postinst.
- Removed unnecessary `sudo` from the Linux autostart desktop file removal in `auto-start/backend.js` (the file is in the user's home directory and does not require elevated privileges).

## [v2.1.6] - 2026-07-14

### Added
- Added explicit loading of `NODE_EXTRA_CA_CERTS` (or `SSL_CERT_FILE`) in the mitmproxy HTTPS agent and tunnel-agent creation paths so that the bundled Node runtime in packaged Electron builds trusts system-installed root CAs (e.g. corporate SASE/TLS-interception root CAs). The Electron-bundled Node ignores the `NODE_EXTRA_CA_CERTS` environment variable, so the CA list is read from the PEM file, merged with Node's built-in root certificates, and passed explicitly via the `ca` option to both `agentkeepalive`'s `HttpsAgent` and `tunnel-agent`'s `httpsOverHttp`/`httpsOverHttps`. This fixes `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` errors when DevSidecar proxies HTTPS traffic to sites whose certificates are re-signed by a corporate TLS decryption device.
- Added unconditional injection of manual nodes from the `nodes` config list into the Xray live config at Stage 1 startup, bypassing `allowedCountries`, `allowedOwners`, and `maxDelayMs` filters so that user-specified nodes are always included in `~/.dev-sidecar/xray/config.json`.
- Added Stage 1 fallback to the previous `config.json` when no usable nodes are found from cache or manual nodes, preserving the last known working proxy outbounds instead of overwriting with a Direct/Block-only config.
- Added `subscriptionSyncIntervalDays` config option (default 3 days) to prevent Stage 2 from fetching remote subscriptions too frequently. The last fetch timestamp is persisted in `cache_meta`; subsequent Stage 2 runs within the cooldown period skip remote fetching and only process local nodes.
- Added `fallbackTag: "direct"` to the Xray balancer configuration so that traffic falls back to direct connection when all proxy nodes are unavailable, preventing complete network interruption.
- Added periodic Stage 2 triggering: after each Stage 3 round completes, the service checks if the last remote subscription fetch exceeds `subscriptionSyncIntervalDays`. If so, Stage 2 is automatically triggered to refresh subscriptions without requiring a service restart.

### Changed
- Removed `config.json.bak` backup at Stage 1 startup since the previous config is now reused in-place when no cache candidates are available.
- Changed Stage 3 to refresh the live `config.json` after every probe round, not just on cold start. Stale nodes (delay = 0 or failure_streak >= 3) are removed and replaced with freshly probed available nodes, keeping the proxy node pool up to `startupNodeLimit` healthy nodes. Xray is only restarted when the node list actually changes.
- Enforced a minimum value of 3 hours for `cacheRefreshInterval` to prevent excessively frequent Stage 3 rounds and xray restarts.
- Reduced xray restart delay from 1000ms to 200ms to minimize proxy interruption during live config refreshes.

### Fixed
- Fixed egress metadata probes failing with `ECONNREFUSED` for the majority of nodes, leaving `country`/`owner` permanently empty in the cache. The root cause was that `resolveEntryEgressMetadata` started an Xray egress probe process but issued the HTTP egress-IP lookup before the Xray inbound port was actually listening. Under cgroup `MemoryHigh` memory pressure, the spawned Xray process can take over a second to bind its listen socket, causing the immediate proxy request to fail with `ECONNREFUSED`. Added `waitForProxyPortReady` which polls the TCP port (and detects early child-process exit) before issuing the egress IP lookup. This also fixes the `probe.startXrayProcess` log suppression bug where egress-purpose processes never logged their startup message due to an inverted `purpose !== 'egress'` condition.
- Fixed mitmproxy child process crashing with `SIGABRT` (JavaScript heap out of memory) when handling HTTPS traffic on networks with corporate TLS interception. The crash was caused by `NODE_EXTRA_CA_CERTS` pointing to the full OS certificate bundle (148 certificates) which inflated every HTTPS agent's `ca` array and exhausted the 64 MB V8 heap limit of the mitmproxy child process. The systemd service file now points `NODE_EXTRA_CA_CERTS` to only the corporate root CA file instead of the full OS bundle, reducing the CA array from ~288 to ~141 entries.
- Fixed egress IP lookup failing for proxy nodes located in China where major IP-lookup services (icanhazip, ipify, ifconfig.me, etc.) are blocked by the GFW. Added China-accessible IP-lookup services (`http://ip.3322.net`, `http://www.bt.cn/Api/getIpAddress`, `http://myip.ipip.net`) to `EGRESS_IP_LOOKUP_URLS` and improved the IP extraction regex to parse non-plain-text responses (e.g. `myip.ipip.net` returns `当前 IP：x.x.x.x 来自于：...`).
- Fixed nodes that pass Xray observatory probing but cannot actually proxy traffic (rogue proxies returning empty 200 responses, or trojan nodes returning 400) being retained indefinitely with `country=unknown`. When egress metadata lookup fails and no fallback country/owner exists, the node's `delay` is now cleared and `stable` set to `false`, causing `applyStage3ProbeResults` to treat it as a failure and increment `failureStreak` until the node is evicted from the cache.

## [v2.1.5] - 2026-07-11

### Added
- Added `query` support to the `requestReplace` interceptor, allowing intercept configs to set or remove URL query parameters (with `${hostname}`/`${path}` placeholder substitution), enabling per-host URL rewrites such as injecting the Docker Registry `service` parameter into `auth.docker.io` token requests.
- Added targeted mitmproxy regression coverage for DNS-aware upgrade request handling.
- Added automatic Xray SQLite cache migration from the legacy `nodes` layout to split `node_runtime` and `node_payload` storage.
- Added one-time retirement metadata and post-retirement compaction for migrated Xray caches so existing installations can reclaim disk space without losing cached nodes.
- Added `startupSelectEnabled` to the Xray plugin config so operators can disable stage 1 startup node selection; when set to `false`, DevSidecar reuses the previous `~/.dev-sidecar/xray/config.json` as-is (including its already-selected proxy outbounds and inbound port) instead of probing and rewriting the live config on every restart.
- Added `subscriptionSyncEnabled` to the Xray plugin config so operators can disable stage 2 subscription fetching and cache synchronization; when set to `false`, DevSidecar skips directly to stage 3 cache-only probing, mirroring the existing `cacheRefreshEnabled` switch pattern.
- Added compact-v2 startup cache metadata in `cache_meta`, including the persisted `probed_node_ids` list and detailed startup-read diagnostics so stage 3 can prepare the next cold boot without introducing another cache database.
- Added a shared `util.cgroup.js` module for Linux cgroup memory diagnostics and reclaim, replacing duplicated `getCurrentProcessCgroupPath` definitions across `expose.js`, `cache.js`, and `index.js`.
- Added startup-entry `memory.reclaim` (100 MB) before the mitmproxy server starts, dropping cold-boot cgroup file cache from ~199 MB to ~103 MB so the Xray plugin entry point stays below 300 MB.
- Added per-batch `memory.reclaim` before each Stage 3 probe subprocess start, preventing the transient Xray probe process from stacking on top of SQLite file cache and pushing `memory.peak` above 300 MB.
- Added `stage3-after-round-finalize-reclaim` to drop SQLite file cache immediately after a complete Stage 3 round, preventing the ~195 MB residual file cache from stacking onto the next round's initialization.

### Changed
- Changed Xray cache writes and reads to treat the hot/cold SQLite schema as the authoritative store after migration, and to stop maintaining the legacy `nodes` table once retirement completes.
- Changed stage 2 large-subscription synchronization to flush accepted-node batches less frequently, reducing real Linux service peak memory from roughly 1.1 GB to about 550 MB in the current baseline verification.
- Changed `CACHE_SIZE_LIMIT_BYTES` from 3 GB to 1 GB so that `cleanupOutdatedToSizeLimit` triggers sooner and evicts real nodes (not just outdated tombstones) by `next_check_at ASC` when the SQLite cache grows beyond the 0.9× target threshold.
- Changed `maxLogFileSize` default behavior so operators can set a smaller log rotation size (e.g. 50 MB) in `config.json` to prevent `server.log` page cache from inflating the cgroup memory peak on long-running Linux deployments.
- Changed systemd service configuration to include `KillMode=control-group`, `TimeoutStopSec=10`, and `MemoryHigh=350M` so that restart cleanly kills all child processes (including Xray probe subprocesses) and the kernel proactively reclaims file-backed page cache (including mmap'd Electron binary pages) when cgroup memory exceeds the soft limit.
- Changed stage 1 compact-v2 startup selection to load candidate nodes through `cache_meta.probed_node_ids` primary-key lookups instead of scanning the full `node_runtime_v2` table during cold boot, and moved the optional `delay > 0` partial-index build to stage 2 maintenance where later file-cache reclaim can clean it up.
- Changed stage 1 startup flow to skip the old explicit cache migration/retire/compact/reclaim pass and rely on the automatic schema checks already performed when opening the SQLite cache.
- Changed stage 2 and stage 3 to remove the explicit `migrateHotColdSchema`/`retire`/`compact`/`reclaim` sequence that was redundantly opening the 765 MB SQLite database every round with `migratedRows=0`, pushing cgroup file cache above 300 MB before any guardrail could fire.
- Changed `updateSubscriptionAvailability` to compute the subscription availability summary in a single pass without joining the 1.6M-row `node_runtime_v2` table, and to reuse the in-memory summary rows after the transaction instead of re-running the full summary query a second time.
- Changed all `memory.current` / `memory.reclaim` access to resolve the cgroup path dynamically from `/proc/self/cgroup` via `util.cgroup.js`, replacing the hardcoded `dev-sidecar.service` path that would break on non-standard service names.
- Changed `subscriptionSyncLowWatermark` semantics so stage 2 fetches remote subscriptions only when the stable-node count is at or below the watermark (previously the boundary used `>=`); a watermark of `0` skips fetching whenever any stable node exists.
- Changed `subscriptionSyncLowWatermark` validation to treat negative or non-numeric values as invalid configuration: instead of silently clamping to `0`, it now records a warning and skips remote subscription fetching (local nodes are still processed) so a misconfigured threshold cannot trigger unexpected remote syncs.
- Removed the temporary `[TEMP]` cgroup memory diagnostic logging from `expose.js`, `cache.js`, and `index.js` after confirming the Linux service memory peak stayed below 300 MB across cold boot, Stage 3 batches, and round-finalize.

### Fixed
- Fixed WebSocket and other HTTP upgrade requests to reuse the normal DNS resolution path, restoring Copilot Web chat message sending when those requests pass through DevSidecar.
- Fixed migrated Xray caches falling back to legacy-row assumptions after retirement, which could otherwise break empty-cache and follow-up refresh behavior.
- Fixed Electron `before-quit` handler only calling plugin cleanup (`quit()`) on macOS, leaving Xray probe subprocesses and the main Xray process as orphans on Linux when the service receives SIGTERM during `systemctl restart`. The Linux/Windows path now calls `quit()` with `event.preventDefault()` and a `forceClose` guard so the async plugin shutdown (`DevSidecar.api.shutdown()`) runs to completion before `app.quit()` re-enters `before-quit`, avoiding the recursive `quit()` call that the naïve "always call `quit()`" approach would trigger.
- Fixed `cleanupOutdatedToSizeLimit` only clearing the `outdated` tombstone table without evicting actual node rows, making the 1 GB cache size limit ineffective.
- Fixed compact-v2 bootstrap startup falling back to full-table scans when the startup cache was already available, which had been repopulating Linux cgroup file cache and pushing cold-boot peak memory back above the intended range.
- Fixed `reclaimCgroupMemory` in `cache.js` calling `getCurrentProcessCgroupPath` without defining it, causing all cgroup `memory.reclaim` calls (Stage 1 startup reclaim, Stage 3 pre-probe reclaim, Stage 3 post-batch reclaim, round-finalize reclaim) to silently fail with `ReferenceError` and allowing the Linux service memory peak to reach 350 MB during both cold boot and long-running Stage 3 rounds.

## [v2.1.4] - 2026-05-20

### Added
- Added Xray subscription provenance tracking in the SQLite cache, including per-configured-subscription metadata and subscription-to-node references.
- Added stage 3 per-subscription usable-node summaries written to `stage3-last-round.json` after complete cache refresh rounds.
- Added `subscriptionStaleAfterDays` to control when stale subscription metadata can be cleaned up after stage 3 confirms no usable nodes remain.

### Changed
- Upgraded `better-sqlite3` to `12.10.0` in both `@docmirror/dev-sidecar` and `@docmirror/dev-sidecar-gui` to match the packaged Electron 41 runtime.
- Changed the GUI packaging pipeline to rebuild Electron native dependencies before `electron:build` and to bundle `better-sqlite3`, `bindings`, and `file-uri-to-path` into `app.asar.unpacked`.
- Changed Xray subscription synchronization so duplicate subscription URLs are tracked as separate configured entries by occurrence order.
- Changed subscription availability accounting to count only nodes that were actually usable in the current complete stage 3 round, rather than treating retained cache entries as current availability.
- Changed Xray probe logs to distinguish batch cache probes from egress metadata probes.

### Fixed
- Fixed packaged Linux builds failing to read the existing Xray SQLite cache, which previously surfaced as `Xray SQLite cache is unavailable` during startup and background refresh.
- Fixed packaged Linux startup path resolution so renderer assets load from the packaged app root and Xray resources resolve from `resources/extra`.
- Fixed packaged Linux startup crashes caused by `electron-updater` export-shape differences.
- Fixed stale subscription cleanup semantics so subscription metadata is removed only when it is older than the configured threshold and no cache nodes still reference it; `nodes` rows remain governed by stage 3 unusable-node probing.
- Fixed egress metadata probes being started for nodes that already have both `country` and `owner` metadata.
- Fixed lingering egress metadata Xray child processes by stopping them via the real child PID instead of relying on `child.killed` state.
- Fixed macOS GitHub Actions packaging by forcing a single `electron-builder` 26.8.1 dependency chain under pnpm, avoiding mixed 22.x/26.x builder modules during desktop builds.

## [v2.1.3] - 2026-05-16

### Added
- Added staged Xray workflow controls, including startup filters and cache refresh settings.
- Added Xray stage-gating options: `subscriptionSyncLowWatermark` and `cacheRefreshEnabled`.

### Changed
- Changed Xray startup to prefer stable nodes from the previous SQLite cache and to reuse cached `country`/`owner` metadata during stage 1 quick recheck.
- Changed post-start refresh into a multi-source cache rebuild with optional remote subscription fetching, followed by optional stage 3 cache-only probing.
- Changed stage 3 to use fixed rotating SQLite rowid batches and to keep only live cache entries with current metadata.

### Fixed
- Fixed Xray cache persistence to retain `stable`/`delay`/`country`/`owner` metadata for later startup selection.
- Fixed packaged Linux runtime cache access by bundling the missing `better-sqlite3` runtime dependencies.
- Fixed idle egress metadata probe process leaks by stopping temporary Xray instances immediately after exit-IP detection.
- Fixed Linux packaging noise by skipping RPM targets automatically when `rpmbuild` is unavailable and by bundling required Xray platform resources.
- Fixed stage 3 batch acceptance to require full observatory coverage before write-back, preventing partial-metrics misdeletion.
- Fixed SQLite shrink behavior after large stage 3 deletions by allowing aggressive incremental vacuum when the cache file is mostly free pages.

## [v2.1.2] - 2026-04-07

### Fixed
- Hardened the mitmproxy interception pipeline against missing `agent.options` values, fixing crashes on `daily-cloudcode-pa.googleapis.com` and related Google API requests.
- Added null-safe `rejectUnauthorized` access across request, upgrade, SNI, proxy, and unVerifySsl handlers.
- Pinned GitHub Actions native module rebuilds to Python 3.10, avoiding Windows build failures caused by Python 3.12 removing `distutils`.
- Restored macOS `universal` DMG packaging by thinning bundled Xray binaries to the target architecture before electron-builder performs universal `lipo` merging.
- Fixed macOS CI on arm64 runners by skipping `lipo -thin` when the downloaded Xray binary is already a single-architecture Mach-O for the target arch.
- Synchronized `build-and-release.yml` and `test-and-upload.yml` so cross-platform build behavior and macOS artifact outputs remain consistent.

## [v2.1.1] - 2026-03-01

### Added
- **Built-in Xray Core**: DevSideCar now bundles the Xray Core binaries and necessary `.dat` database files for all major platforms (Windows, macOS, Linux). Users no longer need to manually download or configure the `binPath`. The plugin is truly out-of-the-box.

### Changed
- Removed the manual `binPath` configuration option from the UI and backend logic.
- Automated downloading of specific Xray versions during the build process, reducing setup complexity.
- Updated documentation to reflect the new out-of-the-box Xray plugin experience.

## [v2.1.0] - 2026-02-14

### Added
- **Xray Plugin**: Integrated Xray Core as a plugin, supporting advanced proxy protocols like VLESS, VMess, Trojan, and ShadowSocks.
- **Reality Support**: Added full support for VLESS/Trojan Reality protocol, including strict validation to prevent core crashes.
- **Tunnel Protocol**: Introduced `tunnel://` pseudo-protocol to support transparent HTTP CONNECT tunneling to local proxies.
- **Global Deduplication**: Implemented intelligent global deduplication for proxy nodes across multiple subscription sources.
- **Configuration**: Enhanced configuration schema to support plugin settings and routing rules.

### Fixed
- Fixed Reality protocol validation issues (shortId hex check, publicKey length check).
- Fixed Xray Core crash when using incompatible transport protocols (e.g., WebSocket) with Reality.
- Fixed potential port conflicts by implementing dynamic port allocation for Xray.

### Changed
- Updated `mitmproxy` to support dynamic hot reloading of interception rules.
- Optimized subscription parsing logic to handle various link formats and edge cases.