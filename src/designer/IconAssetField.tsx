import { useId, useLayoutEffect, useRef, useState, type ChangeEvent } from 'react';
import { AlertCircle, Image as ImageIcon, Upload, X } from 'lucide-react';
import type { Asset, Locale } from '../core/types';
import './designer.css';

export interface IconAssetFieldProps {
  label: string;
  assets: readonly Asset[];
  assetId?: string;
  locale: Locale;
  onImport: (asset: Asset) => void;
  onChange: (id: string | undefined) => void;
}

export function IconAssetField({
  label,
  assets,
  assetId,
  locale,
  onImport,
  onChange,
}: IconAssetFieldProps) {
  const [error, setError] = useState('');
  const reader = useRef<FileReader | null>(null);
  const generation = useRef(0);
  const errorId = useId();
  const zh = locale === 'zh-CN';
  const asset = assets.find((item) => item.id === assetId);
  useLayoutEffect(() => {
    setError('');
    return () => {
      generation.current++;
      reader.current?.abort();
      reader.current = null;
    };
  }, [label, assetId]);

  const importIcon = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const request = ++generation.current;
    reader.current?.abort();
    reader.current = null;
    if (file.size > 5 * 1024 * 1024) {
      setError(zh ? '图标文件不能超过 5 MB。' : 'Icon files must be 5 MB or smaller.');
      return;
    }
    if (!/\.(png|svg|ico|jpg|jpeg|webp)$/i.test(file.name)) {
      setError(
        zh
          ? '请选择 PNG、SVG、ICO、JPG 或 WebP 图片。'
          : 'Choose a PNG, SVG, ICO, JPG or WebP image.',
      );
      return;
    }
    setError('');
    try {
      const source = await new Promise<string>((resolve, reject) => {
        const next = new FileReader();
        reader.current = next;
        next.onload = () => resolve(String(next.result));
        next.onerror = () => reject(next.error);
        next.onabort = () => reject(new Error('Icon import cancelled'));
        next.readAsDataURL(file);
      });
      if (generation.current !== request) return;
      reader.current = null;
      const extension = file.name.split('.').pop()!.toLowerCase();
      const mime = (
        {
          svg: 'image/svg+xml',
          ico: 'image/x-icon',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          webp: 'image/webp',
          png: 'image/png',
        } as Record<string, string>
      )[extension];
      const data = `data:${mime};base64,${source.slice(source.indexOf(',') + 1)}`;
      onImport({ id: crypto.randomUUID(), name: file.name, mime, data });
      setError('');
    } catch {
      if (generation.current !== request) return;
      reader.current = null;
      setError(zh ? '无法读取图标文件，请重试。' : 'Could not read the icon. Please try again.');
    }
  };

  return (
    <div className="qg-icon-field" role="group" aria-label={label}>
      <span className="qg-field-label">{label}</span>
      <div className="qg-icon-import">
        <div className="qg-icon-preview">
          {asset ? (
            <img src={asset.data} alt={asset.name} />
          ) : (
            <ImageIcon size={22} aria-hidden="true" />
          )}
        </div>
        <div className="qg-icon-import-copy">
          <strong title={asset?.name}>{asset?.name ?? (zh ? '默认图标' : 'Default icon')}</strong>
          <label className="qg-upload-label">
            <Upload size={12} aria-hidden="true" />
            {zh ? '导入图标' : 'Import icon'}
            <input
              type="file"
              accept=".png,.svg,.ico,.jpg,.jpeg,.webp"
              aria-label={zh ? `导入${label}` : `Import ${label}`}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? errorId : undefined}
              onChange={(event) => void importIcon(event)}
            />
          </label>
        </div>
        {assetId && (
          <button
            type="button"
            className="qg-icon-button"
            aria-label={zh ? `移除${label}` : `Remove ${label}`}
            onClick={() => {
              generation.current++;
              reader.current?.abort();
              reader.current = null;
              onChange(undefined);
              setError('');
            }}
          >
            <X size={13} />
          </button>
        )}
      </div>
      {error && (
        <div className="qg-error" role="alert" id={errorId}>
          <AlertCircle size={14} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
