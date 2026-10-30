<script lang="ts">
  import { Link } from '@immich/ui';

  let { assetId }: { assetId: string } = $props();
  let applied = $state<{ assetId: string; name: string }>();

  $effect(() => {
    const id = assetId;
    const controller = new AbortController();
    applied = undefined;
    const load = async () => {
      try {
        const response = await fetch(`/api/admin/log-preview/assets/${encodeURIComponent(id)}/applied-lut`, {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) {
          return;
        }
        const { lut }: { lut: { id: string; name: string } | null } = await response.json();
        if (!controller.signal.aborted && lut?.name) {
          applied = { assetId: id, name: lut.name };
        }
      } catch {
        // 切换素材、请求失败或未生成预览时不显示误导性的还原提示。
      }
    };
    void load();
    return () => controller.abort();
  });
</script>

{#if applied?.assetId === assetId}
  <div class="px-4 py-2">
    <Link href={`/admin/system-settings?logAsset=${assetId}&isOpen=video-transcoding%20log-preview`}>
      LUT:{applied.name}
    </Link>
  </div>
{/if}
