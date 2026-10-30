import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import DetailPanelLut from './DetailPanelLut.svelte';

const response = (name: string | null) => ({
  ok: true,
  json: () => Promise.resolve({ lut: name ? { id: 'lut-id', name } : null }),
});

describe('视频详情的 LUT 提示', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('未套 LUT 时没有提示或设置链接', async () => {
    const fetch = vi.fn().mockResolvedValue(response(null));
    vi.stubGlobal('fetch', fetch);
    render(DetailPanelLut, { props: { assetId: 'normal-video' } });
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('显示已应用的具体 LUT 名称', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response('Sony 709(800%) · S-Gamut3.Cine/S-Log3')));
    render(DetailPanelLut, { props: { assetId: 'log-video' } });
    const link = await screen.findByRole('link', { name: 'LUT:Sony 709(800%) · S-Gamut3.Cine/S-Log3' });
    expect(link).toHaveAttribute(
      'href',
      '/admin/system-settings?logAsset=log-video&isOpen=video-transcoding%20log-preview',
    );
  });

  it('快速切换到未套 LUT 的视频，不会被旧请求迟到的结果污染', async () => {
    let completeOld: (value: ReturnType<typeof response>) => void = () => {};
    const oldRequest = new Promise<ReturnType<typeof response>>((resolve) => {
      completeOld = resolve;
    });
    const fetch = vi.fn().mockReturnValueOnce(oldRequest).mockResolvedValueOnce(response(null));
    vi.stubGlobal('fetch', fetch);
    const { rerender } = render(DetailPanelLut, { props: { assetId: 'old-log-video' } });
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await rerender({ assetId: 'new-normal-video' });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    completeOld(response('旧视频 LUT'));
    await oldRequest;
    await Promise.resolve();
    flushSync();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
