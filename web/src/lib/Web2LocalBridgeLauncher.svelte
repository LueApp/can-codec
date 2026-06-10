<script lang="ts">
  import { onMount } from 'svelte';
  import { busStore } from '$lib/bus-store.svelte';
  import { t, type TranslationKey } from '$lib/i18n.svelte';
  import { SERVER_SCRIPT, SERVER_SCRIPT_SHA256 } from '$lib/server-script';

  type LauncherState = 'checking' | 'absent' | 'present' | 'running' | 'approving' | 'starting' | 'error';
  type AdapterMode = 'socketcan' | 'slcan';
  type EnvType = 'venv' | 'pixi' | 'conda';
  type EnvInfo = {
    interpreter: string | null;
    source: string;
    config_python: string;
    active?: {
      VIRTUAL_ENV?: string;
      CONDA_PREFIX?: string;
    };
  };

  const DEFAULT_W2L_PORT = 7878;
  const DEFAULT_BRIDGE_PORT = 8765;
  const DEFAULT_BITRATE = 1000000;
  const DEFAULT_DATA_BITRATE = 5000000;
  const ADAPTER_MODE_KEY = 'cancodec_w2l_adapter_mode';
  const W2L_PORT_KEY = 'cancodec_w2l_port';
  const BRIDGE_PORT_KEY = 'cancodec_w2l_bridge_port';
  const CAN_BUS_KEY = 'cancodec_w2l_can_bus';
  const BITRATE_KEY = 'cancodec_w2l_bitrate';
  const DATA_BITRATE_KEY = 'cancodec_w2l_data_bitrate';
  const ENV_TYPE_KEY = 'cancodec_w2l_env_type';
  const ENV_NAME_KEY = 'cancodec_w2l_env_name';
  const ENV_SETUP_PATH_KEY = 'cancodec_w2l_env_setup_path';
  const ENV_PACKAGES_KEY = 'cancodec_w2l_env_packages';
  const ENV_EXISTING_PATH_KEY = 'cancodec_w2l_env_existing_path';
  const SERVER_FILENAME = 'can_ws_server.py';
  const WEB2LOCAL_URL = 'https://web2local-bridge.lue-app.com/';

  const STATE_LABELS: Record<LauncherState, TranslationKey> = {
    checking: 'server.w2l_state_checking',
    absent: 'server.w2l_state_absent',
    present: 'server.w2l_state_present',
    running: 'server.w2l_state_running',
    approving: 'server.w2l_state_working',
    starting: 'server.w2l_state_working',
    error: 'server.w2l_state_absent',
  };

  let {
    connect = () => busStore.connect(),
    disconnect = () => busStore.disconnect(),
  }: {
    connect?: () => void;
    disconnect?: () => void;
  } = $props();

  function readStoredNumber(key: string, fallback: number): number {
    if (typeof localStorage === 'undefined') return fallback;
    const value = Number(localStorage.getItem(key));
    return normalizePort(value, fallback);
  }

  function readStoredPositiveInt(key: string, fallback: number): number {
    if (typeof localStorage === 'undefined') return fallback;
    return normalizePositiveInt(Number(localStorage.getItem(key)), fallback);
  }

  function readStoredString(key: string, fallback: string): string {
    if (typeof localStorage === 'undefined') return fallback;
    const value = localStorage.getItem(key);
    return value?.trim() || fallback;
  }

  function readAdapterMode(): AdapterMode {
    if (typeof localStorage === 'undefined') return 'socketcan';
    return localStorage.getItem(ADAPTER_MODE_KEY) === 'slcan' ? 'slcan' : 'socketcan';
  }

  function readEnvType(): EnvType {
    if (typeof localStorage === 'undefined') return 'venv';
    const value = localStorage.getItem(ENV_TYPE_KEY);
    return value === 'pixi' || value === 'conda' ? value : 'venv';
  }

  function normalizePort(value: unknown, fallback: number): number {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
  }

  function normalizePositiveInt(value: unknown, fallback: number): number {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  }

  function defaultBusFor(mode: AdapterMode): string {
    return mode === 'slcan' ? '/dev/ttyACM0' : 'can0';
  }

  function parsePortFromWsUrl(url: string): number | null {
    try {
      const parsed = new URL(url.replace(/^ws/i, 'http'));
      return normalizePort(parsed.port ? Number(parsed.port) : 80, DEFAULT_BRIDGE_PORT);
    } catch {
      return null;
    }
  }

  function isLocalWsUrl(url: string, port: number): boolean {
    try {
      const parsed = new URL(url.replace(/^ws/i, 'http'));
      const host = parsed.hostname.toLowerCase();
      return (
        normalizePort(parsed.port ? Number(parsed.port) : 80, DEFAULT_BRIDGE_PORT) === port &&
        (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1')
      );
    } catch {
      return false;
    }
  }

  function initialBridgePort(): number {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(BRIDGE_PORT_KEY);
      if (stored) return normalizePort(Number(stored), DEFAULT_BRIDGE_PORT);
    }
    return parsePortFromWsUrl(busStore.wsUrl) ?? DEFAULT_BRIDGE_PORT;
  }

  const initialAdapterMode = readAdapterMode();
  let adapterMode = $state<AdapterMode>(initialAdapterMode);
  let canBus = $state(readStoredString(CAN_BUS_KEY, defaultBusFor(initialAdapterMode)));
  let bitrate = $state(readStoredPositiveInt(BITRATE_KEY, DEFAULT_BITRATE));
  let dataBitrate = $state(readStoredPositiveInt(DATA_BITRATE_KEY, DEFAULT_DATA_BITRATE));
  let bridgePort = $state(initialBridgePort());
  let w2lPort = $state(readStoredNumber(W2L_PORT_KEY, DEFAULT_W2L_PORT));
  let state = $state<LauncherState>('checking');
  let messageKey = $state<TranslationKey>('server.w2l_hint_idle');
  let messageDetail = $state('');
  let bridgePid = $state<number | null>(null);
  let logTail = $state('');
  let busy = $state(false);
  let probing = false;
  let envInfo = $state<EnvInfo | null>(null);
  let envType = $state<EnvType>(readEnvType());
  let envName = $state(readStoredString(ENV_NAME_KEY, 'can-codec-bridge'));
  let envSetupPath = $state(readStoredString(ENV_SETUP_PATH_KEY, ''));
  let envPackages = $state(readStoredString(ENV_PACKAGES_KEY, 'python-can pyserial'));
  let envExistingPath = $state(readStoredString(ENV_EXISTING_PATH_KEY, ''));
  let envBusy = $state(false);
  let envSupported = $state<boolean | null>(null);
  let envMessageKey = $state<TranslationKey>('server.w2l_env_hint');
  let envMessageDetail = $state('');
  let envSetupLog = $state('');

  const stateLabelKey = $derived(STATE_LABELS[state]);
  const startDisabled = $derived(
    busy ||
    state === 'checking' ||
    state === 'absent' ||
    state === 'running' ||
    state === 'approving' ||
    state === 'starting' ||
    !w2lOriginUsable()
  );

  $effect(() => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(ADAPTER_MODE_KEY, adapterMode);
    localStorage.setItem(CAN_BUS_KEY, canBus.trim() || 'can0');
    localStorage.setItem(BRIDGE_PORT_KEY, String(normalizePort(bridgePort, DEFAULT_BRIDGE_PORT)));
    localStorage.setItem(W2L_PORT_KEY, String(normalizePort(w2lPort, DEFAULT_W2L_PORT)));
    localStorage.setItem(BITRATE_KEY, String(normalizePositiveInt(bitrate, DEFAULT_BITRATE)));
    localStorage.setItem(DATA_BITRATE_KEY, String(normalizePositiveInt(dataBitrate, DEFAULT_DATA_BITRATE)));
    localStorage.setItem(ENV_TYPE_KEY, envType);
    localStorage.setItem(ENV_NAME_KEY, envName.trim() || 'can-codec-bridge');
    localStorage.setItem(ENV_SETUP_PATH_KEY, envSetupPath.trim());
    localStorage.setItem(ENV_PACKAGES_KEY, envPackages.trim());
    localStorage.setItem(ENV_EXISTING_PATH_KEY, envExistingPath.trim());
  });

  function setMessage(key: TranslationKey, detail = '') {
    messageKey = key;
    messageDetail = detail;
  }

  function setEnvMessage(key: TranslationKey, detail = '') {
    envMessageKey = key;
    envMessageDetail = detail;
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function w2lOriginUsable(): boolean {
    return (
      typeof window !== 'undefined' &&
      window.location.origin !== 'null' &&
      /^https?:$/i.test(window.location.protocol)
    );
  }

  function w2lBase(): string {
    return `http://127.0.0.1:${normalizePort(w2lPort, DEFAULT_W2L_PORT)}`;
  }

  function onAdapterModeChange() {
    if (adapterMode === 'slcan' && canBus === 'can0') {
      canBus = '/dev/ttyACM0';
      if (!envPackages.trim()) envPackages = 'python-can pyserial';
    } else if (adapterMode === 'socketcan' && canBus.startsWith('/dev/tty')) {
      canBus = 'can0';
    }
  }

  async function ensureGraylisted(): Promise<void> {
    if (!w2lOriginUsable()) {
      const err = new Error('opaque origin') as Error & { code?: string };
      err.code = 'origin';
      throw err;
    }
    await w2lPostJson('/config/graylist', { origin: window.location.origin });
  }

  async function sha256Hex(text: string): Promise<string | null> {
    if (typeof crypto === 'undefined' || !crypto.subtle) return null;
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function verifyScriptHash(): Promise<void> {
    const got = await sha256Hex(SERVER_SCRIPT);
    if (got && got !== SERVER_SCRIPT_SHA256) {
      const err = new Error('bridge script hash mismatch') as Error & { code?: string };
      err.code = 'hash';
      throw err;
    }
  }

  async function w2lFetch(path: string, opts?: RequestInit, timeoutMs = 4000): Promise<Response> {
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(w2lBase() + path, {
        mode: 'cors',
        signal: ctrl.signal,
        ...(opts ?? {}),
      });
    } finally {
      clearTimeout(tm);
    }
  }

  async function w2lPostJson(path: string, body: unknown, timeoutMs = 4000): Promise<any> {
    const res = await w2lFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }, timeoutMs);
    let data: any = {};
    try { data = await res.json(); } catch { /* tolerate empty/non-JSON error bodies */ }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function commandHasPort(command: unknown[], port: number): boolean {
    const want = String(port);
    const i = command.indexOf('--port');
    if (i >= 0 && String(command[i + 1]) === want) return true;
    return command.some((arg) => arg === `--port=${want}`);
  }

  async function findBridgePid(port = bridgePort): Promise<number | null> {
    const wantPort = normalizePort(port, DEFAULT_BRIDGE_PORT);
    try {
      const res = await w2lFetch('/ps');
      if (!res.ok) return null;
      const data = await res.json();
      const processes = Array.isArray(data.processes) ? data.processes : [];
      const hit = processes.find((process: any) => {
        const command = process.command;
        if (!Array.isArray(command)) return false;
        const hasScript = command.some((arg) => typeof arg === 'string' && arg.endsWith(SERVER_FILENAME));
        return hasScript && commandHasPort(command, wantPort);
      });
      return typeof hit?.pid === 'number' ? hit.pid : null;
    } catch {
      return null;
    }
  }

  function probeWebSocket(url: string, timeoutMs: number): Promise<boolean> {
    if (typeof WebSocket === 'undefined') return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      let ws: WebSocket | null = null;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { ws?.close(); } catch { /* ignore close race */ }
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      try {
        ws = new WebSocket(url);
        ws.onopen = () => finish(true);
        ws.onerror = () => finish(false);
        ws.onclose = () => finish(false);
      } catch {
        finish(false);
      }
    });
  }

  async function pollBridgeUp(url: string, maxMs: number): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < maxMs) {
      if (await probeWebSocket(url, 1200)) return true;
      await sleep(700);
    }
    return false;
  }

  async function showLog(pid: number | null): Promise<void> {
    if (!pid) return;
    try {
      const res = await w2lFetch(`/logs?pid=${encodeURIComponent(String(pid))}`);
      if (!res.ok) return;
      const data = await res.json();
      logTail = typeof data.tail === 'string' ? data.tail : '';
    } catch {
      /* logs are best effort */
    }
  }

  function handleW2lError(err: unknown) {
    state = bridgePid ? 'running' : 'error';
    const e = err as Error & { code?: string; name?: string };
    const msg = e?.message || String(err);
    if (e?.name === 'AbortError') setMessage('server.w2l_error_timeout');
    else if (e?.code === 'hash') setMessage('server.w2l_hash_mismatch');
    else if (/denied/i.test(msg)) setMessage('server.w2l_denied');
    else if (/python3|not found|no such file|executable/i.test(msg)) setMessage('server.w2l_no_python');
    else if (/origin|whitelist|graylist/i.test(msg)) setMessage('server.w2l_origin_rejected');
    else setMessage('server.w2l_error_generic', msg);
  }

  function handleEnvError(err: unknown) {
    const e = err as Error & { code?: string; name?: string };
    const msg = e?.message || String(err);
    if (e?.name === 'AbortError') setEnvMessage('server.w2l_error_timeout');
    else if (/failed to fetch|networkerror|load failed|http 404/i.test(msg)) {
      envSupported = false;
      setEnvMessage('server.w2l_env_unsupported');
    }
    else if (/denied/i.test(msg)) setEnvMessage('server.w2l_env_denied');
    else if (/origin|whitelist|graylist/i.test(msg)) setEnvMessage('server.w2l_origin_rejected');
    else setEnvMessage('server.w2l_env_error', msg);
  }

  async function refreshEnvInfo(force = false): Promise<void> {
    if ((envBusy && !force) || !w2lOriginUsable()) return;
    envSetupLog = '';
    setEnvMessage('server.w2l_env_checking');
    try {
      await ensureGraylisted();
      const res = await w2lFetch('/env');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      envInfo = await res.json();
      envSupported = true;
      if (envInfo?.interpreter) {
        setEnvMessage('server.w2l_env_ready', `${envInfo.interpreter} (${envInfo.source})`);
      } else {
        setEnvMessage('server.w2l_env_path_fallback');
      }
    } catch (err) {
      envInfo = null;
      handleEnvError(err);
    }
  }

  async function pollEnvSetup(jobId: string): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < 10 * 60 * 1000) {
      await sleep(1500);
      const res = await w2lFetch(`/setup-env/status?job=${encodeURIComponent(jobId)}`, undefined, 8000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const status = await res.json();
      envSetupLog = status.tail || '';
      if (status.status === 'done') {
        setEnvMessage('server.w2l_env_ready', status.interpreter || '');
        await refreshEnvInfo(true);
        return;
      }
      if (status.status === 'failed') {
        throw new Error(status.error || 'environment setup failed');
      }
      setEnvMessage('server.w2l_env_creating', status.target || '');
    }
    throw new Error('environment setup timed out');
  }

  async function setupPythonEnv(): Promise<void> {
    if (envBusy) return;
    if (envSupported === false) {
      setEnvMessage('server.w2l_env_unsupported');
      return;
    }
    envBusy = true;
    envSetupLog = '';
    setEnvMessage('server.w2l_env_approve');
    try {
      await ensureGraylisted();
      const packages = envPackages.trim().split(/\s+/).filter(Boolean);
      const res = await w2lPostJson('/setup-env', {
        type: envType,
        name: envName.trim() || 'can-codec-bridge',
        path: envSetupPath.trim(),
        packages,
      }, 150000);
      if (res.status === 'ready') {
        setEnvMessage('server.w2l_env_ready', res.interpreter || '');
        await refreshEnvInfo(true);
        return;
      }
      setEnvMessage('server.w2l_env_creating', res.target || '');
      if (res.job_id) await pollEnvSetup(res.job_id);
      else await refreshEnvInfo();
    } catch (err) {
      handleEnvError(err);
    } finally {
      envBusy = false;
    }
  }

  async function selectExistingPythonEnv(): Promise<void> {
    if (envBusy) return;
    if (envSupported === false) {
      setEnvMessage('server.w2l_env_unsupported');
      return;
    }
    const path = envExistingPath.trim();
    if (!path) {
      setEnvMessage('server.w2l_env_select_missing');
      return;
    }
    envBusy = true;
    envSetupLog = '';
    setEnvMessage('server.w2l_env_select_approve');
    try {
      await ensureGraylisted();
      const res = await w2lPostJson('/env/select', { path }, 150000);
      envSupported = true;
      setEnvMessage('server.w2l_env_ready', res.interpreter || path);
      await refreshEnvInfo(true);
    } catch (err) {
      const e = err as Error & { name?: string };
      const msg = e?.message || String(err);
      if (/failed to fetch|networkerror|load failed|http 404/i.test(msg)) {
        try {
          const status = await w2lFetch('/status');
          if (status.ok) {
            setEnvMessage('server.w2l_env_select_unsupported');
            return;
          }
        } catch {
          /* fall through to the generic env error handler */
        }
      }
      handleEnvError(err);
    } finally {
      envBusy = false;
    }
  }

  async function refreshW2l() {
    if (busy || probing) return;
    if (!w2lOriginUsable()) {
      state = 'absent';
      setMessage('server.w2l_opaque_origin');
      return;
    }
    probing = true;
    state = 'checking';
    logTail = '';
    try {
      let ok = false;
      try { ok = (await w2lFetch('/status')).ok; } catch { ok = false; }
      if (!ok) {
        bridgePid = null;
        state = 'absent';
        envInfo = null;
        envSupported = null;
        setMessage('server.w2l_hint_absent');
        return;
      }
      refreshEnvInfo();
      const found = await findBridgePid();
      if (found) {
        bridgePid = found;
        state = 'running';
        setMessage('server.w2l_hint_running');
      } else {
        bridgePid = null;
        state = 'present';
        setMessage('server.w2l_hint_idle');
      }
    } finally {
      probing = false;
    }
  }

  async function startBridge() {
    if (busy) return;
    if (!w2lOriginUsable()) {
      setMessage('server.w2l_opaque_origin');
      return;
    }

    busy = true;
    logTail = '';
    bridgePort = normalizePort(bridgePort, DEFAULT_BRIDGE_PORT);
    w2lPort = normalizePort(w2lPort, DEFAULT_W2L_PORT);
    bitrate = normalizePositiveInt(bitrate, DEFAULT_BITRATE);
    dataBitrate = normalizePositiveInt(dataBitrate, DEFAULT_DATA_BITRATE);
    canBus = canBus.trim() || defaultBusFor(adapterMode);
    const targetUrl = `ws://localhost:${bridgePort}`;

    try {
      state = 'approving';
      setMessage('server.w2l_approve');
      await verifyScriptHash();
      await ensureGraylisted();
      if (!envInfo) await refreshEnvInfo(true);

      const args = [
        '--bus', canBus,
        '--interface', adapterMode,
        '--host', '127.0.0.1',
        '--port', String(bridgePort),
      ];
      if (adapterMode === 'slcan') {
        args.push('--bitrate', String(bitrate), '--data-bitrate', String(dataBitrate));
      }
      const res = await w2lPostJson('/deploy', {
        source: SERVER_SCRIPT,
        sha256: SERVER_SCRIPT_SHA256,
        filename: SERVER_FILENAME,
        command: 'python3',
        args,
      }, 150000);

      bridgePid = typeof res.pid === 'number' ? res.pid : await findBridgePid();
      state = 'starting';
      setMessage('server.w2l_starting');
      const up = await pollBridgeUp(targetUrl, 15000);
      if (up) {
        busStore.wsUrl = targetUrl;
        connect();
        state = 'running';
        bridgePid = bridgePid || await findBridgePid();
        setMessage('server.w2l_started');
        return;
      }
      state = bridgePid ? 'running' : 'present';
      setMessage('server.w2l_timeout');
      await showLog(bridgePid || await findBridgePid());
    } catch (err) {
      handleW2lError(err);
      await showLog(bridgePid);
    } finally {
      busy = false;
    }
  }

  async function stopBridge() {
    if (busy) return;
    busy = true;
    logTail = '';
    try {
      const port = normalizePort(bridgePort, DEFAULT_BRIDGE_PORT);
      const found = bridgePid || await findBridgePid(port);
      if (!found) {
        bridgePid = null;
        state = 'present';
        setMessage('server.w2l_not_running');
        return;
      }
      await w2lPostJson('/stop', { pid: found }, 15000);
      bridgePid = null;
      if (isLocalWsUrl(busStore.wsUrl, port)) disconnect();
      state = 'present';
      setMessage('server.w2l_stopped');
    } catch (err) {
      handleW2lError(err);
      await showLog(bridgePid);
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    refreshW2l();
  });
