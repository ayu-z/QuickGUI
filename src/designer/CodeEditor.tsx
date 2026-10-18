import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/editor/editor.all';
import 'monaco-editor/esm/vs/language/json/monaco.contribution';
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import './designer.css';

// Import the editor and every worker locally. No AMD loader or CDN is involved.
(globalThis as typeof globalThis & { MonacoEnvironment?: unknown }).MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    return label === 'json' ? new JsonWorker() : new EditorWorker();
  },
};

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language?: 'json' | 'c';
  height?: number | string;
}

export function CodeEditor({ value, onChange, language = 'json', height = 360 }: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const changeRef = useRef(onChange);
  const valueRef = useRef(value);
  const syncing = useRef(false);
  const [fallback, setFallback] = useState(false);
  const [theme, setTheme] = useState(
    document.documentElement.dataset.theme === 'light' ? 'vs' : 'vs-dark',
  );
  changeRef.current = onChange;
  valueRef.current = value;

  useLayoutEffect(() => {
    if (!containerRef.current) return;
    let editor: monaco.editor.IStandaloneCodeEditor;
    try {
      editor = monaco.editor.create(containerRef.current, {
        value: valueRef.current,
        language: language === 'c' ? 'cpp' : 'json',
        theme,
        fontSize: 12,
        fontFamily: "'SFMono-Regular', Consolas, monospace",
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        padding: { top: 14, bottom: 14 },
        lineNumbersMinChars: 3,
        folding: true,
        wordWrap: 'on',
        renderLineHighlight: 'gutter',
        smoothScrolling: true,
        overviewRulerBorder: false,
        fixedOverflowWidgets: true,
        scrollbar: { verticalScrollbarSize: 7, horizontalScrollbarSize: 7 },
      });
    } catch {
      setFallback(true);
      return;
    }
    editorRef.current = editor;
    const subscription = editor.onDidChangeModelContent(() => {
      if (!syncing.current) changeRef.current(editor.getValue());
    });
    return () => {
      subscription.dispose();
      const model = editor.getModel();
      editor.dispose();
      model?.dispose();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || editor.getValue() === value) return;
    syncing.current = true;
    editor.setValue(value);
    syncing.current = false;
  }, [value]);
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model) monaco.editor.setModelLanguage(model, language === 'c' ? 'cpp' : 'json');
  }, [language]);
  useEffect(() => {
    monaco.editor.setTheme(theme);
  }, [theme]);
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setTheme(document.documentElement.dataset.theme === 'light' ? 'vs' : 'vs-dark'),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  return (
    <div className="qg-code-editor" style={{ height }}>
      {fallback ? (
        <textarea
          className="qg-code-fallback"
          aria-label="Code editor"
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      )}
    </div>
  );
}

export default CodeEditor;
