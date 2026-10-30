<script lang="ts">
  import { page } from '$app/state';
  import SettingSwitch from '$lib/components/shared-components/settings/SettingSwitch.svelte';
  import { systemConfigManager } from '$lib/managers/system-config-manager.svelte';
  import type { LogPreviewConfigDto, LogPreviewRuleDto } from '@immich/sdk';
  import { Button } from '@immich/ui';
  import { onMount } from 'svelte';
  import SettingSelect from './SettingSelect.svelte';

  type Profile = LogPreviewRuleDto['profile'];
  type Lut = { id: string; name: string; profile: Profile; size: number };
  type Status = { status?: string; lutName?: string; error?: string };
  type Inspection = {
    id: string;
    fileName: string;
    detection: { model: string; profile?: Profile; source: string };
    selectedLut?: Lut;
    override: { mode: 'auto' | 'off' | 'manual'; profile?: Profile; lutId?: string };
    video?: Status;
    thumbnail?: Status;
  };
  let { config = $bindable(), disabled = false }: { config: LogPreviewConfigDto; disabled?: boolean } = $props();
  let luts = $state<Lut[]>([]);
  let profiles = $state<Record<Profile, string>>({
    'sony-slog3-cine': 'Sony S-Gamut3.Cine / S-Log3',
    'sony-slog3': 'Sony S-Gamut3 / S-Log3',
    'dji-dlog-m': 'DJI D-Log M',
    'dji-dlog': 'DJI D-Log',
  });
  let busy = $state(false);
  let error = $state('');
  let notice = $state('');
  let uploadName = $state('');
  let uploadProfile = $state<Profile>('sony-slog3-cine');
  let uploadFile = $state<File>();
  let assetLink = $state(page.url.searchParams.get('logAsset') ?? '');
  let asset = $state<Inspection>();
  let sampleLut = $state('');
  let previewVersion = $state(0);
  let previewReady = $state(false);
  let overrideMode = $state<'auto' | 'off' | 'manual'>('auto');
  let overrideProfile = $state<Profile>('sony-slog3-cine');
  let overrideLut = $state('');
  const profileOptions = $derived(Object.entries(profiles).map(([value, text]) => ({ value, text })));
  const lutOptions = (profile: string) => [
    { value: '', text: '不还原 / 尚未选择' },
    ...luts.filter((l) => l.profile === profile).map((l) => ({ value: l.id, text: l.name })),
  ];
  const statusText = (state?: Status) =>
    ({ queued: '等待处理', processing: '处理中', complete: '已完成', failed: '失败' })[state?.status ?? ''] ??
    '尚未生成';

  async function api<T>(path = '', data?: unknown, method = 'POST'): Promise<T> {
    const response = await fetch(
      `/api/admin/log-preview${path}`,
      data === undefined
        ? {}
        : {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
          },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message ?? `请求失败（${response.status}）`);
    }
    return response.json();
  }
  async function run(action: () => Promise<void>) {
    busy = true;
    error = '';
    notice = '';
    try {
      await action();
    } catch (error_) {
      error = (error_ as Error).message;
    } finally {
      busy = false;
    }
  }
  async function load() {
    const result = await api<{ profiles: Record<Profile, string>; luts: Lut[] }>();
    profiles = result.profiles;
    luts = result.luts;
  }
  async function inspect() {
    const id = assetLink.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i)?.[0];
    if (!id) {throw new Error('请粘贴 Immich 视频链接，或从视频详情的“Log 预览还原”进入');}
    asset = await api<Inspection>(`/assets/${id}`);
    overrideMode = asset.override.mode;
    overrideProfile = asset.override.profile ?? asset.detection.profile ?? 'sony-slog3-cine';
    overrideLut = asset.override.lutId ?? asset.selectedLut?.id ?? '';
    sampleLut =
      asset.selectedLut?.id ?? config.rules.find((r) => r.profile === asset?.detection.profile && r.lutId)?.lutId ?? '';
    previewReady = false;
  }
  async function upload() {
    if (!uploadFile || !uploadName.trim()) {throw new Error('请选择 .cube 文件并填写名称');}
    if (uploadFile.size > 8 * 1024 * 1024) {throw new Error('LUT 文件不能超过 8 MiB');}
    const lut = await api<Lut>('/luts', { name: uploadName, profile: uploadProfile, content: await uploadFile.text() });
    await load();
    notice = `已导入“${lut.name}”。请在对应机型的规则中选择，并使用页面底部的保存按钮。`;
  }
  onMount(() => {
    void run(async () => {
      await load();
      if (assetLink) {await inspect();}
    });
  });
