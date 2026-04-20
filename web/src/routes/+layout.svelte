<script lang="ts">
  import '../app.css';
  import { page } from '$app/stores';
  import { codecStore } from '$lib/codec-store.svelte';

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
      <a href="/" class:active={$page.url.pathname === '/'}>Messages</a>
      <a href="/decode" class:active={$page.url.pathname === '/decode'}>Decode</a>
      <a href="/encode" class:active={$page.url.pathname === '/encode'}>Encode</a>
      <a href="/plot" class:active={$page.url.pathname === '/plot'}>Plot</a>
    </div>
    <div style="margin-left: auto; display: flex; align-items: center; gap: 12px;">
      <span style="font-size: 13px; color: var(--text-dim);">
        {codecStore.configs.length} config{codecStore.configs.length !== 1 ? 's' : ''} loaded
      </span>
      <input bind:this={fileInput} type="file" accept=".yaml,.yml,.xml" multiple
        style="display:none" onchange={(e) => handleFiles((e.target as HTMLInputElement).files)} />
      <input bind:this={folderInput} type="file" accept=".yaml,.yml,.xml"
        style="display:none" onchange={(e) => handleFiles((e.target as HTMLInputElement).files)}
        webkitdirectory />
      <button onclick={() => fileInput.click()}>+ Files</button>
      <button onclick={() => folderInput.click()}>+ Folder</button>
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