</script>

<div class="w2l-launcher" data-state={state}>
  <div class="w2l-header">
    <div class="w2l-copy">
      <div class="w2l-title">{t('server.w2l_title')}</div>
      <p>{t('server.w2l_body')}</p>
    </div>
    <div class="w2l-header-actions">
      <a class="w2l-brand-link" href={WEB2LOCAL_URL} target="_blank" rel="noopener noreferrer">web2local</a>
      <span class="w2l-chip {state}">{t(stateLabelKey)}</span>
    </div>
  </div>

  <div class="w2l-grid">
    <label>
      <span>{t('server.w2l_adapter_label')}</span>
      <select bind:value={adapterMode} onchange={onAdapterModeChange}>
        <option value="socketcan">{t('server.w2l_adapter_socketcan')}</option>
        <option value="slcan">{t('server.w2l_adapter_slcan')}</option>
      </select>
    </label>
    <label>
      <span>{adapterMode === 'slcan' ? t('server.w2l_device_label') : t('server.w2l_bus_label')}</span>
      <input type="text" bind:value={canBus} placeholder={defaultBusFor(adapterMode)} />
    </label>
    <label>
      <span>{t('server.w2l_bridge_port_label')}</span>
      <input
        type="number"
        min="1"
        max="65535"
        bind:value={bridgePort}
        onchange={() => refreshW2l()}
      />
    </label>
    {#if adapterMode === 'slcan'}
      <label>
        <span>{t('server.w2l_bitrate_label')}</span>
        <input
          type="number"
          min="1"
          bind:value={bitrate}
        />
      </label>
      <label>
        <span>{t('server.w2l_data_bitrate_label')}</span>
        <input
          type="number"
          min="1"
          bind:value={dataBitrate}
        />
      </label>
    {/if}
    <label>
      <span>{t('server.w2l_port_label')}</span>
      <input
        type="number"
        min="1"
        max="65535"
        bind:value={w2lPort}
        onchange={() => refreshW2l()}
      />
    </label>
  </div>

  {#if adapterMode === 'slcan'}
    <p class="w2l-note">{t('server.w2l_slcan_note')}</p>
  {/if}

  <div class="w2l-env">
    <div class="w2l-env-head">
      <div>
        <div class="w2l-section-title">{t('server.w2l_env_title')}</div>
        <p class="w2l-env-current">
          {#if envInfo?.interpreter}
            {envInfo.interpreter}
            <span>({envInfo.source})</span>
          {:else}
            {t('server.w2l_env_none')}
          {/if}
        </p>
      </div>
      <button class="btn-sm" type="button" onclick={() => refreshEnvInfo(true)} disabled={envBusy || state === 'absent'}>
        {t('server.w2l_env_refresh')}
      </button>
    </div>

    <div class="w2l-env-grid">
      <label>
        <span>{t('server.w2l_env_type_label')}</span>
        <select bind:value={envType}>
          <option value="venv">venv</option>
          <option value="pixi">pixi</option>
          <option value="conda">conda</option>
        </select>
      </label>
      <label>
        <span>{t('server.w2l_env_name_label')}</span>
        <input type="text" bind:value={envName} placeholder="can-codec-bridge" />
      </label>
      <label>
        <span>{t('server.w2l_env_path_label')}</span>
        <input type="text" bind:value={envSetupPath} placeholder={t('server.w2l_env_path_placeholder')} />
      </label>
      <label>
        <span>{t('server.w2l_env_packages_label')}</span>
        <input type="text" bind:value={envPackages} placeholder="python-can pyserial" />
      </label>
    </div>

    <div class="w2l-env-select">
      <label>
        <span>{t('server.w2l_env_existing_label')}</span>
        <input type="text" bind:value={envExistingPath} placeholder={t('server.w2l_env_existing_placeholder')} />
      </label>
      <button class="btn-sm" type="button" onclick={selectExistingPythonEnv} disabled={envBusy || state === 'absent' || envSupported === false}>
        {t('server.w2l_env_select')}
      </button>
    </div>

    <div class="w2l-actions">
      <button class="btn-sm" type="button" onclick={setupPythonEnv} disabled={envBusy || state === 'absent' || envSupported === false}>
        {envBusy ? t('server.w2l_state_working') : t('server.w2l_env_setup')}
      </button>
      {#if envSupported === false}
        <a class="btn-sm w2l-link" href={WEB2LOCAL_URL} target="_blank" rel="noopener noreferrer">
          {t('server.w2l_get')}
        </a>
      {/if}
    </div>

    <p class="w2l-message">
      {t(envMessageKey)}
      {#if envMessageDetail}
        <span>{envMessageDetail}</span>
      {/if}
    </p>

    {#if envSetupLog}
      <pre class="w2l-log">{envSetupLog}</pre>
    {/if}
  </div>

  <div class="w2l-actions">
    {#if state === 'running'}
      <button class="btn-sm danger" type="button" onclick={stopBridge} disabled={busy}>
        {t('server.w2l_stop')}
      </button>
    {:else}
      <button class="primary" type="button" onclick={startBridge} disabled={startDisabled}>
        {t('server.w2l_start')}
      </button>
    {/if}
    <button class="btn-sm" type="button" onclick={refreshW2l} disabled={busy}>
      {t('server.w2l_check')}
    </button>
    {#if state === 'absent' || state === 'error'}
      <a class="btn-sm w2l-link" href={WEB2LOCAL_URL} target="_blank" rel="noopener noreferrer">
        {t('server.w2l_get')}
      </a>
    {/if}
  </div>

  <p class="w2l-message">
    {t(messageKey)}
    {#if messageDetail}
      <span>{messageDetail}</span>
    {/if}
    {#if bridgePid}
      <span>PID {bridgePid}</span>
    {/if}
  </p>

  {#if logTail}
    <pre class="w2l-log">{logTail}</pre>
  {/if}
</div>

<style>
  .w2l-launcher {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
    margin: 10px 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--bg-input) 45%, transparent);
  }

  .w2l-header,
  .w2l-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
  }

  .w2l-copy {
    min-width: 220px;
    flex: 1;
  }

  .w2l-header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .w2l-title,
  .w2l-section-title {
    font-size: 13px;
    font-weight: 700;
    color: var(--text);
  }

  .w2l-brand-link {
    font-size: 12px;
    color: var(--accent);
    text-decoration: none;
    white-space: nowrap;
  }

  .w2l-brand-link:hover {
    text-decoration: underline;
  }

  .w2l-copy p,
  .w2l-message,
  .w2l-note {
    margin: 2px 0 0;
    font-size: 12px;
    color: var(--text-dim);
  }

  .w2l-message,
  .w2l-note {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .w2l-chip {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid var(--border);
    font-size: 11px;
    color: var(--text-dim);
    white-space: nowrap;
  }

  .w2l-chip.present,
  .w2l-chip.running {
    color: var(--green);
    border-color: rgba(63, 185, 80, 0.45);
    background: rgba(63, 185, 80, 0.10);
  }

  .w2l-chip.approving,
  .w2l-chip.starting {
    color: var(--orange);
    border-color: rgba(210, 153, 34, 0.45);
    background: rgba(210, 153, 34, 0.10);
  }

  .w2l-chip.absent,
  .w2l-chip.error {
    color: var(--red);
    border-color: rgba(248, 81, 73, 0.42);
    background: rgba(248, 81, 73, 0.08);
  }

  .w2l-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(120px, 1fr));
    gap: 8px;
  }

  .w2l-grid label {
    margin: 0;
  }

  .w2l-grid label span {
    display: block;
    margin-bottom: 4px;
    font-size: 11px;
    color: var(--text-dim);
  }

  .w2l-grid input,
  .w2l-grid select {
    padding: 6px 8px;
    font-size: 12px;
    border-radius: 6px;
  }

  .w2l-actions {
    justify-content: flex-start;
  }

  .w2l-link {
    text-decoration: none;
  }

  .w2l-log {
    max-height: 160px;
    overflow: auto;
    white-space: pre-wrap;
    color: var(--text-dim);
  }

  .w2l-env {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
  }

  .w2l-env-head {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .w2l-env-current {
    margin: 2px 0 0;
    font-size: 11px;
    color: var(--text-dim);
    word-break: break-all;
  }

  .w2l-env-current span {
    color: var(--accent);
  }

  .w2l-env-grid {
    display: grid;
    grid-template-columns: minmax(90px, 0.6fr) minmax(120px, 0.9fr) minmax(180px, 1.4fr) minmax(180px, 1.4fr);
    gap: 8px;
  }

  .w2l-env-grid label {
    margin: 0;
  }

  .w2l-env-grid label span {
    display: block;
    margin-bottom: 4px;
    font-size: 11px;
    color: var(--text-dim);
  }

  .w2l-env-grid input,
  .w2l-env-grid select {
    padding: 6px 8px;
    font-size: 12px;
    border-radius: 6px;
  }

  .w2l-env-select {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    flex-wrap: wrap;
  }

  .w2l-env-select label {
    flex: 1 1 240px;
    margin: 0;
  }

  .w2l-env-select label span {
    display: block;
    margin-bottom: 4px;
    font-size: 11px;
    color: var(--text-dim);
  }

  .w2l-env-select input {
    width: 100%;
    padding: 6px 8px;
    font-size: 12px;
    border-radius: 6px;
  }

  @media (max-width: 640px) {
    .w2l-grid,
    .w2l-env-grid {
      grid-template-columns: 1fr;
    }

    .w2l-env-select {
      align-items: stretch;
    }
  }
</style>