</script>

<div class="ms-4 mt-4 flex flex-col gap-5 text-sm">
  <SettingSwitch
    title="启用 Log 预览还原"
    subtitle="自动识别 Log，为播放预览、封面和缩略图套用对应 LUT。原片保持不变。"
    bind:checked={config.enabled}
    {disabled}
    isEdited={config.enabled !== systemConfigManager.value.ffmpeg.logPreview.enabled}
  />
  <p class="text-sm dark:text-immich-dark-fg">
    各机型使用自己的默认还原 LUT；同一机型的不同 Log / 色域分别匹配。机型留空表示该 Log
    类型的通用规则。无法识别的素材保留原样。
  </p>
  {#each config.rules as rule, index (index)}
    <div class="rounded-lg border border-gray-300 p-4 dark:border-gray-600">
      <label class="mb-2 block font-medium" for={`log-model-${index}`}>机型</label>
      <input
        id={`log-model-${index}`}
        class="mb-3 immich-form-input w-full"
        placeholder="例如 ILCE-7CM2、Osmo Pocket 3"
        bind:value={rule.model}
        {disabled}
      />
      <SettingSelect
        name={`log-profile-${index}`}
        label="Log 类型 / 输入色域"
        options={profileOptions}
        bind:value={rule.profile}
        onSelect={() => (rule.lutId = '')}
        {disabled}
      />
      <SettingSelect
        name={`log-lut-${index}`}
        label="默认还原 LUT"
        options={lutOptions(rule.profile)}
        bind:value={rule.lutId}
        {disabled}
      />
      <Button
        size="small"
        variant="ghost"
        {disabled}
        onclick={() => (config.rules = config.rules.filter((_, i) => i !== index))}>移除这条规则</Button
      >
    </div>
  {/each}
  <div>
    <Button
      size="small"
      color="secondary"
      {disabled}
      onclick={() => (config.rules = [...config.rules, { model: '', profile: 'sony-slog3-cine', lutId: '' }])}
      >添加机型 / Log 规则</Button
    >
  </div>

  <details class="rounded-lg border border-gray-300 p-4 dark:border-gray-600">
    <summary class="cursor-pointer font-medium">导入自定义 LUT</summary>
    <div class="mt-4 flex flex-col gap-3">
      <label for="log-upload-name">LUT 名称</label>
      <input
        id="log-upload-name"
        class="immich-form-input"
        bind:value={uploadName}
        placeholder="例如 Sony 709(800%) 自然还原"
        {disabled}
      />
      <SettingSelect
        name="log-upload-profile"
        label="LUT 接受的输入类型"
        options={profileOptions}
        bind:value={uploadProfile}
        {disabled}
      />
      <label for="log-upload-file">3D .cube 文件（最大 65 格）</label>
      <input
        id="log-upload-file"
        type="file"
        accept=".cube"
        {disabled}
        onchange={(event) => (uploadFile = event.currentTarget.files?.[0])}
      />
      <p>请选择直接将所选 Log 还原到 Rec.709 的 LUT。Rec.709 输入的风格 LUT 不能直接用于 Log 原片。</p>
      <div><Button size="small" disabled={disabled || busy} onclick={() => run(upload)}>导入 LUT</Button></div>
    </div>
  </details>

  <details open={Boolean(assetLink)} class="rounded-lg border border-gray-300 p-4 dark:border-gray-600">
    <summary class="cursor-pointer font-medium">样片对照与单片设置</summary>
    <div class="mt-4 flex flex-col gap-3">
      <label for="log-sample-link">Immich 视频链接</label>
      <input
        id="log-sample-link"
        class="immich-form-input"
        bind:value={assetLink}
        placeholder="粘贴视频链接，或从视频详情进入"
      />
      <div class="flex flex-wrap gap-2">
        <Button size="small" disabled={busy} onclick={() => run(inspect)}>识别 / 刷新状态</Button>
        {#if asset}<a class="text-primary underline" href={`/photos/${asset.id}`}>打开此视频</a>{/if}
      </div>
      {#if asset}
        <p class="font-medium">{asset.fileName}</p>
        <p>
          {asset.detection.model || '机型未知'} · {asset.detection.profile
            ? profiles[asset.detection.profile]
            : '未识别到可靠的 Log 标记'}
        </p>
        <p>
          播放预览：{statusText(asset.video)}{asset.video?.lutName
            ? ` · ${asset.video.lutName}`
            : ''}；缩略图：{statusText(asset.thumbnail)}
        </p>
        {#if asset.video?.error || asset.thumbnail?.error}<p class="text-red-600">
            {asset.video?.error || asset.thumbnail?.error}
          </p>{/if}
        <SettingSelect
          name="log-sample-lut"
          label="对照 LUT（只影响下面的样片对照）"
          options={[{ value: '', text: '选择 LUT' }, ...luts.map((l) => ({ value: l.id, text: l.name }))]}
          bind:value={sampleLut}
        />
        <div>
          <Button
            size="small"
            disabled={!sampleLut || busy}
            onclick={() => {
              previewVersion++;
              previewReady = true;
            }}>生成同一帧对照</Button
          >
        </div>
        {#if previewReady && sampleLut}
          <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <figure>
              <img
                class="w-full rounded-sm"
                alt="Log 原片，同一时间点"
                src={`/api/admin/log-preview/assets/${asset.id}/frame?seconds=1&v=${previewVersion}`}
              />
              <figcaption>原片</figcaption>
            </figure>
            <figure>
              <img
                class="w-full rounded-sm"
                alt="套用所选 LUT 后的同一帧"
                src={`/api/admin/log-preview/assets/${asset.id}/frame?seconds=1&lutId=${sampleLut}&v=${previewVersion}`}
              />
              <figcaption>{luts.find((l) => l.id === sampleLut)?.name}</figcaption>
            </figure>
          </div>
        {/if}
        <SettingSelect
          name="log-override-mode"
          label="此视频的还原方式"
          options={[
            { value: 'auto', text: '自动匹配默认规则' },
            { value: 'off', text: '关闭还原' },
            { value: 'manual', text: '手动指定 Log 和 LUT' },
          ]}
          bind:value={overrideMode}
          {disabled}
        />
        {#if overrideMode === 'manual'}
          <SettingSelect
            name="log-override-profile"
            label="输入 Log 类型"
            options={profileOptions}
            bind:value={overrideProfile}
            onSelect={() => (overrideLut = '')}
            {disabled}
          />
          <SettingSelect
            name="log-override-lut"
            label="此视频的 LUT"
            options={lutOptions(overrideProfile)}
            bind:value={overrideLut}
            {disabled}
          />
        {/if}
        <div>
          <Button
            size="small"
            disabled={disabled || busy}
            onclick={() =>
              run(async () => {
                asset = await api<Inspection>(
                  `/assets/${asset!.id}`,
                  {
                    mode: overrideMode,
                    ...((overrideMode === 'manual') && { profile: overrideProfile, lutId: overrideLut }),
                  },
                  'PUT',
                );
                notice = '单片设置已保存，预览已加入后台重建队列。';
              })}>保存单片设置并重建预览</Button
          >
        </div>
      {/if}
    </div>
  </details>
  <p>
    页面底部“保存”会保存开关和默认规则，并重建已识别且受影响的预览。首次处理历史素材时，先保存设置，再执行扫描。换 LUT
    需要后台重新生成视频。
  </p>
  <div>
    <Button
      size="small"
      color="secondary"
      disabled={disabled || busy}
      onclick={() =>
        run(async () => {
          await api('/rebuild', {});
          notice = '历史视频扫描已加入后台任务；只为匹配规则的 Log 素材重建预览。可在“任务队列”查看处理进度。';
        })}>扫描已有视频并生成 Log 预览</Button
    >
  </div>
  <p class="text-sm dark:text-immich-dark-fg">
    手机直接播放本机原片时仍显示 Log 原始画面。LUT 文件独立保存；备份时请同时保留它们。
  </p>
  {#if notice}<p role="status" class="rounded-sm bg-green-100 p-3 text-green-900">{notice}</p>{/if}
  {#if error}<p role="alert" class="rounded-sm bg-red-100 p-3 text-red-900">{error}</p>{/if}
</div>
