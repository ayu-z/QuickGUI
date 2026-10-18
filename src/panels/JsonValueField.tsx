import { useEffect, useRef, useState } from 'react';
import type { Json } from '../core/types';
import { assertJsonValue } from '../core/jsonValue';

export function JsonValueField({
  value,
  onCommit,
  label,
  disabled = false,
}: {
  value: Json;
  onCommit: (value: Json) => void;
  label: string;
  disabled?: boolean;
}) {
  const encoded = JSON.stringify(value, null, 2);
  const [draft, setDraft] = useState(encoded),
    [error, setError] = useState(''),
    [editing, setEditing] = useState(false);
  const cancel = useRef(false),
    initial = useRef(encoded);
  useEffect(() => {
    if (!editing) setDraft(encoded);
  }, [encoded, editing]);
  const commit = () => {
    if (cancel.current) {
      cancel.current = false;
      return;
    }
    if (draft === initial.current) {
      setEditing(false);
      return;
    }
    try {
      const parsed = JSON.parse(draft);
      assertJsonValue(parsed);
      onCommit(parsed);
      setError('');
      setEditing(false);
    } catch (error) {
      setError(String(error));
    }
  };
  return (
    <div className="json-value-field">
      <textarea
        aria-label={label}
        rows={3}
        disabled={disabled}
        value={draft}
        onFocus={() => {
          initial.current = encoded;
          setEditing(true);
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          setError('');
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') {
            cancel.current = true;
            setDraft(encoded);
            setError('');
            setEditing(false);
            event.currentTarget.blur();
          } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            commit();
          }
        }}
      />
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
