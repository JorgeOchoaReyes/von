/**
 * The file surface an agent session edits.
 *
 * Backed by a git checkout of the app's generated repo in production; by an
 * in-memory map in tests. Every mutation is recorded so the release classifier
 * can be handed an exact change set at the end of the turn rather than having
 * to diff a working tree.
 */
export interface Workspace {
  list(prefix?: string): Promise<string[]>;
  read(path: string): Promise<string | null>;
  write(path: string, contents: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Paths touched since the workspace was opened. */
  changedFiles(): string[];
}

export class InMemoryWorkspace implements Workspace {
  private readonly files: Map<string, string>;
  private readonly touched = new Set<string>();

  constructor(seed: Record<string, string> = {}) {
    this.files = new Map(Object.entries(seed));
  }

  async list(prefix = ""): Promise<string[]> {
    return [...this.files.keys()].filter((p) => p.startsWith(prefix)).sort();
  }

  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async write(path: string, contents: string): Promise<void> {
    this.files.set(path, contents);
    this.touched.add(path);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.touched.add(path);
  }

  changedFiles(): string[] {
    return [...this.touched].sort();
  }
}

/**
 * Paths an agent may not write, given the app's backend tier.
 *
 * On a pooled app the Firestore rules and the Cloud Functions are *shared with
 * every other pooled app* — they live in the pool project, not in this app's
 * repo. An agent editing them would not be changing one app's backend; it would
 * be changing everyone's, and a bad rule is a cross-tenant data leak rather
 * than a bug in one app.
 *
 * So on pooled apps these are read-only, and a request that genuinely needs
 * custom server code or custom rules is a signal to promote the app to its own
 * project — where the same files become fully editable.
 */
export function protectedPaths(backendTier: "pooled" | "dedicated"): string[] {
  if (backendTier === "dedicated") return [];
  return ["firestore.rules", "firestore.indexes.json", "firebase.json", "functions/"];
}

export function isProtected(path: string, protectedList: string[]): boolean {
  return protectedList.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));
}

/**
 * Dependency names added/removed between two package.json revisions.
 * Feeds the release classifier, which treats an unrecognised new dependency as
 * native-affecting.
 */
export function diffDependencies(
  before: string | null,
  after: string | null,
): { added: string[]; removed: string[] } {
  const parse = (raw: string | null): Set<string> => {
    if (!raw) return new Set();
    try {
      const pkg = JSON.parse(raw) as {
        dependencies?: Record<string, string>;
      };
      return new Set(Object.keys(pkg.dependencies ?? {}));
    } catch {
      return new Set();
    }
  };

  const a = parse(before);
  const b = parse(after);
  return {
    added: [...b].filter((d) => !a.has(d)),
    removed: [...a].filter((d) => !b.has(d)),
  };
}
