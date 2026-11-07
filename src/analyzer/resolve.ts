import ts from 'typescript';

/**
 * Module resolution backed by ts.resolveModuleName, so tsconfig `paths`,
 * `baseUrl`, extension and index resolution all come from TypeScript itself
 * rather than a hand-rolled resolver that would drift from bundler behaviour.
 */
export class Resolver {
  private readonly root: string;
  private readonly options: ts.CompilerOptions;
  private readonly host: ts.ModuleResolutionHost;
  private readonly cache: ts.ModuleResolutionCache;
  private readonly fileExists = new Map<string, boolean>();
  private readonly fileText = new Map<string, string | undefined>();
  /** `${containingFile}\0${specifier}` -> resolved absolute path or null. */
  private readonly memo = new Map<string, string | null>();

  constructor(root: string, options: ts.CompilerOptions) {
    this.root = root;
    this.options = options;
    this.host = {
      fileExists: (f) => {
        let v = this.fileExists.get(f);
        if (v === undefined) {
          v = ts.sys.fileExists(f);
          this.fileExists.set(f, v);
        }
        return v;
      },
      readFile: (f) => {
        if (this.fileText.has(f)) return this.fileText.get(f);
        const v = ts.sys.readFile(f);
        this.fileText.set(f, v);
        return v;
      },
      directoryExists: ts.sys.directoryExists,
      realpath: ts.sys.realpath,
      getCurrentDirectory: () => this.root,
      getDirectories: ts.sys.getDirectories,
    };
    this.cache = ts.createModuleResolutionCache(root, (s) => s, options);
  }

  /** True for bare package specifiers (`react`, `@scope/pkg`) and node builtins. */
  static isExternal(specifier: string): boolean {
    return !specifier.startsWith('.') && !specifier.startsWith('/');
  }

  /**
   * Stylesheets, images, fonts, media and data files. These are handled by
   * bundler loaders, not module resolution, so they are neither graph nodes
   * nor resolution failures - counting them as failures overstates the error
   * rate (`import './globals.css'` is not a broken import).
   */
  static isAsset(specifier: string): boolean {
    return /\.(css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|ogg|mp3|wav|wasm|json|ya?ml|txt|graphql|gql)(\?.*)?$/i
      .test(specifier);
  }

  /**
   * Resolve a specifier from a containing file.
   * Returns an absolute path, or null when resolution fails or lands in
   * node_modules (external dependencies are not graph nodes).
   */
  resolve(specifier: string, containingFile: string): string | null {
    const key = `${containingFile}\0${specifier}`;
    const hit = this.memo.get(key);
    if (hit !== undefined) return hit;

    let out: string | null = null;
    try {
      const r = ts.resolveModuleName(specifier, containingFile, this.options, this.host, this.cache);
      const f = r.resolvedModule?.resolvedFileName;
      if (f && !f.includes('/node_modules/') && !f.includes('\\node_modules\\')) {
        out = f;
      }
    } catch {
      out = null; // a malformed specifier must not abort the scan
    }

    this.memo.set(key, out);
    return out;
  }
}
