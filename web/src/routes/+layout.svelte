<script lang="ts">
  import '../app.css';
  import { page } from '$app/stores';
  import { codecStore } from '$lib/codec-store.svelte';
  import { i18n, t } from '$lib/i18n.svelte';

  let fileInput: HTMLInputElement;
  let folderInput: HTMLInputElement;

  async function handleFiles(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      codecStore.addConfig(file.name, await file.text());
    }
  }
</script>

<nav>
  <div class="nav-inner">
    <span class="logo">CAN Codec</span>
    <div class="nav-links">
      <a href="/" class:active={$page.url.pathname === '/'}>{t('nav.messages')}</a>
      <a href="/decode" class:active={$page.url.pathname === '/decode'}>{t('nav.decode')}</a>
      <a href="/encode" class:active={$page.url.pathname === '/encode'}>{t('nav.encode')}</a>
      <a href="/plot" class:active={$page.url.pathname === '/plot'}>{t('nav.plot')}</a>
      <a href="/convert" class:active={$page.url.pathname === '/convert'}>{t('nav.convert')}</a>
      <a href="/docs" class:active={$page.url.pathname === '/docs'}>{t('nav.docs')}</a>
      <a href="/changelog" class:active={$page.url.pathname === '/changelog'}>{t('nav.changelog')}</a>
    </div>
    <div style="margin-left: auto; display: flex; align-items: center; gap: 12px;">
      <span style="font-size: 13px; color: var(--text-dim);">
        {#if codecStore.enabledCount === codecStore.configs.length}
          {#if i18n.locale === 'en'}
            {codecStore.configs.length} {codecStore.configs.length !== 1 ? t('nav.configs_loaded') : t('nav.config_loaded')}
          {:else}
            {codecStore.configs.length} {t('nav.configs_loaded')}
          {/if}
        {:else}
          {codecStore.enabledCount}/{codecStore.configs.length} {t('nav.configs_enabled')}
        {/if}
      </span>
      <input bind:this={fileInput} type="file" accept=".yaml,.yml,.xml" multiple
        style="display:none" onchange={(e) => handleFiles((e.target as HTMLInputElement).files)} />
      <input bind:this={folderInput} type="file" accept=".yaml,.yml,.xml"
        style="display:none" onchange={(e) => handleFiles((e.target as HTMLInputElement).files)}
        webkitdirectory />
      <button onclick={() => fileInput.click()}>{t('nav.add_files')}</button>
      <button onclick={() => folderInput.click()}>{t('nav.add_folder')}</button>
      <div class="lang-toggle" title={t('lang.toggle_title')}>
        <button
          class:lang-active={i18n.locale === 'en'}
          onclick={() => i18n.setLocale('en')}
        >EN</button>
        <button
          class:lang-active={i18n.locale === 'zh'}
          onclick={() => i18n.setLocale('zh')}
        >中文</button>
      </div>
    </div>
  </div>
</nav>

{#if codecStore.error}
  <div class="container">
    <div class="alert error" style="margin-top: 16px;">
      {codecStore.error}
      <button style="float:right; padding: 0; background: none; border: none; color: var(--red); cursor: pointer;"
        onclick={() => (codecStore.error = null)}>✕</button>
    </div>
  </div>
{/if}

<slot />

<style>
  .lang-toggle {
    display: inline-flex;
    gap: 2px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 2px;
    flex-shrink: 0;
  }
  .lang-toggle button {
    padding: 3px 8px;
    font-size: 11px;
    background: none;
    border: none;
    color: var(--text-dim);
    cursor: pointer;
    border-radius: 4px;
    line-height: 1.2;
    white-space: nowrap;
  }
  .lang-toggle button.lang-active {
    background: var(--accent);
    color: #0f1419;
    font-weight: 600;
  }
</style>
