import type { Flow, FlowBinding } from '../core/types';
import { flowBindingId, manualFlowEntries } from '../core/flowBindings';

export function FlowBindingSelect({
  binding,
  flows,
  zh,
  label,
  onChange,
}: {
  binding?: FlowBinding;
  flows: Flow[];
  zh: boolean;
  label: string;
  onChange: (binding: FlowBinding | undefined) => void;
}) {
  const flow = binding ? flows.find((flow) => flow.id === flowBindingId(binding)) : undefined;
  const entries = flow ? manualFlowEntries(flow) : [];
  return (
    <>
      <select
        aria-label={`${label} ${zh ? '流程' : 'flow'}`}
        value={flow?.id ?? ''}
        onChange={(event) => {
          const selected = flows.find((flow) => flow.id === event.target.value);
          const inputs = selected ? manualFlowEntries(selected) : [];
          onChange(
            selected
              ? inputs.length > 1
                ? { flowId: selected.id, entryNodeId: inputs[0].id }
                : selected.id
              : undefined,
          );
        }}
      >
        <option value="">{zh ? '无关联流程' : 'No flow'}</option>
        {flows.map((item) => (
          <option key={item.id} value={item.id} disabled={!manualFlowEntries(item).length}>
            {item.name}
          </option>
        ))}
      </select>
      {(entries.length > 1 || (binding && typeof binding !== 'string')) && (
        <select
          aria-label={`${label} ${zh ? '入口' : 'entry'}`}
          value={typeof binding === 'object' ? binding.entryNodeId : (entries[0]?.id ?? '')}
          onChange={(event) =>
            flow && onChange({ flowId: flow.id, entryNodeId: event.target.value })
          }
        >
          {entries.map((node) => (
            <option key={node.id} value={node.id}>
              {node.label}
            </option>
          ))}
        </select>
      )}
    </>
  );
}
