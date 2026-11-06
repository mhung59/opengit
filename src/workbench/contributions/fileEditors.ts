/** File editor resolution and acquisition rollback. */
import type { EditorInput } from "../contributions";

// ---------------------------------------------------------------------------
// File editors: `openFile` asks providers whether a path opens in another
// editor kind (images, hex view) before the text editor. A provider may probe
// the file (size, binary content); the first non-null answer wins.

/** Resources acquired while resolving belong to the request until its tab is admitted. */
export interface FileEditorResolutionContext {
  /** Commit is synchronous: no close/project transition may interleave with tab insertion. */
  onAdmission(commit: () => void, rollback: () => Promise<void>): void;
}

export interface FileEditorResolution {
  input: EditorInput;
  admit(): void;
  rollback(): Promise<void>;
}

export interface FileEditorProvider {
  id: string;
  /** Lower asks first. Default 100. */
  order?: number;
  resolve(path: string, context: FileEditorResolutionContext): EditorInput | null | Promise<EditorInput | null>;
}

const fileEditorProviders = new Map<string, FileEditorProvider>();

export function registerFileEditorProvider(p: FileEditorProvider): () => void {
  fileEditorProviders.set(p.id, p);
  return () => {
    if (fileEditorProviders.get(p.id) === p) fileEditorProviders.delete(p.id);
  };
}

/** The non-text editor input for `path`, or null for the text editor. Provider failures fall through. */
export async function resolveFileEditor(path: string): Promise<FileEditorResolution | null> {
  const providers = [...fileEditorProviders.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  for (const p of providers) {
    const acquisitions: Array<{ commit: () => void; rollback: () => Promise<void> }> = [];
    let admitted = false;
    const rollback = async () => {
      if (admitted) return;
      const results = await Promise.allSettled(acquisitions.splice(0).map((a) => Promise.resolve().then(a.rollback)));
      const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (errors.length)
        throw new AggregateError(
          errors.map((r) => r.reason),
          "File editor acquisition cleanup failed",
        );
    };
    try {
      const input = await p.resolve(path, {
        onAdmission: (commit, release) => acquisitions.push({ commit, rollback: release }),
      });
      if (input)
        return {
          input,
          admit: () => {
            for (const acquisition of acquisitions) acquisition.commit();
            admitted = true;
            acquisitions.length = 0;
          },
          rollback,
        };
    } catch (e) {
      console.warn(`file editor provider ${p.id} failed`, e);
    }
    await rollback();
  }
  return null;
}
