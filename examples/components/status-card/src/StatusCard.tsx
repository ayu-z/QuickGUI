import { useState } from 'react';
import type { ComponentProps } from './sdk';

export default function StatusCard({ props, emit, context }: ComponentProps) {
  const [presses, setPresses] = useState(0);
  const zh = context.locale === 'zh-CN';
  return <section className="status-card">
    <header><span className="status-indicator" /><span>{String(props.label)}</span><small>REACT</small></header>
    <div className="reading"><strong>{String(props.value)}</strong><span>{String(props.unit)}</span></div>
    <footer><span>{zh ? '本地点击' : 'Local presses'}: <b>{presses}</b></span><button disabled={!context.interactive} onClick={() => { setPresses(count => count + 1); emit('advance', Number(props.value) + 1); }}>{zh ? '启动循环' : 'Advance cycle'} →</button></footer>
  </section>;
}
