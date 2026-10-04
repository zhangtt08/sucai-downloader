import { memo } from 'react';
import type { AssetItem } from '../services/types';
import { CheckIcon, DownloadIcon, VideoIcon } from './Icons';

export const fallbackImage = `data:image/svg+xml,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">
    <rect width="640" height="480" fill="#e9edf5"/>
    <path d="M240 284l52-52a22 22 0 0131 0l29 29 23-23a22 22 0 0131 0l54 54v32H180v-8l60-32z" fill="#b5bfd1"/>
    <circle cx="398" cy="177" r="25" fill="#b5bfd1"/>
  </svg>
`)}`;

// 一次搜索聚合出来的条目很容易上百张。勾选/取勾只该让变化的那两张重画，
// 所以卡片整体 memo —— 没有它，选中一项会把整屏几百张卡片全部重渲染一遍。
export const AssetCard = memo(function AssetCard({
  item,
  selected,
  onSelect,
  onDownload,
}: {
  item: AssetItem;
  selected: boolean;
  onSelect: (item: AssetItem, multi: boolean) => void;
  onDownload: (item: AssetItem) => void;
}) {
  return (
    <article aria-selected={selected} className="thumbnail-card group">
      <button
        aria-label={`预览 ${item.title || '未命名素材'}`}
        className="block w-full cursor-zoom-in text-left focus-visible:outline-none"
        onClick={() => onSelect(item, false)}
        type="button"
      >
        <img
          alt={item.title || '素材缩略图'}
          className="block h-auto w-full bg-surface-muted"
          height={item.height || undefined}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={(event) => {
            event.currentTarget.onerror = null;
            if (event.currentTarget.src !== fallbackImage) event.currentTarget.src = fallbackImage;
          }}
          src={item.thumbnailUrl || item.previewUrl || fallbackImage}
          width={item.width || undefined}
        />
        <div className="thumbnail-overlay">
          <p className="truncate text-xs font-medium text-white">{item.title || '未命名素材'}</p>
          <p className="mt-0.5 truncate text-[11px] text-white/70">
            {item.author || '未知作者'}
            {item.width && item.height ? ` · ${item.width}×${item.height}` : ''}
          </p>
        </div>
      </button>

      {item.mediaType === 'video' && (
        <span className="media-label">
          <VideoIcon className="size-3" />
          {item.duration ? `${Math.round(item.duration)} 秒` : '视频'}
        </span>
      )}

      <button
        aria-label={selected ? '取消选择' : '选择素材'}
        aria-pressed={selected}
        className="select-control"
        onClick={(event) => {
          event.stopPropagation();
          onSelect(item, true);
        }}
        type="button"
      >
        <CheckIcon className="size-3.5" />
      </button>
      <button
        aria-label={`下载 ${item.title || '图片'}`}
        className="quick-download"
        onClick={(event) => {
          event.stopPropagation();
          onDownload(item);
        }}
        title="直接下载"
        type="button"
      >
        <DownloadIcon className="size-3.5" />
      </button>
    </article>
  );
});

export function AssetGrid({
  items,
  selected,
  onSelect,
  onDownload,
}: {
  items: AssetItem[];
  selected: Set<string>;
  onSelect: (item: AssetItem, multi: boolean) => void;
  onDownload: (item: AssetItem) => void;
}) {
  return (
    <div className="masonry-grid">
      {items.map((item) => (
        <AssetCard
          item={item}
          key={`${item.source}_${item.sourceId}`}
          onDownload={onDownload}
          onSelect={onSelect}
          selected={selected.has(`${item.source}_${item.sourceId}`)}
        />
      ))}
    </div>
  );
}

export function SkeletonGrid({ count = 8 }: { count?: number }) {
  return (
    <div aria-label="正在加载素材" className="masonry-grid">
      {Array.from({ length: count }, (_, index) => (
        <div className={`skeleton-card skeleton-card-${(index % 3) + 1}`} key={index}>
          <span className="skeleton-shimmer" />
        </div>
      ))}
    </div>
  );
}
